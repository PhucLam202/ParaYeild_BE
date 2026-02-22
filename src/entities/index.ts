import {
    Entity,
    ObjectIdColumn,
    Column,
    ObjectId,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';

// ─── 1. Indexer Checkpoint ───
@Entity('indexer_checkpoints')
export class IndexerCheckpoint {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index({ unique: true })
    key: string; // Identifier for the process, e.g., 'bifrost-polkadot-vtoken'

    @Column()
    lastIndexedBlock: number;

    @Column()
    lastIndexedAt: Date;

    @Column()
    status: 'running' | 'idle' | 'error';
}

// ─── 2. VToken Exchange Rate ───
@Entity('vtoken_exchange_rates')
@Index(['tokenSymbol', 'blockNumber'], { unique: true })
export class VTokenExchangeRate {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index()
    tokenSymbol: string;

    @Column()
    blockNumber: number;

    @Column()
    @Index()
    timestamp: Date;

    @Column()
    exchangeRate: string; // Raw string từ protocol

    @Column('double')
    exchangeRateHuman: number; // Đã format decimal

    @Column()
    totalStaked: string;

    @Column()
    totalIssuance: string;

    @Column()
    chain: string;

    @CreateDateColumn()
    createdAt: Date;
}

// ─── 3. Farming Pool Snapshot ───
@Entity('farming_pool_snapshots')
@Index(['poolId', 'blockNumber'], { unique: true })
export class FarmingPoolSnapshot {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index()
    poolId: string; // Tên pool, ví dụ 'vDOT-DOT'

    @Column()
    blockNumber: number;

    @Column()
    @Index()
    timestamp: Date;

    @Column()
    token0: string;

    @Column()
    token1: string;

    @Column()
    totalShares: string;

    @Column()
    rewardPerBlock: string;

    @Column()
    rewardToken: string;

    @Column('double')
    tvlUsd: number; // For future tracking

    @Column('double')
    farmingAprPercent: number; // Computed farming APR

    @Column()
    chain: string;

    @CreateDateColumn()
    createdAt: Date;
}

// ─── 4. APY Snapshot ───
@Entity('apy_snapshots')
@Index(['asset', 'granularity', 'timestamp'], { unique: true })
export class ApySnapshot {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index()
    asset: string;

    @Column()
    @Index()
    timestamp: Date;

    @Column()
    blockNumber: number;

    @Column('double')
    stakingApyPercent: number;

    @Column('double')
    farmingAprPercent: number;

    @Column('double')
    totalApyPercent: number;

    @Column('double')
    apy7d: number;

    @Column('double')
    apy30d: number;

    @Column('double')
    exchangeRateHuman: number;

    @Column('double')
    baseTokenPriceUsd: number;

    @Column()
    chain: string;

    @Column({ default: 'hourly' })
    @Index()
    granularity: 'hourly' | 'daily'; // hourly computed by cron, daily aggregated

    @CreateDateColumn()
    createdAt: Date;
}

// ─── 5. Token Price (Historical) ───
@Entity('token_prices')
@Index(['symbol', 'timestamp'], { unique: true })
export class TokenPrice {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index()
    symbol: string; // Coingecko ID

    @Column('double')
    priceUsd: number;

    @Column()
    @Index()
    timestamp: Date;

    @Column()
    source: string; // 'defillama' | 'coingecko'

    @CreateDateColumn()
    createdAt: Date;
}

// ─── 6. Backtest Run ───
@Entity('backtest_runs')
export class BacktestRun {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index({ unique: true })
    runId: string;

    // TypeORM MongoDB handles objects directly
    @Column()
    strategy: Record<string, any>;

    @Column()
    @Index()
    status: 'pending' | 'running' | 'done' | 'error';

    @Column()
    results: Record<string, any>; // finalValue, apy, maxDrawdown, sharpe

    @Column()
    timeSeries: Record<string, any>[]; // max 500 records cho UI chart

    @Column()
    errorMessage: string;

    @Column()
    executionTimeMs: number;

    @CreateDateColumn()
    @Index()
    createdAt: Date;
}

// ─── 7. Activity Log ───
@Entity('activity_logs')
export class ActivityLog {
    @ObjectIdColumn()
    id: ObjectId;

    @Column()
    @Index()
    method: string;

    @Column()
    @Index()
    url: string;

    @Column()
    @Index()
    status: number;

    @Column()
    requestBody: Record<string, any>;

    @Column()
    responseBody: Record<string, any>;

    @Column()
    @Index()
    ip: string;

    @Column()
    userAgent: string;

    @Column()
    executionTimeMs: number;

    @CreateDateColumn()
    @Index()
    createdAt: Date;
}
