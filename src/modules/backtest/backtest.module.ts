import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BacktestController } from './backtest.controller';
import { BacktestService } from './backtest.service';
import { PoolsClientService } from '../../common/services/pools-client.service';

@Module({
    imports: [ConfigModule],
    controllers: [BacktestController],
    providers: [BacktestService, PoolsClientService],
    exports: [BacktestService],
})
export class BacktestModule { }
