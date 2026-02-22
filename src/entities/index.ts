import {
    Entity,
    ObjectIdColumn,
    Column,
    ObjectId,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';


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
