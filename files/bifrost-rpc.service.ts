import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { BIFROST_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class BifrostRpcService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BifrostRpcService.name);
  private api: ApiPromise;
  private currentEndpointIndex = 0;

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    if (this.api?.isConnected) {
      await this.api.disconnect();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Connection với auto-failover qua multiple endpoints
  // ─────────────────────────────────────────────────────────────
  async connect(retries = 0): Promise<void> {
    const endpoint = BIFROST_CONFIG.RPC_ENDPOINTS[this.currentEndpointIndex];
    this.logger.log(`Connecting to Bifrost RPC: ${endpoint}`);

    try {
      const provider = new WsProvider(endpoint, 5000); // 5s reconnect interval

      provider.on('disconnected', () => {
        this.logger.warn(`Disconnected from ${endpoint}, switching endpoint...`);
        this.failover();
      });

      provider.on('error', (err) => {
        this.logger.error(`WS Error on ${endpoint}:`, err.message);
      });

      this.api = await ApiPromise.create({ provider });
      await this.api.isReady;

      const chain = await this.api.rpc.system.chain();
      const version = await this.api.rpc.system.version();
      this.logger.log(`✅ Connected to ${chain} | Version: ${version}`);
    } catch (err) {
      this.logger.error(`Failed to connect to ${endpoint}: ${err.message}`);
      if (retries < BIFROST_CONFIG.RPC_ENDPOINTS.length) {
        this.failover();
        await this.connect(retries + 1);
      } else {
        throw new Error('All RPC endpoints failed');
      }
    }
  }

  private failover() {
    this.currentEndpointIndex =
      (this.currentEndpointIndex + 1) % BIFROST_CONFIG.RPC_ENDPOINTS.length;
  }

  getApi(): ApiPromise {
    if (!this.api?.isConnected) {
      throw new Error('Bifrost API not connected');
    }
    return this.api;
  }

  // ─────────────────────────────────────────────────────────────
  // Query storage tại một block hash cụ thể (cho historical data)
  // Đây là cách duy nhất để lấy historical state từ archive node
  // ─────────────────────────────────────────────────────────────
  async getBlockHash(blockNumber: number): Promise<string> {
    const api = this.getApi();
    const hash = await api.rpc.chain.getBlockHash(blockNumber);
    return hash.toString();
  }

  // ─────────────────────────────────────────────────────────────
  // Lấy vToken exchange rate tại một block cụ thể
  // Storage path: vtokenMinting.tokenPool(currencyId) và tokens.totalIssuance(vCurrencyId)
  //
  // Exchange Rate = tokenPool (staked DOT) / totalIssuance (vDOT)
  // ─────────────────────────────────────────────────────────────
  async getVTokenExchangeRate(
    vTokenConfig: { currencyId: any; baseCurrencyId: any; decimals: number },
    blockHash: string,
  ): Promise<{ exchangeRate: string; totalStaked: string; totalIssuance: string }> {
    const api = this.getApi();

    // Dùng api.at() để query state tại block hash cụ thể (archive node feature)
    const apiAt = await api.at(blockHash);

    // 1. Lấy tổng token gốc đang staked trong SLP (DOT trong trường hợp vDOT)
    // Storage: vtokenMinting.tokenPool(currencyId) -> Balance
    let totalStaked = '0';
    try {
      const tokenPool = await (apiAt.query as any).vtokenMinting.tokenPool(
        vTokenConfig.baseCurrencyId,
      );
      totalStaked = tokenPool.toString();
    } catch (e) {
      this.logger.warn(`vtokenMinting.tokenPool query failed: ${e.message}`);
    }

    // 2. Lấy tổng vToken đang lưu hành
    // Storage: tokens.totalIssuance(vCurrencyId) -> Balance
    let totalIssuance = '0';
    try {
      const issuance = await (apiAt.query as any).tokens.totalIssuance(
        vTokenConfig.currencyId,
      );
      totalIssuance = issuance.toString();
    } catch (e) {
      this.logger.warn(`tokens.totalIssuance query failed: ${e.message}`);
    }

    // 3. Tính exchange rate
    // Rate = totalStaked / totalIssuance
    let exchangeRate = '0';
    if (BigInt(totalStaked) > 0n && BigInt(totalIssuance) > 0n) {
      // Multiply by 10^decimals để giữ precision
      const PRECISION = BigInt(10 ** vTokenConfig.decimals);
      const rate = (BigInt(totalStaked) * PRECISION) / BigInt(totalIssuance);
      exchangeRate = rate.toString();
    }

    return { exchangeRate, totalStaked, totalIssuance };
  }

  // ─────────────────────────────────────────────────────────────
  // Lấy Farming pool info tại một block
  // Storage: farming.poolInfos(poolId) -> PoolInfo
  // ─────────────────────────────────────────────────────────────
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

      // Extract reward info từ pool
      const rewardPerBlock =
        data.rewardInfos?.[0]?.rewardPerBlock?.toString() || '0';
      const rewardToken = Object.keys(data.rewardInfos?.[0]?.rewardCurrencyId || {})[0] || 'BNC';

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

  // ─────────────────────────────────────────────────────────────
  // Lấy block timestamp từ block header
  // ─────────────────────────────────────────────────────────────
  async getBlockTimestamp(blockHash: string): Promise<Date> {
    const api = this.getApi();
    const apiAt = await api.at(blockHash);
    const timestamp = await (apiAt.query as any).timestamp.now();
    return new Date(timestamp.toNumber());
  }

  // ─────────────────────────────────────────────────────────────
  // Lấy block số hiện tại (để biết cần crawl đến đâu)
  // ─────────────────────────────────────────────────────────────
  async getCurrentBlockNumber(): Promise<number> {
    const api = this.getApi();
    const header = await api.rpc.chain.getHeader();
    return header.number.toNumber();
  }

  // ─────────────────────────────────────────────────────────────
  // Utility: sleep + retry wrapper
  // ─────────────────────────────────────────────────────────────
  async withRetry<T>(
    fn: () => Promise<T>,
    retries = BIFROST_CONFIG.MAX_RETRIES,
  ): Promise<T> {
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i === retries) throw err;
        const delay = 1000 * (i + 1); // exponential backoff
        this.logger.warn(`Retry ${i + 1}/${retries} after ${delay}ms: ${err.message}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
