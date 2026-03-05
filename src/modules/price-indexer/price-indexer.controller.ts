import {
    Controller,
    Post,
    Get,
    Body,
    Query,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiSecurity,
    ApiQuery,
} from '@nestjs/swagger';
import { PriceIndexerService } from './price-indexer.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { IsString, IsDateString, IsOptional } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';

export class RealtimePriceQueryDto {
    @IsOptional()
    @IsString()
    symbols?: string = 'DOT';
}

export class FetchHistoricalPricesDto {
    @IsString()
    coingeckoId: string;

    @IsDateString()
    fromDate: string;

    @IsDateString()
    toDate: string;
}

@ApiTags('Price Indexer')
@Controller('price-indexer')
@UseGuards(ApiKeyGuard)
@ApiSecurity('X-API-Key')
export class PriceIndexerController {
    constructor(private readonly priceService: PriceIndexerService) { }

    @Public()
    @Get('tokens/realtime')
    @ApiOperation({ summary: 'Get real-time prices for one or more tokens from Binance via ccxt' })
    @ApiQuery({
        name: 'symbols',
        required: false,
        example: 'DOT,ETH,KSM,ASTR,GLMR',
        description: 'Comma-separated token symbols (e.g. DOT,ETH,KSM)',
    })
    async getTokensRealtimePrice(@Query() query: RealtimePriceQueryDto) {
        const tokens = (query.symbols ?? 'DOT')
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
        const data = await this.priceService.getTokensRealtimePrice(tokens);
        return { tokens: data };
    }

    @Post('fetch-historical')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: '[ADMIN] Fetch historical prices từ DeFiLlama — yêu cầu X-API-Key' })
    async fetchHistoricalPrices(@Body() body: FetchHistoricalPricesDto) {
        const from = Math.floor(new Date(body.fromDate).getTime() / 1000);
        const to = Math.floor(new Date(body.toDate).getTime() / 1000);
        const count = await this.priceService.fetchHistoricalPrices(body.coingeckoId, from, to);
        return { message: `Fetched ${count} price points`, coingeckoId: body.coingeckoId };
    }
}
