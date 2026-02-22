import {
    Controller,
    Post,
    Body,
    HttpCode,
    HttpStatus,
    UseGuards,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiSecurity,
} from '@nestjs/swagger';
import { PriceIndexerService } from './price-indexer.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { IsString, IsDateString } from 'class-validator';

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
