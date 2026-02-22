import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ActivityLog } from '../../entities';
import { LoggingInterceptor } from '../../common/interceptors/logging.interceptor';

@Module({
    imports: [TypeOrmModule.forFeature([ActivityLog])],
    providers: [
        {
            provide: APP_INTERCEPTOR,
            useClass: LoggingInterceptor,
        },
    ],
})
export class LoggerModule { }
