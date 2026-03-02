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
    ApiOkResponse,
} from '@nestjs/swagger';
import {
    IsNumber,
    IsString,
    IsDateString,
    IsArray,
    ValidateNested,
    Min,
    Max,
    ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { SimulationService } from './simulation.service';
import { Public } from '../../common/decorators/public.decorator';

class AllocationDto {
    @ApiProperty({ example: 'hydration', description: 'Tên protocol' })
    @IsString()
    protocol: string;

    @ApiProperty({ example: 'HOLLAR', description: 'Symbol của token/pool' })
    @IsString()
    assetSymbol: string;

    @ApiProperty({ example: 60, description: 'Phần trăm vốn phân bổ (tổng phải = 100)' })
    @IsNumber()
    @Min(0.01)
    @Max(100)
    percentage: number;
}

class RunSimulationDto {
    @ApiProperty({ example: 10000, description: 'Số vốn ban đầu (USD)' })
    @IsNumber()
    @Min(1)
    initialAmountUsd: number;

    @ApiProperty({ example: '2026-01-01', description: 'Ngày bắt đầu simulation' })
    @IsDateString()
    from: string;

    @ApiProperty({ example: '2026-02-01', description: 'Ngày kết thúc simulation' })
    @IsDateString()
    to: string;

    @ApiProperty({
        type: [AllocationDto],
        description: 'Danh sách phân bổ vốn (tổng percentage phải = 100)',
        example: [
            { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 60 },
            { protocol: 'hydration', assetSymbol: 'aDOT', percentage: 40 },
        ],
    })
    @IsArray()
    @ArrayMinSize(1)
    @ValidateNested({ each: true })
    @Type(() => AllocationDto)
    allocations: AllocationDto[];
}

class ParachainsResponseDto {
    @ApiProperty({ type: [String], description: 'Danh sách các Parachains hỗ trợ', example: ['polkadot', 'moonbeam', 'bifrost', 'hydration'] })
    data: string[];
}

class ProtocolTypesResponseDto {
    @ApiProperty({ type: [String], description: 'Danh sách các Protocol Types hỗ trợ', example: ['dex', 'vstaking', 'farming', 'lending'] })
    data: string[];
}

class TokensResponseDto {
    @ApiProperty({ type: [String], description: 'Danh sách các Tokens hỗ trợ', example: ['vDOT', 'BNC', 'GLMR'] })
    data: string[];
}

class ProtocolsResponseDto {
    @ApiProperty({ type: [String], description: 'Danh sách các Protocols hỗ trợ', example: ['hydration', 'bifrost', 'moonwell'] })
    data: string[];
}

@ApiTags('Pools')
@Controller('pools')
export class PoolsController {
    constructor(private readonly simulationService: SimulationService) { }

    @Get()
    @Public()
    @ApiOperation({
        summary: 'Lấy danh sách pools từ data server',
        description: 'Proxy đến data server với đầy đủ filter. Kết quả dùng để chọn pool cho simulation.',
    })
    @ApiQuery({ name: 'protocol', required: false, example: 'hydration', description: 'bifrost | moonwell | hydration' })
    @ApiQuery({ name: 'asset', required: false, example: 'DOT', description: 'Symbol token (DOT, vDOT, GLMR...)' })
    @ApiQuery({ name: 'poolType', required: false, example: 'dex', description: 'vstaking | farming | lending | dex' })
    @ApiQuery({ name: 'network', required: false, example: 'polkadot', description: 'polkadot | moonbeam | bifrost | hydration' })
    @ApiQuery({ name: 'minApy', required: false, example: 5, description: 'APY tối thiểu (%)' })
    @ApiQuery({ name: 'limit', required: false, example: 50, description: 'Số bản ghi (max 200)' })
    @ApiQuery({ name: 'sortBy', required: false, example: 'totalApy', description: 'totalApy | tvlUsd | crawledAt' })
    @ApiQuery({ name: 'from', required: false, example: '2026-01-01', description: 'Từ ngày (ISO)' })
    @ApiQuery({ name: 'to', required: false, example: '2026-02-01', description: 'Đến ngày (ISO)' })
    async getPools(
        @Query('protocol') protocol?: string,
        @Query('asset') asset?: string,
        @Query('poolType') poolType?: string,
        @Query('network') network?: string,
        @Query('minApy') minApy?: number,
        @Query('limit') limit?: number,
        @Query('sortBy') sortBy?: string,
        @Query('from') from?: string,
        @Query('to') to?: string,
    ) {
        return this.simulationService.fetchPools({
            protocol, asset, poolType, network, minApy, limit, sortBy, from, to,
        });
    }
}

@ApiTags('Simulation')
@Controller('simulation')
export class SimulationController {
    constructor(private readonly simulationService: SimulationService) { }

    @Get('parachains')
    @Public()
    @ApiOperation({
        summary: 'Lấy danh sách All Parachains',
        description: 'Trả về all Parachain đang có hỗ trợ để backtest và simulation.',
    })
    @ApiOkResponse({ type: ParachainsResponseDto })
    async getParachains() {
        const data = await this.simulationService.getParachains();
        return { data };
    }

    @Get('protocol-types')
    @Public()
    @ApiOperation({
        summary: 'Lấy danh sách All Protocol Types',
        description: 'Trả về all Protocol Type, các type hỗ trợ, như Dex, liquid staking...',
    })
    @ApiOkResponse({ type: ProtocolTypesResponseDto })
    async getProtocolTypes() {
        const data = await this.simulationService.getProtocolTypes();
        return { data };
    }

    @Get('tokens')
    @Public()
    @ApiOperation({
        summary: 'Lấy danh sách All Tokens',
        description: 'Trả về all token cho Token Pair (đơn hoặc cặp).',
    })
    @ApiOkResponse({ type: TokensResponseDto })
    async getTokens() {
        const data = await this.simulationService.getTokens();
        return { data };
    }

    @Get('protocols')
    @Public()
    @ApiOperation({
        summary: 'Lấy danh sách All Protocols',
        description: 'Trả về all protocol hỗ trợ, như hydration, bifrost...',
    })
    @ApiOkResponse({ type: ProtocolsResponseDto })
    async getProtocols() {
        const data = await this.simulationService.getProtocols();
        return { data };
    }


    @Post('run')
    @Public()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({
        summary: 'Chạy simulation đầu tư',
        description: `Tính toán hiệu suất đầu tư theo thời gian dựa trên APY của các pool.
        
**Logic:** compound daily — \`final = initial × (1 + APY/365)^days\`

**Lưu ý:** Các \`allocations\` phải có tổng \`percentage\` = 100.`,
    })
    @ApiBody({ type: RunSimulationDto })
    @HttpCode(HttpStatus.OK)
    async runSimulation(@Body() dto: RunSimulationDto) {
        return this.simulationService.runSimulation(dto);
    }
}
