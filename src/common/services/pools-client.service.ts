import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

// ─── Shape from external server GET /pools ───
export interface PoolSnapshot {
    protocol: string;
    network: string;
    poolType: string;
    assetSymbol: string;
    totalApy?: number;
    supplyApy?: number;
    rewardApy?: number;
    tvlUsd?: number;
    metadata?: Record<string, any>;
    dataTimestamp?: string;
    crawledAt?: string;
}

// ─── Shape from external server GET /pools/history ───
export interface PoolHistoryRecord {
    protocol: string;
    network: string;
    poolType: string;
    assetSymbol: string;
    supplyApy: number;     // primary APY field from history endpoint
    rewardApy?: number;
    totalApy?: number;
    dataTimestamp: string; // ISO string e.g. "2026-02-20T04:04:45.526Z"
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

export interface PoolHistoryQueryParams {
    protocol?: string;
    asset?: string;
    poolType?: string;
    from?: string;
    to?: string;
}

@Injectable()
export class PoolsClientService {
    private readonly logger = new Logger(PoolsClientService.name);
    private readonly baseUrl: string;

    constructor(private readonly configService: ConfigService) {
        this.baseUrl = this.configService.get<string>('poolsApiUrl');
    }

    // ─── GET /pools ───
    async fetchPools(
        params: PoolsQueryParams,
    ): Promise<{ count: number; filter: any; data: PoolSnapshot[] }> {
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

        const url = `${this.baseUrl}/pools?${query.toString()}`;
        this.logger.debug(`fetchPools → ${url}`);

        try {
            const resp = await axios.get(url, { timeout: 10000 });
            return resp.data;
        } catch (err) {
            this.logger.error(`fetchPools failed: ${err.message}`);
            throw new BadRequestException(`Cannot reach pools data server: ${err.message}`);
        }
    }

    // ─── GET /pools/history ───
    async fetchPoolHistory(
        params: PoolHistoryQueryParams,
    ): Promise<{ count: number; data: PoolHistoryRecord[] }> {
        const query = new URLSearchParams();
        if (params.protocol) query.set('protocol', params.protocol);
        if (params.asset) query.set('asset', params.asset);
        if (params.poolType) query.set('poolType', params.poolType);
        if (params.from) query.set('from', params.from);
        if (params.to) query.set('to', params.to);

        const url = `${this.baseUrl}/pools/history?${query.toString()}`;
        this.logger.debug(`fetchPoolHistory → ${url}`);

        try {
            const resp = await axios.get(url, { timeout: 15000 });
            return resp.data;
        } catch (err) {
            this.logger.error(`fetchPoolHistory failed: ${err.message}`);
            throw new BadRequestException(`Cannot reach pools history server: ${err.message}`);
        }
    }
}
