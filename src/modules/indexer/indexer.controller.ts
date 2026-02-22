import {
    Controller,
    Get,
    Post,
    Body,
    HttpCode,
    HttpStatus,
    UseGuards,
    Logger,
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiSecurity,
    ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IndexerService } from './indexer.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { Public } from '../../common/decorators/public.decorator';
import { IsNumber, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

class StartBackfillDto {
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    fromBlock?: number;
}

@ApiTags('Indexer')
@Controller('indexer')
@UseGuards(ApiKeyGuard)  // Toàn bộ controller yêu cầu API Key
@ApiSecurity('X-API-Key')
export class IndexerController {
    private readonly logger = new Logger(IndexerController.name);

    constructor(private readonly indexerService: IndexerService) { }

    @Get('status')
    @Public()  // Endpoint này public — không cần API key
    @ApiOperation({ summary: 'Trạng thái indexer và số records đã lưu' })
    async getStatus() {
        return this.indexerService.getIndexerStatus();
    }

    @Post('backfill')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 3, ttl: 60000 } }) // 3 req/phút max
    @ApiOperation({
        summary: '[ADMIN] Start historical backfill — yêu cầu X-API-Key header',
        description: 'Crawl toàn bộ lịch sử từ block chỉ định. Chạy async, dùng GET /status để track.',
    })
    async startBackfill(@Body() dto: StartBackfillDto) {
        return this.indexerService.startBackfill(dto.fromBlock);
    }

    @Post('sync')
    @HttpCode(HttpStatus.ACCEPTED)
    @Throttle({ default: { limit: 5, ttl: 60000 } })
    @ApiOperation({ summary: '[ADMIN] Trigger manual sync — yêu cầu X-API-Key header' })
    async syncNow() {
        this.indexerService.runIndexer({ maxBlocks: 2000 }).catch((e) =>
            this.logger.error(e.message),
        );
        return { message: 'Sync triggered' };
    }
}
