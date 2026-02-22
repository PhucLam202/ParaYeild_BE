import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { SimulationService, PoolData } from './simulation.service';

describe('SimulationService', () => {
    let service: SimulationService;

    // Mock response from the external pools API
    const mockPoolsData: PoolData[] = [
        {
            protocol: 'hydration',
            network: 'polkadot',
            poolType: 'dex',
            assetSymbol: 'HOLLAR',
            totalApy: 30.11,
            tvlUsd: 2000000,
        },
        {
            protocol: 'hydration',
            network: 'polkadot',
            poolType: 'dex',
            assetSymbol: 'aDOT',
            totalApy: 19.07,
            tvlUsd: 1000000,
        },
        {
            protocol: 'moonwell',
            network: 'moonbeam',
            poolType: 'lending',
            assetSymbol: 'GLMR',
            totalApy: 12.5,
            tvlUsd: 5000000,
        },
        {
            protocol: 'bifrost',
            network: 'polkadot',
            poolType: 'vstaking',
            assetSymbol: 'vDOT',
            totalApy: 0, // Edge case: 0 APY
            tvlUsd: 1000000,
        },
    ];

    beforeEach(async () => {
        // Mock the module configuration
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SimulationService,
                {
                    provide: ConfigService,
                    useValue: {
                        get: jest.fn((key: string) => {
                            if (key === 'poolsApiUrl') return 'http://localhost:3000';
                            return null;
                        }),
                    },
                },
            ],
        }).compile();

        service = module.get<SimulationService>(SimulationService);

        // Mock the fetchPools method to return our predefined data
        jest.spyOn(service, 'fetchPools').mockResolvedValue({
            count: mockPoolsData.length,
            filter: {},
            data: mockPoolsData,
        });
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('runSimulation', () => {
        it('TestCase 1: Standard case with 100% allocation to 1 pool for 31 days', async () => {
            const dto = {
                initialAmountUsd: 10000,
                from: '2026-01-01',
                to: '2026-02-01', // 31 days
                allocations: [
                    { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 100 },
                ],
            };

            const result = await service.runSimulation(dto);

            expect(result.summary.initialAmountUsd).toBe(10000);
            expect(result.summary.durationDays).toBe(31);
            expect(result.breakdown.length).toBe(1);
            expect(result.breakdown[0].assetSymbol).toBe('HOLLAR');
            expect(result.breakdown[0].apyUsed).toBe(30.11);
            expect(result.breakdown[0].allocatedUsd).toBe(10000);

            // Calculation check: 10000 * (1 + 0.3011/365)^31 = 10258.91 (approx)
            const expectedFinal = 10000 * Math.pow(1 + 0.3011 / 365, 31);
            expect(result.breakdown[0].finalUsd).toBeCloseTo(expectedFinal, 1);
            expect(result.summary.finalAmountUsd).toBeCloseTo(expectedFinal, 1);
        });

        it('TestCase 2: Multi-pool allocation (60% / 40%) for half a year', async () => {
            const dto = {
                initialAmountUsd: 50000,
                from: '2026-01-01',
                to: '2026-07-01', // ~181 days
                allocations: [
                    { protocol: 'hydration', assetSymbol: 'aDOT', percentage: 60 },
                    { protocol: 'moonwell', assetSymbol: 'GLMR', percentage: 40 },
                ],
            };

            const result = await service.runSimulation(dto);

            expect(result.summary.initialAmountUsd).toBe(50000);
            expect(result.summary.durationDays).toBe(181);
            expect(result.breakdown.length).toBe(2);

            const adot = result.breakdown.find(b => b.assetSymbol === 'aDOT');
            const glmr = result.breakdown.find(b => b.assetSymbol === 'GLMR');

            expect(adot.allocatedUsd).toBe(30000); // 60%
            expect(glmr.allocatedUsd).toBe(20000); // 40%

            expect(result.summary.weightedAvgApyPercent).toBeCloseTo((19.07 * 0.6) + (12.5 * 0.4), 2);
        });

        it('TestCase 3: Validation Error if allocations do not sum to 100%', async () => {
            const dto = {
                initialAmountUsd: 1000,
                from: '2026-01-01',
                to: '2026-02-01',
                allocations: [
                    { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 50 },
                ],
            };

            await expect(service.runSimulation(dto)).rejects.toThrow(BadRequestException);
            await expect(service.runSimulation(dto)).rejects.toThrow('Allocations must sum to 100%');
        });

        it('TestCase 4: Validation Error if "from" date is after "to" date', async () => {
            const dto = {
                initialAmountUsd: 1000,
                from: '2026-02-01',
                to: '2026-01-01',
                allocations: [
                    { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 100 },
                ],
            };

            await expect(service.runSimulation(dto)).rejects.toThrow(BadRequestException);
            await expect(service.runSimulation(dto)).rejects.toThrow('"from" must be before "to"');
        });

        it('TestCase 5: Handle pool missing from data server (returns 0% yield for that pool)', async () => {
            const dto = {
                initialAmountUsd: 10000,
                from: '2026-01-01',
                to: '2026-02-01',
                allocations: [
                    { protocol: 'unknown', assetSymbol: 'UNKNOWN', percentage: 100 },
                ],
            };

            const result = await service.runSimulation(dto);

            // It should gracefully handle this by keeping initial money with 0 return
            expect(result.summary.finalAmountUsd).toBe(10000);
            expect(result.summary.totalReturnUsd).toBe(0);
            expect(result.breakdown[0].warning).toContain('Pool not found');
            expect(result.breakdown[0].apyUsed).toBeNull();
        });

        it('TestCase 6: Simulating a full Leap Year (366 days)', async () => {
            const dto = {
                initialAmountUsd: 1000,
                from: '2024-01-01',
                to: '2025-01-01', // 366 days (2024 is a leap year)
                allocations: [
                    { protocol: 'moonwell', assetSymbol: 'GLMR', percentage: 100 },
                ],
            };

            const result = await service.runSimulation(dto);
            expect(result.summary.durationDays).toBe(366);

            // APY is 12.5%. After 366 days (daily compound), it should be slightly more than 12.5% return
            const expectedReturn = 1000 * Math.pow(1 + 0.125 / 365, 366);
            expect(result.summary.finalAmountUsd).toBeCloseTo(expectedReturn, 2);
        });

        it('TestCase 7: Simulating 0% APY Pool', async () => {
            const dto = {
                initialAmountUsd: 1000,
                from: '2026-01-01',
                to: '2026-12-31',
                allocations: [
                    { protocol: 'bifrost', assetSymbol: 'vDOT', percentage: 100 }, // vDOT APY mocked as 0
                ],
            };

            const result = await service.runSimulation(dto);
            expect(result.breakdown[0].apyUsed).toBe(0);
            expect(result.summary.finalAmountUsd).toBe(1000);
            expect(result.summary.totalReturnPercent).toBe(0);
        });
    });
});
