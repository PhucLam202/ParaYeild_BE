import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PoolsClientService, PoolSnapshot, PoolsQueryParams } from '../../common/services/pools-client.service';

export type { PoolSnapshot as PoolData };
export type { PoolsQueryParams };

export interface SimulationAllocation {
    protocol: string;
    assetSymbol: string;
    percentage: number;
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

    constructor(private readonly poolsClient: PoolsClientService) { }

    // ─── Proxy: lấy danh sách pools từ server ngoài ───
    async fetchPools(params: PoolsQueryParams) {
        return this.poolsClient.fetchPools(params);
    }

    // ─── Quick simulation (static APY – fast preview) ───
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

            // Use totalApy if available, else supplyApy + rewardApy
            const effectiveApy =
                (pool as any).totalApy !== undefined
                    ? (pool as any).totalApy
                    : ((pool as any).supplyApy ?? 0) + ((pool as any).rewardApy ?? 0);

            const apyDecimal = effectiveApy / 100;
            const finalUsd = allocatedUsd * Math.pow(1 + apyDecimal / 365, durationDays);
            const returnUsd = finalUsd - allocatedUsd;
            const returnPercent = (returnUsd / allocatedUsd) * 100;
            const annualizedApy = (Math.pow(finalUsd / allocatedUsd, 365 / durationDays) - 1) * 100;

            breakdown.push({
                protocol: pool.protocol,
                network: pool.network,
                poolType: pool.poolType,
                assetSymbol: pool.assetSymbol,
                allocationPercent: alloc.percentage,
                allocatedUsd: parseFloat(allocatedUsd.toFixed(4)),
                apyUsed: effectiveApy,
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
