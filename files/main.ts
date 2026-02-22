import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error', 'debug'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  // CORS (cho FE dev)
  app.enableCors();

  // Swagger API docs
  const config = new DocumentBuilder()
    .setTitle('Bifrost DeFi Indexer & Backtest Engine')
    .setDescription(
      `
## Overview
Backend API để index lịch sử data từ Bifrost parachain và chạy backtesting.

## Data Flow
\`\`\`
Bifrost RPC (archive node)
    ↓ crawl blocks
IndexerService → MongoDB (raw exchange rates, farming pools)
    ↓ compute hourly
ApyCalculatorService → MongoDB (APY snapshots)
    ↓ simulation
BacktestService → MongoDB (backtest results)
    ↓
REST API → Frontend
\`\`\`

## Key Concepts
- **vToken exchange rate**: vDOT/DOT ratio, tăng theo thời gian khi staking rewards tích lũy
- **APY = annualized(rate_now / rate_7d_ago) - 1**: tính từ exchange rate appreciation
- **Backtest**: simulate portfolio theo historical APY, track compound returns + drawdown
      `,
    )
    .setVersion('1.0.0')
    .addTag('Health', 'Health check')
    .addTag('Indexer', 'Block crawler & checkpoint management')
    .addTag('APY', 'APY history & calculation')
    .addTag('Backtest', 'Strategy simulation engine')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 Bifrost Indexer running on: http://localhost:${port}`);
  logger.log(`📚 API Docs: http://localhost:${port}/api-docs`);
  logger.log(`🔗 MongoDB: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/bifrost-indexer'}`);
}

bootstrap();
