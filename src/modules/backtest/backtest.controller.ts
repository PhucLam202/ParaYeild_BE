import {
    Controller,
    Get,
    Post,
    Body,
    Query,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiQuery,
    ApiBody,
    ApiProperty,
} from '@nestjs/swagger';
import {
    IsNumber,
    IsString,
    IsDateString,
    IsArray,
    IsOptional,
    IsBoolean,
    IsEnum,
    ValidateNested,
    Min,
    Max,
    ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BacktestService } from './backtest.service';
import { StrategyService } from './strategy.service';
import { Public } from '../../common/decorators/public.decorator';

// ─── DTO classes for Swagger + validation ────────────────────────────────────

class BacktestAllocationDto {
    @ApiProperty({ example: 'bifrost', description: 'Protocol name' })
    @IsString()
    protocol: string;

    @ApiProperty({ example: 'vDOT', description: 'Asset symbol' })
    @IsString()
    assetSymbol: string;

    @ApiProperty({ example: 60, description: 'Allocation % (must sum to 100 across all)' })
    @IsNumber()
    @Min(0.01)
    @Max(100)
    percentage: number;

    @ApiProperty({
        example: 'vstaking',
        required: false,
        description: 'Pool type — "dex" enables IL calculation',
    })
    @IsOptional()
    @IsString()
    poolType?: string;
}

class RunBacktestDto {
    @ApiProperty({ example: 10000, description: 'Initial capital in USD' })
    @IsNumber()
    @Min(1)
    initialAmountUsd: number;

    @ApiProperty({ example: '2026-01-01', description: 'Start date (YYYY-MM-DD)' })
    @IsDateString()
    from: string;

    @ApiProperty({ example: '2026-02-01', description: 'End date (YYYY-MM-DD)' })
    @IsDateString()
    to: string;

    @ApiProperty({
        type: [BacktestAllocationDto],
        description: 'Capital allocations — percentage must sum to 100',
        example: [
            { protocol: 'bifrost', assetSymbol: 'vDOT', percentage: 60, poolType: 'vstaking' },
            { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 40, poolType: 'dex' },
        ],
    })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => BacktestAllocationDto)
    allocations: BacktestAllocationDto[];

    @ApiProperty({
        example: 7,
        required: false,
        description: 'Rebalance every N days. 0 = never rebalance.',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    rebalanceIntervalDays?: number;

    @ApiProperty({
        example: false,
        required: false,
        description: 'Apply Impermanent Loss estimate for DEX/farming pools.',
    })
    @IsOptional()
    @IsBoolean()
    includeIL?: boolean;

    @ApiProperty({
        example: 0.5,
        required: false,
        description: 'XCM fee in USD deducted per rebalance event.',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    xcmFeeUsd?: number;
}

// ─── Extra DTOs ──────────────────────────────────────────────────────────────

class SuggestStrategiesQueryDto {
    @ApiProperty({
        enum: ['low', 'medium', 'high'],
        required: false,
        description: 'Filter suggestions by risk level',
    })
    @IsOptional()
    @IsEnum(['low', 'medium', 'high'])
    riskLevel?: 'low' | 'medium' | 'high';

    @ApiProperty({
        required: false,
        example: 5,
        description: 'Only include chains with estimated APY min >= this value',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minApy?: number;

    @ApiProperty({
        required: false,
        example: false,
        description: 'Set to true to bypass 5-min cache and force LLM re-generation',
    })
    @IsOptional()
    @IsBoolean()
    @Type(() => Boolean)
    refresh?: boolean;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('Backtest')
@Controller('backtest')
export class BacktestController {
    constructor(
        private readonly backtestService: BacktestService,
        private readonly strategyService: StrategyService,
    ) { }

    /**
     * GET /api/v1/backtest/suggest-strategies
     * Use LLM to analyse current pools and generate investment chain suggestions.
     */
    @Get('suggest-strategies')
    @Public()
    @ApiOperation({
        summary: '🤖 Gợi ý chuỗi đầu tư tối ưu bằng AI',
        description: `
Gọi OpenAI để phân tích các pool hiện tại và tạo ra các **chuỗi đầu tư đề xuất**.

Mỗi chain bao gồm:
- Danh sách allocations (protocol + asset + %) sẵn sàng truyền vào \`POST /backtest/run\`
- Ước tính APY tổng hợp
- Mức rủi ro (low / medium / high)
- Lý giải từ AI

**Cache:** Kết quả được cache 5 phút để tiết kiệm token. Dùng \`?refresh=true\` để force regenerate.
        `,
    })
    @ApiQuery({ name: 'riskLevel', required: false, enum: ['low', 'medium', 'high'] })
    @ApiQuery({ name: 'minApy', required: false, type: Number, example: 5 })
    @ApiQuery({ name: 'refresh', required: false, type: Boolean, example: false })
    async suggestStrategies(
        @Query('riskLevel') riskLevel?: 'low' | 'medium' | 'high',
        @Query('minApy') minApy?: number,
        @Query('refresh') refresh?: string,
    ) {
        const parsedMinApy = minApy !== undefined && !isNaN(Number(minApy)) ? Number(minApy) : undefined;
        return this.strategyService.suggestStrategies(
            { riskLevel, minApy: parsedMinApy },
            refresh === 'true',
        );
    }

    /**
     * GET /api/v1/backtest/apy-history
     * Proxy to external /pools/history endpoint — use to inspect raw APY data
     * before running a full backtest.
     */
    @Get('apy-history')
    @Public()
    @ApiOperation({
        summary: 'Lấy lịch sử APY của pool từ external server',
        description:
            'Proxy đến `/pools/history` của external data server. ' +
            'Dùng để kiểm tra dữ liệu historical APY trước khi chạy backtest.',
    })
    @ApiQuery({ name: 'protocol', required: false, example: 'bifrost' })
    @ApiQuery({ name: 'asset', required: false, example: 'vDOT' })
    @ApiQuery({ name: 'poolType', required: false, example: 'vstaking' })
    @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-02-01' })
    async getApyHistory(
        @Query('protocol') protocol?: string,
        @Query('asset') asset?: string,
        @Query('poolType') poolType?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
    ) {
        return this.backtestService.fetchApyHistory({
            protocol,
            asset,
            poolType,
            from,
            to,
        });
    }

    /**
     * POST /api/v1/backtest/run
     * Run a full historical backtest using real day-by-day APY data.
     */
    @Post('run')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Chạy backtest với APY lịch sử thực tế',
        description: `
**Backtest engine thế hệ 2** — sử dụng APY thực tế từng ngày thay vì APY tĩnh.

**Logic:**
- Với mỗi allocation, fetch lịch sử APY từ \`/pools/history\`
- Loop từng ngày: compound daily \`value *= (1 + APY%/365/100)\`
- Nếu là rebalance day: phân bổ lại theo % ban đầu, trừ XCM fee
- Nếu pool DEX/farming: tính Impermanent Loss ước tính
- Output: Sharpe Ratio, Max Drawdown, full timeSeries

**APY fallback:** Nếu ngày không có data → dùng APY của ngày gần nhất.
    `,
    })
    @ApiBody({ type: RunBacktestDto })
    async runBacktest(@Body() dto: RunBacktestDto) {
        return this.backtestService.runBacktest(dto);
    }
}
