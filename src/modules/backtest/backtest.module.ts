import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { StrategyService } from './strategy.service';
import { PoolsClientService } from '../../common/services/pools-client.service';
import { StrategyCache } from '../../entities';

@Module({
    imports: [
        ConfigModule,
        TypeOrmModule.forFeature([StrategyCache]),
    ],
    controllers: [BacktestController],
    providers: [BacktestService, StrategyService, PoolsClientService],
    exports: [BacktestService, StrategyService],
})
export class BacktestModule { }
