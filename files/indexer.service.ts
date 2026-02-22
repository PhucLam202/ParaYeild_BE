import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BifrostRpcService } from './bifrost-rpc.service';
import {
  IndexerCheckpoint,
  VTokenExchangeRate,
  FarmingPoolSnapshot,
} from '../../schemas';
import { BIFROST_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
  private isRunning = false;

  // Mapping poolId số → pool info (cần biết trước hoặc crawl từ chain)
  // Có thể lấy danh sách pool bằng cách query farming.poolInfos.keys()
  private readonly KNOWN_FARMING_POOLS = [
    { poolId: 0, token0: 'vDOT', token1: 'DOT', name: 'vDOT-DOT' },
    { poolId: 1, token0: 'vKSM', token1: 'KSM', name: 'vKSM-KSM' },
    { poolId: 2, token0: 'BNC', token1: 'vBNC', name: 'BNC-vBNC' },
    { poolId: 3, token0: 'vGLMR', token1: 'GLMR', name: 'vGLMR-GLMR' },
  ];

  constructor(
    private readonly rpc: BifrostRpcService,
    @InjectModel(IndexerCheckpoint.name)
    private checkpointModel: Model<IndexerCheckpoint>,
    @InjectModel(VTokenExchangeRate.name)
    private vtokenRateModel: Model<VTokenExchangeRate>,
    @InjectModel(FarmingPoolSnapshot.name)
    private farmingModel: Model<FarmingPoolSnapshot>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Cron job: chạy mỗi 10 phút để real-time sync
  // ─────────────────────────────────────────────────────────────
  @Cron('*/10 * * * *')
  async syncRealtimeData() {
    if (this.isRunning) {
      this.logger.warn('Indexer already running, skipping cron tick');
      return;
    }
    await this.runIndexer({ maxBlocks: 1000 }); // chỉ lấy ~1000 blocks mới nhất
  }

  // ─────────────────────────────────────────────────────────────
  // Main indexer loop
  // options.startBlock: override checkpoint (cho backfill)
  // options.maxBlocks: giới hạn số blocks mỗi lần chạy
  // ─────────────────────────────────────────────────────────────
  async runIndexer(options: { startBlock?: number; maxBlocks?: number } = {}) {
    if (this.isRunning) throw new Error('Indexer already running');
    this.isRunning = true;

    try {
      const checkpointKey = 'bifrost-polkadot-vtoken';

      // 1. Lấy checkpoint (block đã index đến đâu rồi)
      let checkpoint = await this.checkpointModel.findOne({ key: checkpointKey });
      if (!checkpoint) {
        checkpoint = await this.checkpointModel.create({
          key: checkpointKey,
          lastIndexedBlock: options.startBlock ?? BIFROST_CONFIG.START_BLOCK,
          status: 'running',
        });
        this.logger.log(`Created new checkpoint, starting from block ${checkpoint.lastIndexedBlock}`);
      }

      const fromBlock = options.startBlock ?? checkpoint.lastIndexedBlock + 1;
      const currentBlock = await this.rpc.getCurrentBlockNumber();
      const toBlock = options.maxBlocks
        ? Math.min(fromBlock + options.maxBlocks - 1, currentBlock)
        : currentBlock;

      this.logger.log(`Indexing blocks ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} blocks)`);

      // 2. Process từng batch blocks
      let processed = 0;
      for (
        let blockNum = fromBlock;
        blockNum <= toBlock;
        blockNum += BIFROST_CONFIG.SNAPSHOT_INTERVAL
      ) {
        // Chỉ snapshot mỗi SNAPSHOT_INTERVAL blocks (hourly)
        const snapshotBlock = Math.min(blockNum, toBlock);

        try {
          await this.rpc.withRetry(() => this.indexBlock(snapshotBlock));
          processed++;

          // Cập nhật checkpoint sau mỗi block thành công
          await this.checkpointModel.updateOne(
            { key: checkpointKey },
            { lastIndexedBlock: snapshotBlock, lastIndexedAt: new Date(), status: 'running' },
          );
        } catch (err) {
          this.logger.error(`Failed to index block ${snapshotBlock}: ${err.message}`);
          // Continue with next batch thay vì crash
        }

        // Delay để tránh rate limit RPC
        if (processed % 10 === 0) {
          await new Promise((r) => setTimeout(r, BIFROST_CONFIG.BATCH_DELAY_MS));
          this.logger.log(`Progress: ${processed} snapshots indexed, current block: ${snapshotBlock}`);
        }
      }

      await this.checkpointModel.updateOne(
        { key: checkpointKey },
        { lastIndexedBlock: toBlock, status: 'running' },
      );

      this.logger.log(`✅ Indexer completed: ${processed} snapshots saved`);
    } finally {
      this.isRunning = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Index một block cụ thể: lấy tất cả data cần thiết
  // ─────────────────────────────────────────────────────────────
  private async indexBlock(blockNumber: number): Promise<void> {
    const blockHash = await this.rpc.getBlockHash(blockNumber);
    const timestamp = await this.rpc.getBlockTimestamp(blockHash);

    // Parallel: index vToken rates + farming pools cùng lúc
    await Promise.all([
      this.indexVTokenRates(blockNumber, blockHash, timestamp),
      this.indexFarmingPools(blockNumber, blockHash, timestamp),
    ]);
  }

  // ─────────────────────────────────────────────────────────────
  // Index vToken exchange rates tại một block
  // ─────────────────────────────────────────────────────────────
  private async indexVTokenRates(
    blockNumber: number,
    blockHash: string,
    timestamp: Date,
  ): Promise<void> {
    const vtokens = Object.values(BIFROST_CONFIG.VTOKENS);

    // Parallel query tất cả vTokens
    const results = await Promise.allSettled(
      vtokens.map(async (vt) => {
        const data = await this.rpc.getVTokenExchangeRate(vt, blockHash);
        return { vt, data };
      }),
    );

    const docs = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(`vToken rate query failed: ${result.reason}`);
        continue;
      }

      const { vt, data } = result.value;
      if (data.totalIssuance === '0') continue; // Skip nếu chưa có issuance

      // Convert exchange rate sang human-readable
      const exchangeRateHuman =
        Number(BigInt(data.exchangeRate)) / 10 ** vt.decimals;

      docs.push({
        tokenSymbol: vt.symbol,
        blockNumber,
        timestamp,
        exchangeRate: data.exchangeRate,
        exchangeRateHuman,
        totalStaked: data.totalStaked,
        totalIssuance: data.totalIssuance,
        chain: BIFROST_CONFIG.CHAIN,
      });
    }

    if (docs.length > 0) {
      // upsert để idempotent (có thể chạy lại không bị duplicate)
      await Promise.all(
        docs.map((doc) =>
          this.vtokenRateModel
            .updateOne(
              { tokenSymbol: doc.tokenSymbol, blockNumber: doc.blockNumber },
              { $set: doc },
              { upsert: true },
            ),
        ),
      );
      this.logger.debug(`Saved ${docs.length} vToken rates at block ${blockNumber}`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Index Farming pool snapshots tại một block
  // ─────────────────────────────────────────────────────────────
  private async indexFarmingPools(
    blockNumber: number,
    blockHash: string,
    timestamp: Date,
  ): Promise<void> {
    const docs = [];

    for (const pool of this.KNOWN_FARMING_POOLS) {
      try {
        const info = await this.rpc.getFarmingPoolInfo(pool.poolId, blockHash);
        if (!info) continue;

        docs.push({
          poolId: pool.name,
          blockNumber,
          timestamp,
          token0: pool.token0,
          token1: pool.token1,
          totalShares: info.totalShares,
          rewardPerBlock: info.rewardPerBlock,
          rewardToken: info.rewardToken,
          chain: BIFROST_CONFIG.CHAIN,
          // tvlUsd và farmingAprPercent sẽ được tính sau bởi APY calculator
          tvlUsd: 0,
          farmingAprPercent: 0,
        });
      } catch (e) {
        this.logger.warn(`Pool ${pool.name} indexing failed: ${e.message}`);
      }
    }

    if (docs.length > 0) {
      await Promise.all(
        docs.map((doc) =>
          this.farmingModel.updateOne(
            { poolId: doc.poolId, blockNumber: doc.blockNumber },
            { $set: doc },
            { upsert: true },
          ),
        ),
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Status API: báo cáo tình trạng indexer
  // ─────────────────────────────────────────────────────────────
  async getIndexerStatus() {
    const checkpoint = await this.checkpointModel.findOne({
      key: 'bifrost-polkadot-vtoken',
    });
    const currentBlock = await this.rpc.getCurrentBlockNumber();
    const totalRates = await this.vtokenRateModel.countDocuments();
    const totalFarming = await this.farmingModel.countDocuments();

    return {
      isRunning: this.isRunning,
      lastIndexedBlock: checkpoint?.lastIndexedBlock ?? 0,
      currentBlock,
      blocksRemaining: currentBlock - (checkpoint?.lastIndexedBlock ?? 0),
      lastIndexedAt: checkpoint?.lastIndexedAt,
      recordsCounts: {
        vtokenRates: totalRates,
        farmingSnapshots: totalFarming,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Backfill trigger: gọi để index từ đầu lịch sử
  // Thường chạy 1 lần lúc setup, sau đó cron job giữ sync
  // ─────────────────────────────────────────────────────────────
  async startBackfill(fromBlock?: number) {
    this.logger.log('Starting historical backfill...');
    // Reset checkpoint để bắt đầu lại
    await this.checkpointModel.updateOne(
      { key: 'bifrost-polkadot-vtoken' },
      {
        $set: {
          lastIndexedBlock: fromBlock ?? BIFROST_CONFIG.START_BLOCK,
          status: 'running',
        },
      },
      { upsert: true },
    );
    // Chạy indexer không giới hạn maxBlocks
    this.runIndexer({ startBlock: fromBlock }).catch((err) => {
      this.logger.error('Backfill error:', err);
    });
    return { message: 'Backfill started', fromBlock: fromBlock ?? BIFROST_CONFIG.START_BLOCK };
  }
}
