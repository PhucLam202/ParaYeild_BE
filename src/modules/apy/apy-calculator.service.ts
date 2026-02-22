import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import {
    VTokenExchangeRate,
    FarmingPoolSnapshot,
    ApySnapshot,
    TokenPrice,
} from '../../entities';
import { BIFROST_CONFIG, PRICE_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class ApyCalculatorService {
    private readonly logger = new Logger(ApyCalculatorService.name);
    private priceCache = new Map<string, { price: number; fetchedAt: number }>();

    constructor(
        @InjectRepository(VTokenExchangeRate)
        private vtokenRateRepo: MongoRepository<VTokenExchangeRate>,
        @InjectRepository(FarmingPoolSnapshot)
        private farmingRepo: MongoRepository<FarmingPoolSnapshot>,
        @InjectRepository(ApySnapshot)
        private apyRepo: MongoRepository<ApySnapshot>,
        @InjectRepository(TokenPrice)
        private priceRepo: MongoRepository<TokenPrice>,
    ) { }

    // ─── Cron: tính APY mỗi giờ ───
    @Cron('5 * * * *')
    async computeHourlyApy() {
        this.logger.log('Computing hourly APY snapshots...');
        for (const [symbol, config] of Object.entries(BIFROST_CONFIG.VTOKENS)) {
            try {
                await this.computeApyForAsset(symbol, config.coingeckoId);
            } catch (err) {
                this.logger.error(`APY computation failed for ${symbol}: ${err.message}`);
            }
        }
    }

    // ─── Core: tính APY cho một vToken ───
    async computeApyForAsset(tokenSymbol: string, coingeckoId: string): Promise<void> {
        const latest = await this.vtokenRateRepo.findOne({
            where: { tokenSymbol },
            order: { blockNumber: 'DESC' },
        });

        if (!latest) {
            this.logger.warn(`No exchange rate data for ${tokenSymbol}`);
            return;
        }

        const sevenDaysAgo = new Date(latest.timestamp.getTime() - 7 * 24 * 60 * 60 * 1000);
        const rate7d = await this.vtokenRateRepo.findOne({
            where: {
                tokenSymbol,
                timestamp: { $lte: sevenDaysAgo } as any,
            },
            order: { timestamp: 'DESC' },
        });

        const thirtyDaysAgo = new Date(latest.timestamp.getTime() - 30 * 24 * 60 * 60 * 1000);
        const rate30d = await this.vtokenRateRepo.findOne({
            where: {
                tokenSymbol,
                timestamp: { $lte: thirtyDaysAgo } as any,
            },
            order: { timestamp: 'DESC' },
        });

        const currentRate = latest.exchangeRateHuman;
        let apy7d = 0;
        let apy30d = 0;

        if (rate7d && rate7d.exchangeRateHuman > 0 && currentRate > rate7d.exchangeRateHuman) {
            const daysDiff =
                (latest.timestamp.getTime() - rate7d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
            const periodReturn = currentRate / rate7d.exchangeRateHuman - 1;
            apy7d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
        }

        if (rate30d && rate30d.exchangeRateHuman > 0 && currentRate > rate30d.exchangeRateHuman) {
            const daysDiff =
                (latest.timestamp.getTime() - rate30d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
            const periodReturn = currentRate / rate30d.exchangeRateHuman - 1;
            apy30d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
        }

        const stakingApyPercent = (apy7d || apy30d) * 100;
        const baseTokenPriceUsd = await this.getTokenPrice(coingeckoId);
        const farmingAprPercent = 0;

        const stakingApy = stakingApyPercent / 100;
        const farmingApr = farmingAprPercent / 100;
        const totalApy = (1 + stakingApy) * (1 + farmingApr) - 1;
        const totalApyPercent = totalApy * 100;

        await this.apyRepo.updateOne(
            {
                asset: tokenSymbol,
                blockNumber: latest.blockNumber,
                granularity: 'hourly',
            },
            {
                $set: {
                    asset: tokenSymbol,
                    timestamp: latest.timestamp,
                    blockNumber: latest.blockNumber,
                    stakingApyPercent: parseFloat(stakingApyPercent.toFixed(4)),
                    farmingAprPercent: parseFloat(farmingAprPercent.toFixed(4)),
                    totalApyPercent: parseFloat(totalApyPercent.toFixed(4)),
                    apy7d: parseFloat((apy7d * 100).toFixed(4)),
                    apy30d: parseFloat((apy30d * 100).toFixed(4)),
                    exchangeRateHuman: currentRate,
                    baseTokenPriceUsd,
                    chain: BIFROST_CONFIG.CHAIN,
                    granularity: 'hourly',
                    createdAt: new Date(),
                },
            },
            { upsert: true },
        );

        this.logger.debug(
            `${tokenSymbol} APY: staking=${stakingApyPercent.toFixed(2)}% | 7d=${(apy7d * 100).toFixed(2)}%`,
        );
    }

    // ─── Retroactive Historical Backfill ───
    async backfillApyHistory(tokenSymbol: string, coingeckoId: string): Promise<number> {
        this.logger.log(`Starting historical APY backfill for ${tokenSymbol}...`);

        // Find all rates ordered by time
        const allRates = await this.vtokenRateRepo.find({
            where: { tokenSymbol },
            order: { timestamp: 'ASC' }
        });

        let count = 0;
        const baseTokenPriceUsd = await this.getTokenPrice(coingeckoId);

        // Deduplicate to save roughly ~1 point per day to avoid huge DB writes for historic data
        const dailyMap = new Map<string, any>();
        for (const r of allRates) {
            const dateStr = r.timestamp.toISOString().split('T')[0];
            dailyMap.set(dateStr, r);
        }
        const dailyRates = Array.from(dailyMap.values());

        // Prepare bulk operations for performance
        const bulkOps = [];

        for (let i = 0; i < dailyRates.length; i++) {
            const current = dailyRates[i];
            const currentRate = current.exchangeRateHuman;

            // Find 7d ago
            const sevenDaysAgoTime = current.timestamp.getTime() - 7 * 24 * 60 * 60 * 1000;
            const rate7d = allRates.filter(r => r.timestamp.getTime() <= sevenDaysAgoTime).pop();

            // Find 30d ago
            const thirtyDaysAgoTime = current.timestamp.getTime() - 30 * 24 * 60 * 60 * 1000;
            const rate30d = allRates.filter(r => r.timestamp.getTime() <= thirtyDaysAgoTime).pop();

            let apy7d = 0;
            let apy30d = 0;

            if (rate7d && rate7d.exchangeRateHuman > 0 && currentRate > rate7d.exchangeRateHuman) {
                const daysDiff = (current.timestamp.getTime() - rate7d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
                const periodReturn = currentRate / rate7d.exchangeRateHuman - 1;
                apy7d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
            }

            if (rate30d && rate30d.exchangeRateHuman > 0 && currentRate > rate30d.exchangeRateHuman) {
                const daysDiff = (current.timestamp.getTime() - rate30d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
                const periodReturn = currentRate / rate30d.exchangeRateHuman - 1;
                apy30d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
            }

            const stakingApyPercent = (apy7d || apy30d) * 100;
            const farmingAprPercent = 0; // TODO: Implement Farming crawler history

            // Only insert APY records that actually have enough history to compute an active APY
            if (stakingApyPercent > 0) {
                const stakingApy = stakingApyPercent / 100;
                const farmingApr = farmingAprPercent / 100;
                const totalApy = (1 + stakingApy) * (1 + farmingApr) - 1;
                const totalApyPercent = totalApy * 100;

                bulkOps.push({
                    updateOne: {
                        filter: {
                            asset: tokenSymbol,
                            timestamp: current.timestamp,
                            granularity: 'hourly',
                        },
                        update: {
                            $set: {
                                asset: tokenSymbol,
                                timestamp: current.timestamp,
                                blockNumber: current.blockNumber,
                                stakingApyPercent: parseFloat(stakingApyPercent.toFixed(4)),
                                farmingAprPercent: parseFloat(farmingAprPercent.toFixed(4)),
                                totalApyPercent: parseFloat(totalApyPercent.toFixed(4)),
                                apy7d: parseFloat((apy7d * 100).toFixed(4)),
                                apy30d: parseFloat((apy30d * 100).toFixed(4)),
                                exchangeRateHuman: currentRate,
                                baseTokenPriceUsd,
                                chain: current.chain,
                                granularity: 'hourly',
                                createdAt: new Date(),
                            }
                        },
                        upsert: true
                    }
                });
                count++;
            }
        }

        if (bulkOps.length > 0) {
            await this.apyRepo.bulkWrite(bulkOps);
        }

        this.logger.log(`Backfilled ${count} historical APY records for ${tokenSymbol}`);
        return count;
    }

    // ─── Get APY history cho API response ───
    async getApyHistory(
        asset: string,
        from: Date,
        to: Date,
        granularity: 'hourly' | 'daily' = 'daily',
    ) {
        // Currently we only generate 'hourly' snapshots in computeApyForAsset
        const snapshots = await this.apyRepo.find({
            where: {
                asset,
                granularity: 'hourly', // Always fetch hourly backing data
                timestamp: { $gte: from, $lte: to } as any,
            },
            order: { timestamp: 'ASC' },
        });

        let filteredSnapshots = snapshots;

        if (granularity === 'daily') {
            // Group by day (YYYY-MM-DD) and take the last available snapshot for that day
            const dailyMap = new Map<string, any>();
            for (const s of snapshots) {
                const dateStr = s.timestamp.toISOString().split('T')[0];
                // Overwriting the map will leave the latest hour of the day
                dailyMap.set(dateStr, s);
            }
            filteredSnapshots = Array.from(dailyMap.values());
        }

        return filteredSnapshots.map((s) => ({
            timestamp: s.timestamp,
            blockNumber: s.blockNumber,
            stakingApy: s.stakingApyPercent,
            farmingApr: s.farmingAprPercent,
            totalApy: s.totalApyPercent,
            apy7d: s.apy7d,
            apy30d: s.apy30d,
            exchangeRate: s.exchangeRateHuman,
            baseTokenPriceUsd: s.baseTokenPriceUsd,
        }));
    }

    // ─── Lấy giá token từ DeFiLlama (free) → CoinGecko fallback → DB ───
    async getTokenPrice(coingeckoId: string): Promise<number> {
        const cached = this.priceCache.get(coingeckoId);
        if (cached && Date.now() - cached.fetchedAt < PRICE_CONFIG.PRICE_CACHE_TTL_MS) {
            return cached.price;
        }

        try {
            const coinKey = `coingecko:${coingeckoId}`;
            const resp = await axios.get(
                `${PRICE_CONFIG.DEFILLAMA_BASE_URL}/prices/current/${coinKey}`,
                { timeout: 5000 },
            );
            const price = resp.data?.coins?.[coinKey]?.price ?? 0;
            if (price > 0) {
                this.priceCache.set(coingeckoId, { price, fetchedAt: Date.now() });
                await this.priceRepo.updateOne(
                    { symbol: coingeckoId, timestamp: new Date(Math.floor(Date.now() / 3600000) * 3600000) },
                    { $set: { symbol: coingeckoId, priceUsd: price, source: 'defillama', createdAt: new Date() } },
                    { upsert: true },
                );
                return price;
            }
        } catch (e) {
            this.logger.warn(`DeFiLlama price fetch failed for ${coingeckoId}: ${e.message}`);
        }

        try {
            const resp = await axios.get(
                `${PRICE_CONFIG.COINGECKO_BASE_URL}/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
                { timeout: 5000 },
            );
            const price = resp.data?.[coingeckoId]?.usd ?? 0;
            if (price > 0) {
                this.priceCache.set(coingeckoId, { price, fetchedAt: Date.now() });
                return price;
            }
        } catch (e) {
            this.logger.warn(`CoinGecko price fetch failed: ${e.message}`);
        }

        const lastPrice = await this.priceRepo.findOne({
            where: { symbol: coingeckoId },
            order: { timestamp: 'DESC' },
        });
        return lastPrice?.priceUsd ?? 0;
    }

    // ─── Bulk backfill historical prices từ DeFiLlama ───
    async fetchHistoricalPrices(
        coingeckoId: string,
        fromTimestamp: number,
        toTimestamp: number,
    ): Promise<number> {
        this.logger.log(`Fetching historical prices for ${coingeckoId}...`);
        const coinKey = `coingecko:${coingeckoId}`;

        try {
            const resp = await axios.get(
                `${PRICE_CONFIG.DEFILLAMA_BASE_URL}/chart/${coinKey}?start=${fromTimestamp}&end=${toTimestamp}&span=1&period=1d`,
                { timeout: 30000 },
            );

            const prices: Array<{ timestamp: number; price: number }> =
                resp.data?.coins?.[coinKey]?.prices ?? [];
            if (!prices.length) return 0;

            const ops = prices.map((p) => ({
                updateOne: {
                    filter: { symbol: coingeckoId, timestamp: new Date(p.timestamp * 1000) },
                    update: {
                        $set: { symbol: coingeckoId, priceUsd: p.price, source: 'defillama', timestamp: new Date(p.timestamp * 1000), createdAt: new Date() },
                    },
                    upsert: true,
                },
            }));

            await this.priceRepo.bulkWrite(ops);
            this.logger.log(`Saved ${prices.length} historical prices for ${coingeckoId}`);
            return prices.length;
        } catch (e) {
            this.logger.error(`Historical price fetch failed: ${e.message}`);
            return 0;
        }
    }

    // ─── Lấy APY mới nhất của tất cả pools ───
    async getAllPoolsApy() {
        const vtokens = Object.values(BIFROST_CONFIG.VTOKENS);
        const results = [];

        for (const config of vtokens) {
            try {
                const latest = await this.apyRepo.findOne({
                    where: { asset: config.symbol, granularity: 'hourly' },
                    order: { timestamp: 'DESC' },
                });

                const latestRate = await this.vtokenRateRepo.findOne({
                    where: { tokenSymbol: config.symbol },
                    order: { blockNumber: 'DESC' },
                });

                if (!latest && !latestRate) {
                    results.push({
                        asset: config.symbol,
                        baseToken: config.baseToken,
                        chain: BIFROST_CONFIG.CHAIN,
                        status: 'no_data',
                        message: 'Run indexer first',
                    });
                    continue;
                }

                results.push({
                    asset: config.symbol,
                    baseToken: config.baseToken,
                    chain: BIFROST_CONFIG.CHAIN,
                    currentExchangeRate: latestRate?.exchangeRateHuman ?? null,
                    baseTokenPriceUsd: latest?.baseTokenPriceUsd ?? 0,
                    apyPercent: {
                        staking7d: latest?.apy7d ?? 0,
                        staking30d: latest?.apy30d ?? 0,
                        farming: latest?.farmingAprPercent ?? 0,
                        total: latest?.totalApyPercent ?? 0,
                    },
                    lastUpdated: latest?.timestamp ?? latestRate?.timestamp ?? null,
                });
            } catch (err) {
                this.logger.error(`getAllPoolsApy failed for ${config.symbol}: ${err.message}`);
                results.push({
                    asset: config.symbol,
                    baseToken: config.baseToken,
                    chain: BIFROST_CONFIG.CHAIN,
                    status: 'error',
                });
            }
        }

        return results;
    }
}
