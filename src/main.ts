import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { ApiKeyGuard } from './common/guards/api-key.guard';

async function bootstrap() {
    const logger = new Logger('Bootstrap');
    const app = await NestFactory.create(AppModule, {
        logger: ['log', 'warn', 'error', 'debug'],
    });

    const configService = app.get(ConfigService);
    const nodeEnv = configService.get<string>('nodeEnv');
    const allowedOrigins = configService.get<string[]>('security.allowedOrigins');

    // ─── Security: Helmet HTTP headers ───
    app.use(helmet.default({
        contentSecurityPolicy: nodeEnv === 'production',
        crossOriginEmbedderPolicy: nodeEnv === 'production',
    }));

    // ─── CORS — chỉ cho phép origins đã cấu hình ───
    app.enableCors({
        origin: allowedOrigins,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
        credentials: true,
    });

    // ─── Global API prefix ───
    app.setGlobalPrefix('api/v1');

    // ─── Global Validation Pipe ───
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,  // Reject unknown fields
            transformOptions: { enableImplicitConversion: true },
        }),
    );

    // ─── Global Exception Filter ───
    app.useGlobalFilters(new HttpExceptionFilter());

    // ─── Global ApiKeyGuard ───
    const reflector = app.get(Reflector);
    const configSvc = app.get(ConfigService);
    app.useGlobalGuards(new ApiKeyGuard(configSvc, reflector));

    // ─── Swagger API Docs ───
    const swaggerConfig = new DocumentBuilder()
        .setTitle('ParaYield Lab — Bifrost DeFi Indexer & Backtest Engine')
        .setDescription(`
## Overview
Backend API để index lịch sử data từ Bifrost parachain và chạy backtesting.

## Authentication
- **Public endpoints**: Không cần auth (GET /health, GET /apy/*, GET /backtest/*)
- **Admin endpoints**: \`X-API-Key: <your-key>\` header bắt buộc
  - POST /indexer/backfill
  - POST /indexer/sync
  - POST /apy/:asset/compute
  - POST /apy/prices/fetch-historical

## Rate Limiting
- Global: 100 requests/phút per IP
- POST /backtest/run: 5 requests/phút
- Admin endpoints: 3-5 requests/phút
    `)
        .setVersion('1.0.0')
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'X-API-Key')
        .addTag('Health', 'Health check & API info')
        .addTag('Indexer', 'Block crawler & checkpoint management')
        .addTag('APY', 'APY history & calculation')
        .addTag('Backtest', 'Strategy simulation engine')
        .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/v1/api-docs', app, document, {
        swaggerOptions: { persistAuthorization: true },
        customSiteTitle: 'ParaYield Lab API',
    });

    const port = configService.get<number>('port') || 3000;
    await app.listen(port);

    logger.log(`🚀 ParaYield Lab BE running on: http://localhost:${port}/api/v1`);
    logger.log(`📚 API Docs: http://localhost:${port}/api/v1/api-docs`);
    logger.log(`🔗 MongoDB: ${configService.get<string>('mongodb.uri')}`);
    logger.log(`🌍 Environment: ${nodeEnv}`);
    logger.log(`🔒 CORS origins: ${allowedOrigins?.join(', ')}`);
}

bootstrap();
