import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';

// Schemas
import {
  IndexerCheckpoint, IndexerCheckpointSchema,
  VTokenExchangeRate, VTokenExchangeRateSchema,
  FarmingPoolSnapshot, FarmingPoolSnapshotSchema,
  ApySnapshot, ApySnapshotSchema,
  TokenPrice, TokenPriceSchema,
  BacktestRun, BacktestRunSchema,
} from './schemas';

// Services
import { BifrostRpcService } from './modules/indexer/bifrost-rpc.service';
import { IndexerService } from './modules/indexer/indexer.service';
import { ApyCalculatorService } from './modules/apy/apy-calculator.service';
import { BacktestService } from './modules/backtest/backtest.service';

// Controllers
import {
  IndexerController,
  ApyController,
  BacktestController,
  HealthController,
} from './controllers';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/bifrost-indexer';

@Module({
  imports: [
    // MongoDB connection
    MongooseModule.forRoot(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    }),

    // Register all schemas
    MongooseModule.forFeature([
      { name: IndexerCheckpoint.name, schema: IndexerCheckpointSchema },
      { name: VTokenExchangeRate.name, schema: VTokenExchangeRateSchema },
      { name: FarmingPoolSnapshot.name, schema: FarmingPoolSnapshotSchema },
      { name: ApySnapshot.name, schema: ApySnapshotSchema },
      { name: TokenPrice.name, schema: TokenPriceSchema },
      { name: BacktestRun.name, schema: BacktestRunSchema },
    ]),

    // Cron jobs scheduler
    ScheduleModule.forRoot(),
  ],

  controllers: [
    HealthController,
    IndexerController,
    ApyController,
    BacktestController,
  ],

  providers: [
    BifrostRpcService,
    IndexerService,
    ApyCalculatorService,
    BacktestService,
  ],
})
export class AppModule {}
