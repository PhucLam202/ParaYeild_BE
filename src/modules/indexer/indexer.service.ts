import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { BifrostRpcService } from './bifrost-rpc.service';
import {
    IndexerCheckpoint,
    VTokenExchangeRate,
    FarmingPoolSnapshot,
} from '../../entities';
import { BIFROST_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class IndexerService {
    private readonly logger = new Logger(IndexerService.name);
    private isRunning = false;

    private readonly KNOWN_FARMING_POOLS = [
        { poolId: 0, token0: 'vDOT', token1: 'DOT', name: 'vDOT-DOT' },
        { poolId: 1, token0: 'vKSM', token1: 'KSM', name: 'vKSM-KSM' },
        { poolId: 2, token0: 'BNC', token1: 'vBNC', name: 'BNC-vBNC' },
        { poolId: 3, token0: 'vGLMR', token1: 'GLMR', name: 'vGLMR-GLMR' },
    ];

    constructor(
        private readonly rpc: BifrostRpcService,
        @InjectRepository(IndexerCheckpoint)
        private checkpointRepo: MongoRepository<IndexerCheckpoint>,
        @InjectRepository(VTokenExchangeRate)
        private vtokenRateRepo: MongoRepository<VTokenExchangeRate>,
        @InjectRepository(FarmingPoolSnapshot)
        private farmingRepo: MongoRepository<FarmingPoolSnapshot>,
    ) { }

    // ─── Cron: sync real-time mỗi 10 phút ───
    @Cron('*/10 * * * *')
    async syncRealtimeData() {
        if (this.isRunning) {
            this.logger.warn('Indexer already running, skipping cron tick');
            return;
        }
        await this.runIndexer({ maxBlocks: 1000 });
    }

    // ─── Main indexer loop ───
    async runIndexer(options: { startBlock?: number; maxBlocks?: number } = {}) {
        if (this.isRunning) throw new Error('Indexer already running');
        this.isRunning = true;

        try {
            const checkpointKey = 'bifrost-polkadot-vtoken';

            let checkpoint = await this.checkpointRepo.findOneBy({ key: checkpointKey });
            if (!checkpoint) {
                // TypeORM: create entity instance then save
                const newCheckpoint = this.checkpointRepo.create({
                    key: checkpointKey,
                    lastIndexedBlock: options.startBlock ?? BIFROST_CONFIG.START_BLOCK,
                    status: 'running',
                });
                checkpoint = await this.checkpointRepo.save(newCheckpoint);
                this.logger.log(`Created new checkpoint at block ${checkpoint.lastIndexedBlock}`);
            }

            const fromBlock = options.startBlock ?? checkpoint.lastIndexedBlock + 1;
            const currentBlock = await this.rpc.getCurrentBlockNumber();
            const toBlock = options.maxBlocks
                ? Math.min(fromBlock + options.maxBlocks - 1, currentBlock)
                : currentBlock;

            this.logger.log(
                `Indexing blocks ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1} blocks)`,
            );

            let processed = 0;
            for (
                let blockNum = fromBlock;
                blockNum <= toBlock;
                blockNum += BIFROST_CONFIG.SNAPSHOT_INTERVAL
            ) {
                const snapshotBlock = Math.min(blockNum, toBlock);

                try {
                    await this.rpc.withRetry(() => this.indexBlock(snapshotBlock));
                    processed++;

                    // TypeORM Mongo native updateOne needs $set
                    await this.checkpointRepo.updateOne(
                        { key: checkpointKey },
                        { $set: { lastIndexedBlock: snapshotBlock, lastIndexedAt: new Date(), status: 'running' } },
                        { upsert: true }
                    );
                } catch (err) {
                    this.logger.error(`Failed to index block ${snapshotBlock}: ${err.message}`);
                }

                if (processed % 10 === 0) {
                    await new Promise((r) => setTimeout(r, BIFROST_CONFIG.BATCH_DELAY_MS));
                    this.logger.log(`Progress: ${processed} snapshots, current: ${snapshotBlock}`);
                }
            }

            await this.checkpointRepo.updateOne(
                { key: checkpointKey },
                { $set: { lastIndexedBlock: toBlock, status: 'running' } },
            );

            this.logger.log(`✅ Indexer completed: ${processed} snapshots saved`);
        } finally {
            this.isRunning = false;
        }
    }

    // ─── Index một block cụ thể ───
    private async indexBlock(blockNumber: number): Promise<void> {
        const blockHash = await this.rpc.getBlockHash(blockNumber);
        const timestamp = await this.rpc.getBlockTimestamp(blockHash);

        await Promise.all([
            this.indexVTokenRates(blockNumber, blockHash, timestamp),
            this.indexFarmingPools(blockNumber, blockHash, timestamp),
        ]);
    }

    // ─── Index vToken exchange rates ───
    private async indexVTokenRates(
        blockNumber: number,
        blockHash: string,
        timestamp: Date,
    ): Promise<void> {
        const vtokens = Object.values(BIFROST_CONFIG.VTOKENS);

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
            if (data.totalIssuance === '0') continue;

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
            await Promise.all(
                docs.map((doc) =>
                    this.vtokenRateRepo.updateOne(
                        { tokenSymbol: doc.tokenSymbol, blockNumber: doc.blockNumber },
                        { $set: Object.assign({}, doc, { createdAt: new Date() }) },
                        { upsert: true },
                    ),
                ),
            );
            this.logger.debug(`Saved ${docs.length} vToken rates at block ${blockNumber}`);
        }
    }

    // ─── Index Farming pool snapshots ───
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
                    this.farmingRepo.updateOne(
                        { poolId: doc.poolId, blockNumber: doc.blockNumber },
                        { $set: Object.assign({}, doc, { createdAt: new Date() }) },
                        { upsert: true },
                    ),
                ),
            );
        }
    }

    // ─── Status API ───
    async getIndexerStatus() {
        const checkpoint = await this.checkpointRepo.findOneBy({
            key: 'bifrost-polkadot-vtoken',
        });
        const currentBlock = await this.rpc.getCurrentBlockNumber();
        const totalRates = await this.vtokenRateRepo.count();
        const totalFarming = await this.farmingRepo.count();

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

    // ─── Trigger historical backfill ───
    async startBackfill(fromBlock?: number) {
        this.logger.log('Starting historical backfill...');
        await this.checkpointRepo.updateOne(
            { key: 'bifrost-polkadot-vtoken' },
            {
                $set: {
                    lastIndexedBlock: fromBlock ?? BIFROST_CONFIG.START_BLOCK,
                    status: 'running',
                },
            },
            { upsert: true },
        );
        this.runIndexer({ startBlock: fromBlock }).catch((err) => {
            this.logger.error('Backfill error:', err);
        });
        return { message: 'Backfill started', fromBlock: fromBlock ?? BIFROST_CONFIG.START_BLOCK };
    }
}
