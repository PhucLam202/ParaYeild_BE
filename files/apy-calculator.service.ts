import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import { VTokenExchangeRate, FarmingPoolSnapshot, ApySnapshot, TokenPrice } from '../../schemas';
import { BIFROST_CONFIG, PRICE_CONFIG } from '../../config/bifrost.config';

@Injectable()
export class ApyCalculatorService {
  private readonly logger = new Logger(ApyCalculatorService.name);
  private priceCache = new Map<string, { price: number; fetchedAt: number }>();

  constructor(
    @InjectModel(VTokenExchangeRate.name)
    private vtokenRateModel: Model<VTokenExchangeRate>,
    @InjectModel(FarmingPoolSnapshot.name)
    private farmingModel: Model<FarmingPoolSnapshot>,
    @InjectModel(ApySnapshot.name)
    private apyModel: Model<ApySnapshot>,
    @InjectModel(TokenPrice.name)
    private priceModel: Model<TokenPrice>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Cron: tính APY mỗi giờ từ dữ liệu vừa index
  // ─────────────────────────────────────────────────────────────
  @Cron('5 * * * *') // chạy 5 phút sau mỗi giờ (sau khi indexer xong)
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

  // ─────────────────────────────────────────────────────────────
  // Core: Tính APY cho một vToken asset
  //
  // LOGIC:
  //   Staking APY = (rate_now / rate_7daysAgo)^(365/7) - 1
  //   Farming APR = (rewardPerBlock * blocksPerYear * rewardPriceUsd) / (tvlUsd)
  //   Total APY   = (1 + StakingAPY) * (1 + FarmingAPR) - 1 (compound)
  // ─────────────────────────────────────────────────────────────
  async computeApyForAsset(tokenSymbol: string, coingeckoId: string): Promise<void> {
    // Lấy rate hiện tại (latest record)
    const latest = await this.vtokenRateModel
      .findOne({ tokenSymbol })
      .sort({ blockNumber: -1 })
      .lean();

    if (!latest) {
      this.logger.warn(`No exchange rate data for ${tokenSymbol}`);
      return;
    }

    // Lấy rate 7 ngày trước (7 * 24 = 168 blocks hourly snapshots)
    const sevenDaysAgo = new Date(latest.timestamp.getTime() - 7 * 24 * 60 * 60 * 1000);
    const rate7d = await this.vtokenRateModel
      .findOne({ tokenSymbol, timestamp: { $lte: sevenDaysAgo } })
      .sort({ timestamp: -1 })
      .lean();

    // Lấy rate 30 ngày trước
    const thirtyDaysAgo = new Date(latest.timestamp.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rate30d = await this.vtokenRateModel
      .findOne({ tokenSymbol, timestamp: { $lte: thirtyDaysAgo } })
      .sort({ timestamp: -1 })
      .lean();

    // ── Tính Staking APY từ exchange rate appreciation ──
    //
    // Ví dụ: vDOT rate tăng từ 1.40 → 1.43 trong 7 ngày
    // Weekly return = 1.43/1.40 - 1 = 2.14%
    // Annual APY = (1 + 0.0214)^(365/7) - 1 ≈ 19.2%
    const currentRate = latest.exchangeRateHuman;

    let apy7d = 0;
    let apy30d = 0;

    if (rate7d && rate7d.exchangeRateHuman > 0 && currentRate > rate7d.exchangeRateHuman) {
      const daysDiff = (latest.timestamp.getTime() - rate7d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
      const periodReturn = currentRate / rate7d.exchangeRateHuman - 1;
      apy7d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
    }

    if (rate30d && rate30d.exchangeRateHuman > 0 && currentRate > rate30d.exchangeRateHuman) {
      const daysDiff = (latest.timestamp.getTime() - rate30d.timestamp.getTime()) / (1000 * 60 * 60 * 24);
      const periodReturn = currentRate / rate30d.exchangeRateHuman - 1;
      apy30d = Math.pow(1 + periodReturn, 365 / daysDiff) - 1;
    }

    // Dùng 7d APY nếu có, fallback về 30d, fallback về 0
    const stakingApyPercent = (apy7d || apy30d) * 100;

    // ── Lấy giá USD của base token ──
    const baseTokenPriceUsd = await this.getTokenPrice(coingeckoId);

    // ── Tính Farming APR ──
    // TODO: Kết hợp với farming pool data
    const farmingAprPercent = 0; // Implement sau

    // ── Tổng APY (compound) ──
    const stakingApy = stakingApyPercent / 100;
    const farmingApr = farmingAprPercent / 100;
    const totalApy = (1 + stakingApy) * (1 + farmingApr) - 1;
    const totalApyPercent = totalApy * 100;

    // ── Save APY snapshot ──
    await this.apyModel.updateOne(
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
        },
      },
      { upsert: true },
    );

    this.logger.debug(
      `${tokenSymbol} APY: staking=${stakingApyPercent.toFixed(2)}% | 7d=${(apy7d * 100).toFixed(2)}% | rate=${currentRate.toFixed(6)}`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Get APY history cho API response
  // ─────────────────────────────────────────────────────────────
  async getApyHistory(
    asset: string,
    from: Date,
    to: Date,
    granularity: 'hourly' | 'daily' = 'daily',
  ) {
    const query: any = {
      asset,
      granularity,
      timestamp: { $gte: from, $lte: to },
    };

    const snapshots = await this.apyModel
      .find(query)
      .sort({ timestamp: 1 })
      .lean();

    return snapshots.map((s) => ({
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

  // ─────────────────────────────────────────────────────────────
  // Lấy giá token từ DeFiLlama (free, no API key, reliable)
  // Fallback: CoinGecko
  // ─────────────────────────────────────────────────────────────
  async getTokenPrice(coingeckoId: string): Promise<number> {
    const cached = this.priceCache.get(coingeckoId);
    if (cached && Date.now() - cached.fetchedAt < PRICE_CONFIG.PRICE_CACHE_TTL_MS) {
      return cached.price;
    }

    try {
      // DeFiLlama coin price API (gratis, reliable)
      const coinKey = `coingecko:${coingeckoId}`;
      const resp = await axios.get(
        `${PRICE_CONFIG.DEFILLAMA_BASE_URL}/prices/current/${coinKey}`,
        { timeout: 5000 },
      );
      const price = resp.data?.coins?.[coinKey]?.price ?? 0;

      if (price > 0) {
        this.priceCache.set(coingeckoId, { price, fetchedAt: Date.now() });
        // Lưu vào DB cho historical reference
        await this.priceModel.updateOne(
          { symbol: coingeckoId, timestamp: new Date(Math.floor(Date.now() / 3600000) * 3600000) },
          { $set: { symbol: coingeckoId, priceUsd: price, source: 'defillama' } },
          { upsert: true },
        );
        return price;
      }
    } catch (e) {
      this.logger.warn(`DeFiLlama price fetch failed for ${coingeckoId}: ${e.message}`);
    }

    // Fallback: CoinGecko
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
      this.logger.warn(`CoinGecko price fetch failed for ${coingeckoId}: ${e.message}`);
    }

    // Last resort: dùng giá cuối cùng trong DB
    const lastPrice = await this.priceModel
      .findOne({ symbol: coingeckoId })
      .sort({ timestamp: -1 })
      .lean();
    return lastPrice?.priceUsd ?? 0;
  }

  // ─────────────────────────────────────────────────────────────
  // Lấy historical prices (từ DeFiLlama historical API)
  // Dùng để backfill price data cho backtesting
  // ─────────────────────────────────────────────────────────────
  async fetchHistoricalPrices(coingeckoId: string, fromTimestamp: number, toTimestamp: number) {
    this.logger.log(`Fetching historical prices for ${coingeckoId}...`);
    const coinKey = `coingecko:${coingeckoId}`;

    try {
      // DeFiLlama historical chart API
      const resp = await axios.get(
        `${PRICE_CONFIG.DEFILLAMA_BASE_URL}/chart/${coinKey}?start=${fromTimestamp}&end=${toTimestamp}&span=1&period=1d`,
        { timeout: 30000 },
      );

      const prices: Array<{ timestamp: number; price: number }> = resp.data?.coins?.[coinKey]?.prices ?? [];

      if (prices.length === 0) {
        this.logger.warn(`No historical price data for ${coingeckoId}`);
        return 0;
      }

      // Bulk upsert vào MongoDB
      const ops = prices.map((p) => ({
        updateOne: {
          filter: {
            symbol: coingeckoId,
            timestamp: new Date(p.timestamp * 1000),
          },
          update: {
            $set: {
              symbol: coingeckoId,
              priceUsd: p.price,
              source: 'defillama',
              timestamp: new Date(p.timestamp * 1000),
            },
          },
          upsert: true,
        },
      }));

      await this.priceModel.bulkWrite(ops);
      this.logger.log(`Saved ${prices.length} historical prices for ${coingeckoId}`);
      return prices.length;
    } catch (e) {
      this.logger.error(`Historical price fetch failed: ${e.message}`);
      return 0;
    }
  }
}
