import {
    Controller,
    Get,
    Post,
    Body,
    Param,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiSecurity,
} from '@nestjs/swagger';
import { ApyCalculatorService } from './apy-calculator.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { Public } from '../../common/decorators/public.decorator';
import { IsString, IsDateString } from 'class-validator';

class FetchHistoricalPricesDto {
    @IsString()
    coingeckoId: string;

    @IsDateString()
    fromDate: string;

    @IsDateString()
    toDate: string;
}

@ApiTags('APY')
@Controller('apy')
@UseGuards(ApiKeyGuard)
@ApiSecurity('X-API-Key')
export class ApyController {
    constructor(private readonly apyService: ApyCalculatorService) { }

    @Get('assets')
    @Public()
    @ApiOperation({ summary: 'Danh sách assets đang được track' })
    getAssets() {
        return {
            assets: ['vDOT', 'vKSM', 'vGLMR', 'vASTR', 'vBNC'],
            description: 'Bifrost vToken liquid staking assets trên Polkadot',
        };
    }

    @Get('pools')
    @Public()
    @ApiOperation({
        summary: 'Tất cả Bifrost pools với APY/APYR hiện tại',
        description: 'Trả về toàn bộ vToken pools (vDOT, vKSM, vGLMR, vASTR, vBNC) cùng APY 7d/30d, farming APR và tổng APY trong 1 call.',
    })
    async getAllPools() {
        const pools = await this.apyService.getAllPoolsApy();
        return {
            count: pools.length,
            updatedAt: new Date(),
            pools,
        };
    }

    @Get(':asset/history')
    @Public()
    @ApiOperation({ summary: 'APY lịch sử của một asset' })
    @ApiParam({ name: 'asset', example: 'vDOT' })
    @ApiQuery({ name: 'from', required: false, example: '2023-06-01' })
    @ApiQuery({ name: 'to', required: false })
    @ApiQuery({ name: 'granularity', required: false, enum: ['hourly', 'daily'] })
    async getApyHistory(
        @Param('asset') asset: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
        @Query('granularity') granularity: 'hourly' | 'daily' = 'daily',
    ) {
        const fromDate = from
            ? new Date(from)
            : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
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
    @Public()
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
            avg7d: {
                stakingApy: history.reduce((s, d) => s + d.stakingApy, 0) / history.length,
                totalApy: history.reduce((s, d) => s + d.totalApy, 0) / history.length,
            },
        };
    }

    @Post(':asset/compute')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: '[ADMIN] Force recompute APY cho asset — yêu cầu X-API-Key' })
    async forceCompute(@Param('asset') asset: string) {
        const vtokens: Record<string, string> = {
            vDOT: 'polkadot',
            vKSM: 'kusama',
            vGLMR: 'moonbeam',
            vASTR: 'astar',
            vBNC: 'bifrost-native-coin',
        };
        const coingeckoId = vtokens[asset];
        if (!coingeckoId) return { error: `Unknown asset: ${asset}` };

        await this.apyService.computeApyForAsset(asset, coingeckoId);
        return { message: `APY recomputed for ${asset}` };
    }

    @Post(':asset/backfill-history')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: '[ADMIN] Lùi lại test và backfill APY lịch sử dự theo exchange rates trong DB' })
    async backfillHistory(@Param('asset') asset: string) {
        const vtokens: Record<string, string> = {
            vDOT: 'polkadot',
            vKSM: 'kusama',
            vGLMR: 'moonbeam',
            vASTR: 'astar',
            vBNC: 'bifrost-native-coin',
        };
        const coingeckoId = vtokens[asset];
        if (!coingeckoId) return { error: `Unknown asset: ${asset}` };

        const count = await this.apyService.backfillApyHistory(asset, coingeckoId);
        return { message: `Successfully backfilled ${count} historical APY records for ${asset}` };
    }

    @Post('prices/fetch-historical')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: '[ADMIN] Fetch historical prices từ DeFiLlama — yêu cầu X-API-Key' })
    async fetchHistoricalPrices(@Body() body: FetchHistoricalPricesDto) {
        const from = Math.floor(new Date(body.fromDate).getTime() / 1000);
        const to = Math.floor(new Date(body.toDate).getTime() / 1000);
        const count = await this.apyService.fetchHistoricalPrices(body.coingeckoId, from, to);
        return { message: `Fetched ${count} price points`, coingeckoId: body.coingeckoId };
    }
}
