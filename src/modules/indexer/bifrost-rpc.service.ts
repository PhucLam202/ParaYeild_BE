import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { BIFROST_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class BifrostRpcService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(BifrostRpcService.name);
    private api: ApiPromise;

    async onModuleInit() {
        this.connect().catch(e => this.logger.error(`Initial connection error: ${e.message}`));
    }

    async onModuleDestroy() {
        if (this.api?.isConnected) {
            await this.api.disconnect();
        }
    }

    // ─── Connection với auto-failover ───
    async connect(retries = 0): Promise<void> {
        this.logger.log(`Connecting to Bifrost RPC with endpoints: ${BIFROST_CONFIG.RPC_ENDPOINTS.join(', ')}`);

        try {
            // Pass the array of endpoints to WsProvider for automatic built-in failover
            const provider = new WsProvider(BIFROST_CONFIG.RPC_ENDPOINTS, 5000);

            provider.on('disconnected', () => {
                this.logger.warn(`Disconnected from current RPC endpoint, trying next...`);
            });

            provider.on('error', (err) => {
                this.logger.error(`WS Error: ${err.message}`);
            });

            this.api = await ApiPromise.create({ provider });
            await this.api.isReady;

            const chain = await this.api.rpc.system.chain();
            const version = await this.api.rpc.system.version();
            this.logger.log(`✅ Connected to ${chain} | Version: ${version}`);
        } catch (err) {
            this.logger.error(`Failed to connect to endpoints: ${err.message}`);
            if (retries < BIFROST_CONFIG.RPC_ENDPOINTS.length) {
                await new Promise((resolve) => setTimeout(resolve, 5000));
                await this.connect(retries + 1);
            } else {
                throw new Error('All RPC endpoints failed');
            }
        }
    }

    getApi(): ApiPromise {
        if (!this.api?.isConnected) {
            throw new Error('Bifrost API not connected');
        }
        return this.api;
    }

    // ─── Query historical block hash ───
    async getBlockHash(blockNumber: number): Promise<string> {
        const api = this.getApi();
        const hash = await api.rpc.chain.getBlockHash(blockNumber);
        return hash.toString();
    }

    // ─── vToken exchange rate tại block hash ───
    async getVTokenExchangeRate(
        vTokenConfig: { currencyId: any; baseCurrencyId: any; decimals: number },
        blockHash: string,
    ): Promise<{ exchangeRate: string; totalStaked: string; totalIssuance: string }> {
        const api = this.getApi();
        const apiAt = await api.at(blockHash);

        let totalStaked = '0';
        try {
            const tokenPool = await (apiAt.query as any).vtokenMinting.tokenPool(
                vTokenConfig.baseCurrencyId,
            );
            totalStaked = tokenPool.toString();
        } catch (e) {
            this.logger.warn(`vtokenMinting.tokenPool query failed: ${e.message}`);
        }

        let totalIssuance = '0';
        try {
            const issuance = await (apiAt.query as any).tokens.totalIssuance(
                vTokenConfig.currencyId,
            );
            totalIssuance = issuance.toString();
        } catch (e) {
            this.logger.warn(`tokens.totalIssuance query failed: ${e.message}`);
        }

        let exchangeRate = '0';
        if (BigInt(totalStaked) > 0n && BigInt(totalIssuance) > 0n) {
            const PRECISION = BigInt(10 ** vTokenConfig.decimals);
            const rate = (BigInt(totalStaked) * PRECISION) / BigInt(totalIssuance);
            exchangeRate = rate.toString();
        }

        return { exchangeRate, totalStaked, totalIssuance };
    }

    // ─── Farming pool info tại block ───
    async getFarmingPoolInfo(
        poolId: number,
        blockHash: string,
    ): Promise<{ totalShares: string; rewardPerBlock: string; rewardToken: string } | null> {
        const api = this.getApi();
        const apiAt = await api.at(blockHash);

        try {
            const poolInfo = await (apiAt.query as any).farming.poolInfos(poolId);
            const data = poolInfo.toJSON() as any;

            if (!data || data.state === 'UnCharged') return null;

            const rewardPerBlock = data.rewardInfos?.[0]?.rewardPerBlock?.toString() || '0';
            const rewardToken =
                Object.keys(data.rewardInfos?.[0]?.rewardCurrencyId || {})[0] || 'BNC';

            return {
                totalShares: data.totalShares?.toString() || '0',
                rewardPerBlock,
                rewardToken,
            };
        } catch (e) {
            this.logger.warn(`farming.poolInfos(${poolId}) failed: ${e.message}`);
            return null;
        }
    }

    // ─── Block timestamp ───
    async getBlockTimestamp(blockHash: string): Promise<Date> {
        const api = this.getApi();
        const apiAt = await api.at(blockHash);
        const timestamp = await (apiAt.query as any).timestamp.now();
        return new Date(timestamp.toNumber());
    }

    // ─── Current block number ───
    async getCurrentBlockNumber(): Promise<number> {
        const api = this.getApi();
        const header = await api.rpc.chain.getHeader();
        return header.number.toNumber();
    }

    // ─── Retry wrapper với exponential backoff ───
    async withRetry<T>(
        fn: () => Promise<T>,
        retries = BIFROST_CONFIG.MAX_RETRIES,
    ): Promise<T> {
        for (let i = 0; i <= retries; i++) {
            try {
                return await fn();
            } catch (err) {
                if (i === retries) throw err;
                const delay = 1000 * (i + 1);
                this.logger.warn(`Retry ${i + 1}/${retries} after ${delay}ms: ${err.message}`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
}
