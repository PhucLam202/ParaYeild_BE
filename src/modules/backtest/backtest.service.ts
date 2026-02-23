import {
    Injectable,
    Logger,
    BadRequestException,
} from '@nestjs/common';
import { PoolsClientService, PoolHistoryRecord } from '../../common/services/pools-client.service';

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface BacktestAllocation {
    protocol: string;
    assetSymbol: string;
    percentage: number;
    poolType?: string; // 'dex' triggers IL calculation
}

export interface RunBacktestDto {
    initialAmountUsd: number;
    from: string;
    to: string;
    allocations: BacktestAllocation[];
    rebalanceIntervalDays?: number; // 0 = no rebalance
    compoundFrequency?: 'daily' | 'weekly' | 'monthly';
    includeIL?: boolean;
    xcmFeeUsd?: number; // fee per rebalance event
}

// ─── Internal types ──────────────────────────────────────────────────────────

interface DailyApyMap {
    // key: "YYYY-MM-DD", value: APY%
    [date: string]: number;
}

interface AllocState {
    protocol: string;
    assetSymbol: string;
    poolType: string;
    percentage: number;
    valueUsd: number;
    apyHistory: DailyApyMap;
    firstPrice?: number; // for IL calculation (price on day 0)
    apySamples: number[]; // all daily APYs seen
    ilLossUsd: number;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class BacktestService {
    private readonly logger = new Logger(BacktestService.name);
    private readonly RISK_FREE_RATE = 0.05; // 5% annualized

    constructor(private readonly poolsClient: PoolsClientService) { }

    // ─── Proxy /pools/history endpoint ───
    async fetchApyHistory(params: {
        protocol?: string;
        asset?: string;
        poolType?: string;
        from?: string;
        to?: string;
    }) {
        return this.poolsClient.fetchPoolHistory(params);
    }

    // ─── Main backtest runner ─────────────────────────────────────────────────
    async runBacktest(dto: RunBacktestDto) {
        const {
            initialAmountUsd,
            from,
            to,
            allocations,
            rebalanceIntervalDays = 0,
            includeIL = false,
            xcmFeeUsd = 0.5,
        } = dto;

        // ── Validation ──
        if (allocations.reduce((s, a) => s + a.percentage, 0) > 100.01 ||
            allocations.reduce((s, a) => s + a.percentage, 0) < 99.99) {
            const total = allocations.reduce((s, a) => s + a.percentage, 0);
            if (Math.abs(total - 100) > 0.01) {
                throw new BadRequestException(
                    `Allocations must sum to 100%. Got ${total.toFixed(2)}%`,
                );
            }
        }

        const fromDate = new Date(from);
        const toDate = new Date(to);
        if (fromDate >= toDate) {
            throw new BadRequestException(`"from" must be before "to"`);
        }

        // ── Build list of calendar days ──
        const days = this.buildDayList(fromDate, toDate);
        const durationDays = days.length - 1;

        // ── Fetch historical APY — group by protocol to minimize requests ──
        // External server may not filter by asset client-side, so we fetch
        // all records per protocol and filter by assetSymbol ourselves.
        const protocolsNeeded = [...new Set(allocations.map((a) => a.protocol))];
        const protocolHistoryCache: Record<string, PoolHistoryRecord[]> = {};

        await Promise.all(
            protocolsNeeded.map(async (proto) => {
                try {
                    const resp = await this.poolsClient.fetchPoolHistory({
                        protocol: proto,
                        from,
                        to,
                    });
                    protocolHistoryCache[proto] = resp.data ?? [];
                    this.logger.debug(
                        `[${proto}] fetched ${protocolHistoryCache[proto].length} total history records`,
                    );
                } catch (err) {
                    this.logger.warn(
                        `[${proto}] history fetch failed: ${err.message}. Using 0% APY.`,
                    );
                    protocolHistoryCache[proto] = [];
                }
            }),
        );

        const allocStates: AllocState[] = allocations.map((alloc) => {
            const rawRecords = (protocolHistoryCache[alloc.protocol] ?? []).filter(
                (r) => r.assetSymbol.toLowerCase() === alloc.assetSymbol.toLowerCase(),
            );
            const apyHistory = this.buildApyMap(rawRecords);
            this.logger.debug(
                `[${alloc.protocol}/${alloc.assetSymbol}] matched ${rawRecords.length} records, ${Object.keys(apyHistory).length} unique days`,
            );
            return {
                protocol: alloc.protocol,
                assetSymbol: alloc.assetSymbol,
                poolType: alloc.poolType ?? 'unknown',
                percentage: alloc.percentage,
                valueUsd: initialAmountUsd * (alloc.percentage / 100),
                apyHistory,
                firstPrice: undefined,
                apySamples: [],
                ilLossUsd: 0,
            };
        });

        // ── Day-by-day simulation ──────────────────────────────────────────────
        const timeSeries: { date: string; totalValueUsd: number; dailyReturnPct: number }[] = [];
        let peakValue = initialAmountUsd;
        let maxDrawdown = 0;
        let xcmFeesPaidUsd = 0;
        let rebalanceCount = 0;
        let prevTotalValue = initialAmountUsd;

        for (let i = 0; i < days.length; i++) {
            const dateStr = days[i]; // "YYYY-MM-DD"

            // ── Apply daily APY growth ──
            for (const state of allocStates) {
                const apy = this.getApyForDay(state.apyHistory, dateStr, days);
                state.apySamples.push(apy);

                if (i > 0) {
                    // Compound daily: value *= (1 + APY%/365/100)
                    const dailyRate = apy / 100 / 365;
                    state.valueUsd *= (1 + dailyRate);
                }
            }

            // ── Rebalancing ──
            const isRebalanceDay =
                rebalanceIntervalDays > 0 &&
                i > 0 &&
                i % rebalanceIntervalDays === 0;

            if (isRebalanceDay) {
                const totalBefore = allocStates.reduce((s, a) => s + a.valueUsd, 0);
                // Deduct XCM fees (once per rebalance event, not per allocation)
                const crossChainCount = this.countCrossChainHops(allocStates);
                const feesThisRebalance = xcmFeeUsd * crossChainCount;
                xcmFeesPaidUsd += feesThisRebalance;
                rebalanceCount++;

                const totalAfterFees = totalBefore - feesThisRebalance;

                // Re-distribute according to original percentages
                for (const state of allocStates) {
                    state.valueUsd = totalAfterFees * (state.percentage / 100);
                }

                this.logger.debug(
                    `Rebalance on ${dateStr}: total=${totalBefore.toFixed(2)}, fees=${feesThisRebalance.toFixed(2)}`,
                );
            }

            // ── Snapshot portfolio value ──
            const totalValue = allocStates.reduce((s, a) => s + a.valueUsd, 0);
            const dailyReturnPct = i === 0 ? 0 : ((totalValue - prevTotalValue) / prevTotalValue) * 100;
            prevTotalValue = totalValue;

            timeSeries.push({
                date: dateStr,
                totalValueUsd: parseFloat(totalValue.toFixed(4)),
                dailyReturnPct: parseFloat(dailyReturnPct.toFixed(4)),
            });

            // Track max drawdown
            if (totalValue > peakValue) peakValue = totalValue;
            const drawdown = ((peakValue - totalValue) / peakValue) * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        // ── Impermanent Loss (applied at end for DEX pools) ──
        if (includeIL) {
            for (const state of allocStates) {
                if (state.poolType === 'dex' || state.poolType === 'farming') {
                    // Conservative IL estimate: assume 10% price drift for the period
                    // In production, this would use TokenPrice entity for the specific asset
                    const estimatedPriceRatio = this.estimatePriceRatio(
                        state.apySamples.length,
                        state.apySamples,
                    );
                    const il = this.calculateIL(estimatedPriceRatio);
                    const ilLoss = state.valueUsd * Math.abs(il);
                    state.ilLossUsd = parseFloat(ilLoss.toFixed(4));
                    state.valueUsd -= ilLoss;
                    this.logger.debug(
                        `[${state.assetSymbol}] IL: priceRatio=${estimatedPriceRatio.toFixed(3)}, loss=$${ilLoss.toFixed(2)}`,
                    );
                }
            }
        }

        // ── Final metrics ──────────────────────────────────────────────────────
        const finalTotalUsd = allocStates.reduce((s, a) => s + a.valueUsd, 0);
        const totalReturnUsd = finalTotalUsd - initialAmountUsd;
        const totalReturnPct = (totalReturnUsd / initialAmountUsd) * 100;
        const annualizedApy =
            durationDays > 0
                ? (Math.pow(finalTotalUsd / initialAmountUsd, 365 / durationDays) - 1) * 100
                : 0;

        // Sharpe Ratio (annualized)
        const dailyReturns = timeSeries.slice(1).map((t) => t.dailyReturnPct / 100);
        const sharpeRatio = this.calcSharpe(dailyReturns);

        // ── Build breakdown ────────────────────────────────────────────────────
        const breakdown = allocStates.map((state) => {
            const allocatedUsd = initialAmountUsd * (state.percentage / 100);
            const returnUsd = state.valueUsd - allocatedUsd;
            const returnPct = (returnUsd / allocatedUsd) * 100;
            const avgApy =
                state.apySamples.length > 0
                    ? state.apySamples.reduce((s, v) => s + v, 0) / state.apySamples.length
                    : 0;
            const minApy = state.apySamples.length > 0 ? Math.min(...state.apySamples) : 0;
            const maxApy = state.apySamples.length > 0 ? Math.max(...state.apySamples) : 0;

            return {
                protocol: state.protocol,
                assetSymbol: state.assetSymbol,
                poolType: state.poolType,
                allocationPercent: state.percentage,
                allocatedUsd: parseFloat(allocatedUsd.toFixed(4)),
                avgApyPercent: parseFloat(avgApy.toFixed(4)),
                minApyPercent: parseFloat(minApy.toFixed(4)),
                maxApyPercent: parseFloat(maxApy.toFixed(4)),
                ilLossUsd: state.ilLossUsd,
                finalUsd: parseFloat(state.valueUsd.toFixed(4)),
                returnUsd: parseFloat(returnUsd.toFixed(4)),
                returnPercent: parseFloat(returnPct.toFixed(4)),
                dataPointsUsed: state.apySamples.length,
                hasHistoricalData: Object.keys(state.apyHistory).length > 0,
            };
        });

        return {
            summary: {
                initialAmountUsd,
                finalAmountUsd: parseFloat(finalTotalUsd.toFixed(4)),
                totalReturnUsd: parseFloat(totalReturnUsd.toFixed(4)),
                totalReturnPercent: parseFloat(totalReturnPct.toFixed(4)),
                annualizedApyPercent: parseFloat(annualizedApy.toFixed(4)),
                maxDrawdownPercent: parseFloat((-maxDrawdown).toFixed(4)),
                sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
                durationDays,
                from: fromDate.toISOString(),
                to: toDate.toISOString(),
                rebalancedCount: rebalanceCount,
                xcmFeesPaidUsd: parseFloat(xcmFeesPaidUsd.toFixed(4)),
                ilIncluded: includeIL,
            },
            breakdown,
            // Cap timeSeries at 500 points for UI charts
            timeSeries: this.downsampleTimeSeries(timeSeries, 500),
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Convert raw history records into a map: "YYYY-MM-DD" → effectiveApy%
     * Uses `supplyApy + rewardApy` when available; falls back to `totalApy` or `supplyApy`.
     */
    private buildApyMap(records: PoolHistoryRecord[]): DailyApyMap {
        const map: DailyApyMap = {};
        for (const rec of records) {
            const dateKey = rec.dataTimestamp.slice(0, 10); // "YYYY-MM-DD"
            const apy =
                rec.totalApy !== undefined
                    ? rec.totalApy
                    : (rec.supplyApy ?? 0) + (rec.rewardApy ?? 0);
            // If multiple records for same day, keep the most recent (last wins)
            map[dateKey] = apy;
        }
        return map;
    }

    /**
     * Get APY for a given date.
     * Strategy: exact match → nearest past date → nearest future date → 0
     */
    private getApyForDay(
        map: DailyApyMap,
        dateStr: string,
        allDays: string[],
    ): number {
        if (map[dateStr] !== undefined) return map[dateStr];

        const mapKeys = Object.keys(map).sort();
        if (mapKeys.length === 0) return 0;

        // Find nearest past key
        const past = mapKeys.filter((k) => k <= dateStr);
        if (past.length > 0) return map[past[past.length - 1]];

        // Fall back to nearest future key
        return map[mapKeys[0]];
    }

    /** Build array of "YYYY-MM-DD" strings from start to end inclusive */
    private buildDayList(start: Date, end: Date): string[] {
        const days: string[] = [];
        const cursor = new Date(start);
        while (cursor <= end) {
            days.push(cursor.toISOString().slice(0, 10));
            cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
        return days;
    }

    /**
     * Count unique cross-chain hops needed for rebalancing.
     * Each unique network beyond the first requires an XCM transfer.
     */
    private countCrossChainHops(states: AllocState[]): number {
        const networks = new Set(states.map((s) => s.protocol));
        return Math.max(0, networks.size - 1);
    }

    /**
     * Impermanent Loss formula for 2-asset AMM:
     *   IL = 2*sqrt(r) / (1 + r) - 1   where r = price_end / price_start
     */
    private calculateIL(priceRatio: number): number {
        if (priceRatio <= 0) return 0;
        return 2 * Math.sqrt(priceRatio) / (1 + priceRatio) - 1;
    }

    /**
     * Estimate price ratio from APY volatility as a proxy.
     * In production, replace with real TokenPrice entity lookups.
     * Logic: high APY variance → higher implied price movement.
     */
    private estimatePriceRatio(days: number, apySamples: number[]): number {
        if (apySamples.length < 2) return 1.0;
        const mean = apySamples.reduce((s, v) => s + v, 0) / apySamples.length;
        const variance =
            apySamples.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / apySamples.length;
        const stdDev = Math.sqrt(variance);
        // Normalize: assume max 30% price drift for 100% APY std dev
        const drift = Math.min(0.3, (stdDev / 100) * 0.3);
        return 1 + drift;
    }

    /**
     * Annualized Sharpe Ratio
     *   = (mean_daily_return - rf_daily) / std_dev * sqrt(365)
     */
    private calcSharpe(dailyReturns: number[]): number {
        if (dailyReturns.length < 2) return 0;
        const rfDaily = this.RISK_FREE_RATE / 365;
        const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
        const variance =
            dailyReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) /
            (dailyReturns.length - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0) return 0;
        return ((mean - rfDaily) / stdDev) * Math.sqrt(365);
    }

    /**
     * Downsample timeSeries to at most `maxPoints` via uniform sampling.
     */
    private downsampleTimeSeries(
        series: { date: string; totalValueUsd: number; dailyReturnPct: number }[],
        maxPoints: number,
    ) {
        if (series.length <= maxPoints) return series;
        const step = Math.ceil(series.length / maxPoints);
        const result = [];
        for (let i = 0; i < series.length; i += step) {
            result.push(series[i]);
        }
        // Always include last point
        if (result[result.length - 1] !== series[series.length - 1]) {
            result.push(series[series.length - 1]);
        }
        return result;
    }
}
