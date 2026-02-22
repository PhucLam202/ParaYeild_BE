import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import axios from 'axios';
import { TokenPrice } from '../../entities';
import { PRICE_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class PriceIndexerService {
    private readonly logger = new Logger(PriceIndexerService.name);
    private priceCache = new Map<string, { price: number; fetchedAt: number }>();

    constructor(
        @InjectRepository(TokenPrice)
        private priceRepo: MongoRepository<TokenPrice>,
    ) { }

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
}
