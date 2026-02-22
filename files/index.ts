import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

// ─────────────────────────────────────────────────────────────
// 1. INDEXER CHECKPOINT — lưu trạng thái crawl để resume
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'indexer_checkpoints', timestamps: true })
export class IndexerCheckpoint extends Document {
  @Prop({ required: true, unique: true })
  key: string; // e.g. "bifrost-polkadot-vtoken"

  @Prop({ required: true })
  lastIndexedBlock: number;

  @Prop()
  lastIndexedAt: Date;

  @Prop({ default: 'running' })
  status: string; // running | paused | error
}
export const IndexerCheckpointSchema = SchemaFactory.createForClass(IndexerCheckpoint);

// ─────────────────────────────────────────────────────────────
// 2. VTOKEN EXCHANGE RATE — core data để tính liquid staking APY
//    vDOT rate = totalDOTStaked / totalVDOTIssued
//    Khi rate tăng → staking rewards đang tích lũy
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'vtoken_exchange_rates', timestamps: false })
export class VTokenExchangeRate extends Document {
  @Prop({ required: true, index: true })
  tokenSymbol: string; // "vDOT", "vKSM", "vGLMR", "vASTR"

  @Prop({ required: true, index: true })
  blockNumber: number;

  @Prop({ required: true, index: true })
  timestamp: Date;

  // Số token gốc cần để redeem 1 vToken (e.g. 1 vDOT = 1.43 DOT)
  // Lưu dưới dạng string để tránh precision loss với large numbers
  @Prop({ required: true })
  exchangeRate: string; // "1430000000000" (raw on-chain, 10 decimals)

  @Prop({ required: true })
  exchangeRateHuman: number; // 1.43 (đã convert, dùng cho tính toán)

  // Tổng token gốc đang staked trong SLP
  @Prop()
  totalStaked: string; // raw

  // Tổng vToken đang lưu hành
  @Prop()
  totalIssuance: string; // raw

  @Prop({ default: 'bifrost-polkadot' })
  chain: string;
}
export const VTokenExchangeRateSchema = SchemaFactory.createForClass(VTokenExchangeRate);
// Compound index để query range nhanh
VTokenExchangeRateSchema.index({ tokenSymbol: 1, blockNumber: 1 }, { unique: true });
VTokenExchangeRateSchema.index({ tokenSymbol: 1, timestamp: -1 });

// ─────────────────────────────────────────────────────────────
// 3. FARMING POOL SNAPSHOT — Bifrost Farming pallet
//    Mỗi pool có: reward per block, total staked, TVL
//    Dùng để tính farming APR thực tế theo thời gian
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'farming_pool_snapshots', timestamps: false })
export class FarmingPoolSnapshot extends Document {
  @Prop({ required: true, index: true })
  poolId: string; // e.g. "vDOT-DOT", "vKSM-KSM", "BNC-vDOT"

  @Prop({ required: true, index: true })
  blockNumber: number;

  @Prop({ required: true, index: true })
  timestamp: Date;

  // Token pair trong pool
  @Prop()
  token0: string;

  @Prop()
  token1: string;

  // Tổng LP token staked trong farming
  @Prop()
  totalShares: string; // raw

  // Reward rate: BNC per block
  @Prop()
  rewardPerBlock: string; // raw

  // Reward token symbol (thường là BNC)
  @Prop()
  rewardToken: string;

  // TVL tại thời điểm snapshot (USD, computed từ price feed)
  @Prop()
  tvlUsd: number;

  // Farming APR tính tại block này
  @Prop()
  farmingAprPercent: number;

  @Prop({ default: 'bifrost-polkadot' })
  chain: string;
}
export const FarmingPoolSnapshotSchema = SchemaFactory.createForClass(FarmingPoolSnapshot);
FarmingPoolSnapshotSchema.index({ poolId: 1, blockNumber: 1 }, { unique: true });
FarmingPoolSnapshotSchema.index({ poolId: 1, timestamp: -1 });

// ─────────────────────────────────────────────────────────────
// 4. APY SNAPSHOT — Kết quả tổng hợp APY theo giờ/ngày
//    Được tạo bởi APY Calculator từ exchange rate history
//    Đây là data mà backtest engine consume
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'apy_snapshots', timestamps: false })
export class ApySnapshot extends Document {
  @Prop({ required: true, index: true })
  asset: string; // "vDOT", "vKSM", "vDOT-DOT-farm"

  @Prop({ required: true, index: true })
  timestamp: Date;

  @Prop({ required: true })
  blockNumber: number;

  // APY breakdown
  @Prop({ required: true })
  stakingApyPercent: number; // từ exchange rate appreciation

  @Prop({ default: 0 })
  farmingAprPercent: number; // từ BNC rewards

  @Prop({ required: true })
  totalApyPercent: number; // compound total

  // Rolling window calculations
  @Prop()
  apy7d: number; // annualized từ 7 ngày gần nhất

  @Prop()
  apy30d: number; // annualized từ 30 ngày gần nhất

  // Exchange rate tại thời điểm này (để backtest dùng)
  @Prop()
  exchangeRateHuman: number;

  // Giá USD của token gốc tại thời điểm này
  @Prop()
  baseTokenPriceUsd: number;

  @Prop({ default: 'bifrost-polkadot' })
  chain: string;

  // granularity: "hourly" | "daily"
  @Prop({ default: 'hourly' })
  granularity: string;
}
export const ApySnapshotSchema = SchemaFactory.createForClass(ApySnapshot);
ApySnapshotSchema.index({ asset: 1, timestamp: -1 });
ApySnapshotSchema.index({ asset: 1, granularity: 1, timestamp: -1 });

// ─────────────────────────────────────────────────────────────
// 5. TOKEN PRICE — Price feed lịch sử (từ CoinGecko/DeFiLlama)
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'token_prices', timestamps: false })
export class TokenPrice extends Document {
  @Prop({ required: true, index: true })
  symbol: string; // "DOT", "KSM", "BNC", "GLMR"

  @Prop({ required: true, index: true })
  timestamp: Date;

  @Prop({ required: true })
  priceUsd: number;

  @Prop()
  source: string; // "coingecko" | "defillama"
}
export const TokenPriceSchema = SchemaFactory.createForClass(TokenPrice);
TokenPriceSchema.index({ symbol: 1, timestamp: -1 });
TokenPriceSchema.index({ symbol: 1, timestamp: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────
// 6. BACKTEST RUN — Lưu kết quả simulation
// ─────────────────────────────────────────────────────────────
@Schema({ collection: 'backtest_runs', timestamps: true })
export class BacktestRun extends Document {
  @Prop({ required: true, index: true })
  runId: string;

  // Strategy config
  @Prop({ type: Object, required: true })
  strategy: {
    assets: string[];           // ["vDOT", "vKSM"]
    allocation: number[];       // [70, 30] → percentages
    startDate: string;
    endDate: string;
    initialAmountUsd: number;
    includeFarming: boolean;
    rebalanceIntervalDays: number;
  };

  @Prop({ default: 'pending' })
  status: string; // pending | running | done | error

  @Prop({ type: Object })
  results: {
    finalValueUsd: number;
    netPnlUsd: number;
    netPnlPercent: number;
    stakingRewardsUsd: number;
    farmingRewardsUsd: number;
    totalApyRealized: number;
    sharpeRatio: number;
    maxDrawdownPercent: number;
    totalDays: number;
  };

  // Time series data cho chart (sampled daily)
  @Prop({ type: [Object] })
  timeSeries: Array<{
    date: string;
    portfolioValueUsd: number;
    cumulativeRewardsUsd: number;
    exchangeRates: Record<string, number>;
  }>;

  @Prop()
  errorMessage: string;

  @Prop()
  executionTimeMs: number;
}
export const BacktestRunSchema = SchemaFactory.createForClass(BacktestRun);
BacktestRunSchema.index({ runId: 1 }, { unique: true });
BacktestRunSchema.index({ status: 1, createdAt: -1 });
