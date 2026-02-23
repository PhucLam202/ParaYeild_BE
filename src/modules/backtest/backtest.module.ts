import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategyService } from './strategy.service';
import { PoolsClientService } from '../../common/services/pools-client.service';

@Module({
    imports: [ConfigModule],
    controllers: [BacktestController],
    providers: [BacktestService, StrategyService, PoolsClientService],
    exports: [BacktestService, StrategyService],
})
export class BacktestModule { }
