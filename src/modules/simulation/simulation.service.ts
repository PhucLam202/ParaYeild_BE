import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ─── External pool shape (from the data server) ───
export interface PoolData {
    protocol: string;
    network: string;
    poolType: string;
    assetSymbol: string;
    totalApy: number;
    tvlUsd: number;
    metadata?: {
        assetName?: string;
        priceUsd?: number;
        volume24hUsd?: number;
        feeAndFarmApr?: number;
        supplyApy?: number;
        rewardApy?: number;
        poolCategory?: string;
        sourceUrl?: string;
    };
    dataTimestamp?: string;
    crawledAt?: string;
}

export interface PoolsQueryParams {
    protocol?: string;
    asset?: string;
    poolType?: string;
    network?: string;
    minApy?: number;
    limit?: number;
    sortBy?: string;
    from?: string;
    to?: string;
}

export interface SimulationAllocation {
    protocol: string;
    assetSymbol: string;
    percentage: number; // must sum to 100
}

export interface RunSimulationDto {
    initialAmountUsd: number;
    from: string;
    to: string;
    allocations: SimulationAllocation[];
}

@Injectable()
export class SimulationService {
    private readonly logger = new Logger(SimulationService.name);
    private readonly poolsApiUrl: string;

    constructor(private readonly configService: ConfigService) {
        this.poolsApiUrl = this.configService.get<string>('poolsApiUrl');
        this.logger.log(`Pools API URL: ${this.poolsApiUrl}`);
    }

    // ─── Proxy: lấy danh sách pools từ server ngoài ───
    async fetchPools(params: PoolsQueryParams): Promise<{ count: number; filter: any; data: PoolData[] }> {
        const query = new URLSearchParams();
        if (params.protocol) query.set('protocol', params.protocol);
        if (params.asset) query.set('asset', params.asset);
        if (params.poolType) query.set('poolType', params.poolType);
        if (params.network) query.set('network', params.network);
        const minApyNum = Number(params.minApy);
        if (!isNaN(minApyNum) && params.minApy !== undefined && params.minApy !== null)
            query.set('minApy', String(minApyNum));
        const limitNum = Number(params.limit);
        if (!isNaN(limitNum) && params.limit !== undefined && params.limit !== null)
            query.set('limit', String(limitNum));
        if (params.sortBy) query.set('sortBy', params.sortBy);
        if (params.from) query.set('from', params.from);
        if (params.to) query.set('to', params.to);

        const url = `${this.poolsApiUrl}/pools?${query.toString()}`;
        this.logger.debug(`Fetching pools: ${url}`);

        try {
            const resp = await axios.get(url, { timeout: 10000 });
            return resp.data;
        } catch (err) {
            this.logger.error(`Failed to fetch pools from ${url}: ${err.message}`);
            throw new BadRequestException(`Cannot reach pools data server: ${err.message}`);
        }
    }

    // ─── Chạy simulation ───
    async runSimulation(dto: RunSimulationDto) {
        const { initialAmountUsd, from, to, allocations } = dto;

        // Validate allocations sum to 100%
        const totalPct = allocations.reduce((s, a) => s + a.percentage, 0);
        if (Math.abs(totalPct - 100) > 0.01) {
            throw new BadRequestException(`Allocations must sum to 100%. Got ${totalPct.toFixed(2)}%`);
        }

        const fromDate = new Date(from);
        const toDate = new Date(to);
        const durationDays = Math.max(1, (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24));

        if (fromDate >= toDate) {
            throw new BadRequestException(`"from" must be before "to"`);
        }

        // Fetch all relevant pools in one call
        const poolsResponse = await this.fetchPools({ from, to, limit: 200 });
        const allPools = poolsResponse.data || [];

        const breakdown = [];
        let totalFinalUsd = 0;

        for (const alloc of allocations) {
            const allocatedUsd = initialAmountUsd * (alloc.percentage / 100);

            // Find matching pool
            const pool = allPools.find(
                (p) =>
                    p.protocol.toLowerCase() === alloc.protocol.toLowerCase() &&
                    p.assetSymbol.toLowerCase() === alloc.assetSymbol.toLowerCase(),
            );

            if (!pool) {
                // Pool not found — return allocated with 0 return
                breakdown.push({
                    protocol: alloc.protocol,
                    assetSymbol: alloc.assetSymbol,
                    allocationPercent: alloc.percentage,
                    allocatedUsd: parseFloat(allocatedUsd.toFixed(2)),
                    apyUsed: null,
                    finalUsd: parseFloat(allocatedUsd.toFixed(2)),
                    returnUsd: 0,
                    returnPercent: 0,
                    warning: `Pool not found in data server for period ${from} → ${to}`,
                });
                totalFinalUsd += allocatedUsd;
                continue;
            }

            const apyDecimal = pool.totalApy / 100;

            // Compound daily: finalAmount = allocated × (1 + APY/365)^days
            const finalUsd = allocatedUsd * Math.pow(1 + apyDecimal / 365, durationDays);
            const returnUsd = finalUsd - allocatedUsd;
            const returnPercent = (returnUsd / allocatedUsd) * 100;

            // Annualized from actual return
            const annualizedApy = (Math.pow(finalUsd / allocatedUsd, 365 / durationDays) - 1) * 100;

            breakdown.push({
                protocol: pool.protocol,
                network: pool.network,
                poolType: pool.poolType,
                assetSymbol: pool.assetSymbol,
                allocationPercent: alloc.percentage,
                allocatedUsd: parseFloat(allocatedUsd.toFixed(4)),
                apyUsed: pool.totalApy,
                tvlUsd: pool.tvlUsd,
                finalUsd: parseFloat(finalUsd.toFixed(4)),
                returnUsd: parseFloat(returnUsd.toFixed(4)),
                returnPercent: parseFloat(returnPercent.toFixed(4)),
                annualizedApyPercent: parseFloat(annualizedApy.toFixed(4)),
            });

            totalFinalUsd += finalUsd;
        }

        const totalReturnUsd = totalFinalUsd - initialAmountUsd;
        const totalReturnPercent = (totalReturnUsd / initialAmountUsd) * 100;
        const overallAnnualizedApy = (Math.pow(totalFinalUsd / initialAmountUsd, 365 / durationDays) - 1) * 100;

        // Weighted average APY
        const weightedApy = breakdown.reduce((sum, b) => {
            return sum + (b.apyUsed ?? 0) * (b.allocationPercent / 100);
        }, 0);

        return {
            summary: {
                initialAmountUsd,
                finalAmountUsd: parseFloat(totalFinalUsd.toFixed(4)),
                totalReturnUsd: parseFloat(totalReturnUsd.toFixed(4)),
                totalReturnPercent: parseFloat(totalReturnPercent.toFixed(4)),
                annualizedApyPercent: parseFloat(overallAnnualizedApy.toFixed(4)),
                weightedAvgApyPercent: parseFloat(weightedApy.toFixed(4)),
                durationDays: parseFloat(durationDays.toFixed(1)),
                from: fromDate.toISOString(),
                to: toDate.toISOString(),
            },
            breakdown,
        };
    }
}
