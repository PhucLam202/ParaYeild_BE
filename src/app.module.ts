import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';

import configuration from './config/configuration';
import { PriceIndexerModule } from './modules/price-indexer/price-indexer.module';
import { SimulationModule } from './modules/simulation/simulation.module';
import { BacktestModule } from './modules/backtest/backtest.module';
import { LoggerModule } from './modules/logger/logger.module';
import { HealthController } from './health.controller';

@Module({
    imports: [
        // ─── Config (env vars) ───
        ConfigModule.forRoot({
            isGlobal: true,
            load: [configuration],
            envFilePath: '.env',
        }),

        // ─── TypeORM MongoDB ───
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: async (config: ConfigService) => ({
                type: 'mongodb',
                url: config.get<string>('mongodb.uri'),
                synchronize: true, // Tự động tạo collections/indexes từ definitions
                useNewUrlParser: true,
                useUnifiedTopology: true,
                autoLoadEntities: true,
            }),
            inject: [ConfigService],
        }),

        // ─── Cron scheduler ───
        ScheduleModule.forRoot(),

        // ─── Rate limiting (global) ───
        ThrottlerModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (config: ConfigService) => ([{
                ttl: config.get<number>('throttle.ttl'),
                limit: config.get<number>('throttle.limit'),
            }]),
            inject: [ConfigService],
        }),

        // ─── Feature modules ───
        LoggerModule,
        PriceIndexerModule,
        SimulationModule,
        BacktestModule,
    ],

    controllers: [HealthController],

    providers: [
        // Apply ThrottlerGuard globally
        {
            provide: APP_GUARD,
            useClass: ThrottlerGuard,
        },
    ],
})
export class AppModule { }
