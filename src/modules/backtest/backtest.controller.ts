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
    ApiExtraModels,
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
import { BacktestService, PoolType } from './backtest.service';
import { StrategyService } from './strategy.service';
import { Public } from '../../common/decorators/public.decorator';

// ─── DTO classes for Swagger + validation ────────────────────────────────────

class BacktestAllocationDto {
    @ApiProperty({ example: 'hydration', description: 'Protocol name' })
    @IsString()
    protocol: string;

    @ApiProperty({ example: 'DOT-ETH', description: 'Asset symbol (LP pair or single asset)' })
    @IsString()
    assetSymbol: string;

    @ApiProperty({ example: 100, description: 'Allocation % (must sum to 100 across all)' })
    @IsNumber()
    @Min(0.01)
    @Max(100)
    percentage: number;

    @ApiProperty({
        enum: PoolType,
        enumName: 'PoolType',
        example: PoolType.VSTAKING,
        required: false,
        description: '"farming"/"dex" enables split-APY + IL; "vstaking"/"lending" uses combined APY',
    })
    @IsOptional()
    @IsEnum(PoolType)
    poolType?: PoolType;
}

class RunBacktestDto {
    @ApiProperty({ example: 1000, description: 'Initial capital in USD' })
    @IsNumber()
    @Min(1)
    initialAmountUsd: number;

    @ApiProperty({ example: '2026-01-01', description: 'Start date (YYYY-MM-DD)' })
    @IsDateString()
    from: string;

    @ApiProperty({ example: '2026-04-01', description: 'End date (YYYY-MM-DD)' })
    @IsDateString()
    to: string;

    @ApiProperty({
        type: [BacktestAllocationDto],
        description:
            'Capital allocations — percentage must sum to 100.\n\n' +
            '**Pool type effects:**\n' +
            '- `farming` / `dex`: Enables split APY model. `supplyApy` (trading fees) ' +
            'auto-compounds daily into LP value. `rewardApy` (farm emissions) accrues ' +
            'into a pending harvest bucket and is only reinvested every `compoundFrequencyDays`.\n' +
            '- `vstaking` / `lending`: Combined APY compounds daily (classic model).',
        example: [
            { protocol: 'hydration', assetSymbol: 'DOT-ETH', percentage: 100, poolType: 'farming' },
        ],
    })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => BacktestAllocationDto)
    allocations: BacktestAllocationDto[];

    @ApiProperty({
        example: 0,
        required: false,
        description: 'Rebalance every N days. 0 = never rebalance.',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    rebalanceIntervalDays?: number;

    @ApiProperty({
        example: true,
        required: false,
        description:
            'If true, harvested farming rewards are reinvested back into the LP pool.\n' +
            'If false, farming rewards accumulate without compounding.',
    })
    @IsOptional()
    @IsBoolean()
    isCompound?: boolean;

    @ApiProperty({
        example: 7,
        required: false,
        description:
            '**[Yield Farming]** Harvest and reinvest farming rewards every N days. ' +
            'Defaults to 7 (weekly). Ignored if `isCompound=false` or `poolType` is not `farming`/`dex`.',
    })
    @IsOptional()
    @IsNumber()
    @Min(1)
    compoundFrequencyDays?: number;

    @ApiProperty({
        example: 0.5,
        required: false,
        description:
            '**[Yield Farming]** Gas/transaction fee (in USD) deducted per harvest event. ' +
            'Simulates the real cost of calling the harvest/claim function. Defaults to $0.50.',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    compoundFeeUsd?: number;

    @ApiProperty({
        example: false,
        required: false,
        description:
            'Apply Impermanent Loss estimation for DEX/farming pools at end of period.',
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

    @ApiProperty({
        example: 0.5,
        required: false,
        description:
            'Slippage tolerance % applied on initial deployment, rebalancing, and when ' +
            'swapping reward tokens back to LP during harvest.',
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Max(5)
    slippageTolerancePercent?: number;
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
     * GET /api/v1/backtest/metadata
     */
    @Get('metadata')
    @Public()
    @ApiOperation({
        summary: 'Lấy metadata cấu hình cho Backtest (Protocols, Tokens, PoolTypes)',
        description:
            'Trả về danh sách các protocol và các token tương ứng kèm theo poolType hợp lệ. ' +
            'Frontend nên dùng dữ liệu này để ràng buộc (constrain) dropdown, tránh lỗi 422.',
    })
    async getMetadata() {
        return this.backtestService.getBacktestMetadata();
    }

    /**
     * GET /api/v1/backtest/suggest-strategies
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

**Cache:** Kết quả được cache 5 phút. Dùng \`?refresh=true\` để force regenerate.
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
     */
    @Get('apy-history')
    @Public()
    @ApiOperation({
        summary: 'Lấy lịch sử APY của pool từ external server',
        description:
            'Proxy đến `/pools/history` của external data server. ' +
            'Dữ liệu trả về gồm `supplyApy` (trading fees) và `rewardApy` (farm rewards) ' +
            'để kiểm tra trước khi chạy backtest.',
    })
    @ApiQuery({ name: 'protocol', required: false, example: 'hydration' })
    @ApiQuery({ name: 'asset', required: false, example: 'DOT-ETH' })
    @ApiQuery({ name: 'poolType', required: false, example: 'farming' })
    @ApiQuery({ name: 'from', required: false, example: '2026-01-01' })
    @ApiQuery({ name: 'to', required: false, example: '2026-04-01' })
    async getApyHistory(
        @Query('protocol') protocol?: string,
        @Query('asset') asset?: string,
        @Query('poolType') poolType?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
    ) {
        return this.backtestService.fetchApyHistory({ protocol, asset, poolType, from, to });
    }

    /**
     * POST /api/v1/backtest/run
     */
    @Post('run')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: '🚀 Chạy backtest với APY lịch sử thực tế (Hỗ trợ Yield Farming)',
        description: `
**Backtest Engine v3** — Hỗ trợ 2 chế độ tính toán dựa trên \`poolType\`:

---

### 🌾 Yield Farming Mode (\`poolType: "farming"\` hoặc \`"dex"\`)

Tách APY thành 2 thành phần với cách xử lý khác nhau:

| Thành phần | Nguồn | Cách tính |
|---|---|---|
| **Trading Fees** (\`supplyApy\`) | Phí giao dịch DEX | Auto-compound HÀNG NGÀY vào giá trị LP (không cần gas) |
| **Farm Rewards** (\`rewardApy\`) | Farm token emissions | Tích lũy vào bucket riêng, chỉ reinvest mỗi \`compoundFrequencyDays\` ngày |

**Harvest Simulation:**
\`\`\`
Mỗi compoundFrequencyDays ngày:
  rewards_after_gas = unclaimed_rewards - compoundFeeUsd
  rewards_reinvested = rewards_after_gas * (1 - slippagePct/100)
  LP_value += rewards_reinvested
\`\`\`

---

### 📊 Single Pool Mode (\`poolType: "vstaking"\` hoặc \`"lending"\`)

APY tổng = \`supplyApy + rewardApy\`, compound hàng ngày (hành vi giống v2).

---

### 📉 Impermanent Loss (\`includeIL: true\`)

Áp dụng cho DEX/Farming pools vào cuối kỳ.  
Công thức: \`IL = 2√r / (1 + r) - 1\` (Uniswap v2 AMM formula, r = price ratio).
        `,
    })
    @ApiBody({ type: RunBacktestDto })
    async runBacktest(@Body() dto: RunBacktestDto) {
        return this.backtestService.runBacktest(dto);
    }
}
