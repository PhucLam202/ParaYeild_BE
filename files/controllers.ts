import {
  Controller, Get, Post, Body, Param, Query,
  HttpCode, HttpStatus, Logger
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiParam } from '@nestjs/swagger';
import { IndexerService } from '../modules/indexer/indexer.service';
import { ApyCalculatorService } from '../modules/apy/apy-calculator.service';
import { BacktestService, StrategyConfig } from '../modules/backtest/backtest.service';
import { IsString, IsArray, IsNumber, IsBoolean, IsDateString, ArrayMinSize, Min } from 'class-validator';

// ─── DTOs ───
class StartBackfillDto {
  fromBlock?: number;
}

class SubmitBacktestDto implements StrategyConfig {
  @IsArray()
  @ArrayMinSize(1)
  assets: string[];

  @IsArray()
  @ArrayMinSize(1)
  allocation: number[];

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber()
  @Min(1)
  initialAmountUsd: number;

  @IsBoolean()
  includeFarming: boolean;

  @IsNumber()
  @Min(0)
  rebalanceIntervalDays: number;

  @IsNumber()
  @Min(1)
  compoundFrequencyDays: number;
}

// ─────────────────────────────────────────────────────────────
// INDEXER CONTROLLER
// ─────────────────────────────────────────────────────────────
@ApiTags('Indexer')
@Controller('indexer')
export class IndexerController {
  private readonly logger = new Logger(IndexerController.name);

  constructor(private readonly indexerService: IndexerService) {}

  @Get('status')
  @ApiOperation({ summary: 'Trạng thái indexer và số records đã lưu' })
  async getStatus() {
    return this.indexerService.getIndexerStatus();
  }

  @Post('backfill')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start historical backfill',
    description: 'Crawl toàn bộ lịch sử từ block chỉ định. Chạy async, dùng /status để track tiến độ.',
  })
  async startBackfill(@Body() dto: StartBackfillDto) {
    return this.indexerService.startBackfill(dto.fromBlock);
  }

  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Trigger manual sync (lấy blocks mới nhất)' })
  async syncNow() {
    this.indexerService.runIndexer({ maxBlocks: 2000 }).catch((e) =>
      this.logger.error(e.message),
    );
    return { message: 'Sync triggered' };
  }
}

// ─────────────────────────────────────────────────────────────
// APY CONTROLLER
// ─────────────────────────────────────────────────────────────
@ApiTags('APY')
@Controller('apy')
export class ApyController {
  constructor(private readonly apyService: ApyCalculatorService) {}

  @Get('assets')
  @ApiOperation({ summary: 'Danh sách assets đang được track' })
  async getAssets() {
    return {
      assets: ['vDOT', 'vKSM', 'vGLMR', 'vASTR', 'vBNC'],
      description: 'Bifrost vToken liquid staking assets',
    };
  }

  @Get(':asset/history')
  @ApiOperation({ summary: 'APY lịch sử của một asset' })
  @ApiParam({ name: 'asset', example: 'vDOT' })
  @ApiQuery({ name: 'from', required: false, example: '2023-06-01' })
  @ApiQuery({ name: 'to', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'granularity', required: false, enum: ['hourly', 'daily'] })
  async getApyHistory(
    @Param('asset') asset: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('granularity') granularity: 'hourly' | 'daily' = 'daily',
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const history = await this.apyService.getApyHistory(asset, fromDate, toDate, granularity);

    return {
      asset,
      from: fromDate,
      to: toDate,
      granularity,
      count: history.length,
      data: history,
    };
  }

  @Get(':asset/current')
  @ApiOperation({ summary: 'APY hiện tại của một asset' })
  async getCurrentApy(@Param('asset') asset: string) {
    const history = await this.apyService.getApyHistory(
      asset,
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      new Date(),
      'hourly',
    );

    const latest = history[history.length - 1];
    if (!latest) {
      return { asset, message: 'No data available yet. Run indexer first.' };
    }

    return {
      asset,
      current: latest,
      // Tính trung bình 7 ngày gần nhất
      avg7d: {
        stakingApy: history.reduce((s, d) => s + d.stakingApy, 0) / history.length,
        totalApy: history.reduce((s, d) => s + d.totalApy, 0) / history.length,
      },
    };
  }

  @Post(':asset/compute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Force recompute APY cho một asset ngay lập tức' })
  async forceCompute(@Param('asset') asset: string) {
    const vtokens = {
      vDOT: 'polkadot', vKSM: 'kusama', vGLMR: 'moonbeam',
      vASTR: 'astar', vBNC: 'bifrost-native-coin',
    };
    const coingeckoId = vtokens[asset];
    if (!coingeckoId) return { error: `Unknown asset: ${asset}` };

    await this.apyService.computeApyForAsset(asset, coingeckoId);
    return { message: `APY recomputed for ${asset}` };
  }

  @Post('prices/fetch-historical')
  @ApiOperation({ summary: 'Fetch historical prices từ DeFiLlama để backfill' })
  async fetchHistoricalPrices(
    @Body() body: { coingeckoId: string; fromDate: string; toDate: string },
  ) {
    const from = Math.floor(new Date(body.fromDate).getTime() / 1000);
    const to = Math.floor(new Date(body.toDate).getTime() / 1000);
    const count = await this.apyService.fetchHistoricalPrices(body.coingeckoId, from, to);
    return { message: `Fetched ${count} price points`, coingeckoId: body.coingeckoId };
  }
}

// ─────────────────────────────────────────────────────────────
// BACKTEST CONTROLLER
// ─────────────────────────────────────────────────────────────
@ApiTags('Backtest')
@Controller('backtest')
export class BacktestController {
  constructor(private readonly backtestService: BacktestService) {}

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Submit backtest simulation',
    description: `
Chạy backtest cho một chiến lược. Response ngay với runId.
Dùng GET /backtest/:runId để poll kết quả.

Ví dụ strategy:
- 100% vDOT, 1 năm, auto-compound daily
- 50% vDOT + 50% vKSM, rebalance mỗi 30 ngày
    `,
  })
  async submitBacktest(@Body() dto: SubmitBacktestDto) {
    return this.backtestService.submitBacktest(dto);
  }

  @Get(':runId')
  @ApiOperation({ summary: 'Lấy kết quả backtest theo runId' })
  async getResult(@Param('runId') runId: string) {
    const run = await this.backtestService.getResult(runId);
    if (!run) return { error: 'Run not found', runId };
    return run;
  }

  @Get('')
  @ApiOperation({ summary: 'List all backtest runs' })
  async listRuns(@Query('limit') limit?: string) {
    return this.backtestService.listRuns(parseInt(limit) || 20);
  }

  // ── Preset strategies cho demo ──
  @Post('presets/vdot-only')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Demo: 100% vDOT liquid staking, 1 năm' })
  async presetVdotOnly() {
    return this.backtestService.submitBacktest({
      assets: ['vDOT'],
      allocation: [100],
      startDate: '2023-06-01',
      endDate: '2024-06-01',
      initialAmountUsd: 10000,
      includeFarming: false,
      rebalanceIntervalDays: 0,
      compoundFrequencyDays: 1,
    });
  }

  @Post('presets/multi-vtoken')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Demo: 60% vDOT + 40% vKSM, rebalance monthly' })
  async presetMultiVtoken() {
    return this.backtestService.submitBacktest({
      assets: ['vDOT', 'vKSM'],
      allocation: [60, 40],
      startDate: '2023-06-01',
      endDate: '2024-06-01',
      initialAmountUsd: 10000,
      includeFarming: true,
      rebalanceIntervalDays: 30,
      compoundFrequencyDays: 1,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// HEALTH CONTROLLER
// ─────────────────────────────────────────────────────────────
@ApiTags('Health')
@Controller()
export class HealthController {
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'bifrost-defi-indexer',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }

  @Get()
  root() {
    return {
      name: 'Bifrost DeFi Historical Indexer & Backtest Engine',
      docs: '/api-docs',
      endpoints: {
        indexer: '/indexer/status | /indexer/backfill | /indexer/sync',
        apy: '/apy/:asset/history | /apy/:asset/current',
        backtest: 'POST /backtest/run | GET /backtest/:runId',
        presets: 'POST /backtest/presets/vdot-only | /backtest/presets/multi-vtoken',
      },
    };
  }
}
