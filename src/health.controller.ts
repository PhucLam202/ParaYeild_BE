import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';

@ApiTags('Health')
@Controller()
export class HealthController {
    @Get('health')
    @Public()
    @ApiOperation({ summary: 'Health check' })
    health() {
        return {
            status: 'ok',
            service: 'parayield-lab-be',
            version: '1.0.0',
            timestamp: new Date().toISOString(),
        };
    }

    @Get()
    @Public()
    @ApiOperation({ summary: 'API Info và endpoint map' })
    root() {
        return {
            name: 'ParaYield Lab — Bifrost DeFi Indexer & Backtest Engine',
            version: '1.0.0',
            docs: '/api/v1/api-docs',
            endpoints: {
                health: 'GET /api/v1/health',
                indexer: {
                    status: 'GET /api/v1/indexer/status',
                    backfill: 'POST /api/v1/indexer/backfill [ADMIN]',
                    sync: 'POST /api/v1/indexer/sync [ADMIN]',
                },
                apy: {
                    assets: 'GET /api/v1/apy/assets',
                    history: 'GET /api/v1/apy/:asset/history',
                    current: 'GET /api/v1/apy/:asset/current',
                    compute: 'POST /api/v1/apy/:asset/compute [ADMIN]',
                },
                backtest: {
                    submit: 'POST /api/v1/backtest/run',
                    result: 'GET /api/v1/backtest/:runId',
                    list: 'GET /api/v1/backtest',
                    presets: [
                        'POST /api/v1/backtest/presets/vdot-only',
                        'POST /api/v1/backtest/presets/multi-vtoken',
                    ],
                },
            },
        };
    }
}
