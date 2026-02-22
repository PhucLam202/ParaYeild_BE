import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ApySnapshot, BacktestRun, TokenPrice } from '../../schemas';

// ─────────────────────────────────────────────────────────────
// Strategy config: user định nghĩa chiến lược muốn backtest
// ─────────────────────────────────────────────────────────────
export interface StrategyConfig {
  assets: string[];           // ["vDOT", "vKSM"]
  allocation: number[];       // [70, 30] → phải sum = 100
  startDate: string;          // "2023-06-01"
  endDate: string;            // "2024-01-01"
  initialAmountUsd: number;   // 10000
  includeFarming: boolean;    // có include farming rewards không
  rebalanceIntervalDays: number; // 0 = không rebalance, 30 = rebalance mỗi tháng
  compoundFrequencyDays: number; // 1 = daily compound, 7 = weekly
}

export interface BacktestResult {
  runId: string;
  status: string;
  strategy: StrategyConfig;
  results: {
    finalValueUsd: number;
    netPnlUsd: number;
    netPnlPercent: number;
    stakingRewardsUsd: number;
    farmingRewardsUsd: number;
    totalApyRealized: number;
    sharpeRatio: number;
    maxDrawdownPercent: number;
    totalDays: number;
  };
  timeSeries: Array<{
    date: string;
    portfolioValueUsd: number;
    cumulativeRewardsUsd: number;
    exchangeRates: Record<string, number>;
    dailyReturnPercent: number;
  }>;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @InjectModel(ApySnapshot.name)
    private apyModel: Model<ApySnapshot>,
    @InjectModel(BacktestRun.name)
    private backtestRunModel: Model<BacktestRun>,
    @InjectModel(TokenPrice.name)
    private priceModel: Model<TokenPrice>,
  ) {}

  // ─────────────────────────────────────────────────────────────
  // Submit backtest job (async)
  // ─────────────────────────────────────────────────────────────
  async submitBacktest(strategy: StrategyConfig): Promise<{ runId: string }> {
    // Validate strategy
    this.validateStrategy(strategy);

    const runId = uuidv4();
    await this.backtestRunModel.create({
      runId,
      strategy,
      status: 'pending',
    });

    // Chạy async (không await)
    this.runSimulation(runId, strategy).catch((err) => {
      this.logger.error(`Backtest ${runId} failed: ${err.message}`);
      this.backtestRunModel.updateOne(
        { runId },
        { status: 'error', errorMessage: err.message },
      );
    });

    return { runId };
  }

  // ─────────────────────────────────────────────────────────────
  // Core simulation engine
  //
  // LOGIC:
  //   1. Load APY snapshots cho time range
  //   2. Simulation loop: ngày nào cũng compound, rebalance theo interval
  //   3. Track position values, rewards, drawdown
  //   4. Output time series + summary stats
  // ─────────────────────────────────────────────────────────────
  async runSimulation(runId: string, strategy: StrategyConfig): Promise<void> {
    const startTime = Date.now();

    await this.backtestRunModel.updateOne({ runId }, { status: 'running' });

    const from = new Date(strategy.startDate);
    const to = new Date(strategy.endDate);

    // ── 1. Load APY data cho tất cả assets ──
    const apyDataMap: Record<string, any[]> = {};

    for (const asset of strategy.assets) {
      const snapshots = await this.apyModel
        .find({
          asset,
          timestamp: { $gte: from, $lte: to },
          granularity: 'daily',
        })
        .sort({ timestamp: 1 })
        .lean();

      if (snapshots.length === 0) {
        // Fallback: dùng hourly data nếu chưa có daily
        const hourlySnapshots = await this.apyModel
          .find({
            asset,
            timestamp: { $gte: from, $lte: to },
          })
          .sort({ timestamp: 1 })
          .lean();

        apyDataMap[asset] = this.aggregateToDaily(hourlySnapshots);
      } else {
        apyDataMap[asset] = snapshots;
      }
    }

    // ── 2. Khởi tạo positions ──
    const totalUsd = strategy.initialAmountUsd;
    const positions: Record<string, {
      valueUsd: number;       // current value
      cumulativeRewards: number;
      exchangeRate: number;   // entry exchange rate
      vTokenAmount: number;   // số vToken đang hold
    }> = {};

    // Phân bổ vốn ban đầu
    for (let i = 0; i < strategy.assets.length; i++) {
      const asset = strategy.assets[i];
      const allocation = strategy.allocation[i] / 100;
      const allocatedUsd = totalUsd * allocation;

      // Lấy exchange rate đầu kỳ
      const firstSnapshot = apyDataMap[asset]?.[0];
      const entryRate = firstSnapshot?.exchangeRateHuman ?? 1.0;

      positions[asset] = {
        valueUsd: allocatedUsd,
        cumulativeRewards: 0,
        exchangeRate: entryRate,
        vTokenAmount: allocatedUsd / (firstSnapshot?.baseTokenPriceUsd ?? 1) / entryRate,
      };
    }

    // ── 3. Simulation loop ──
    const timeSeries: BacktestResult['timeSeries'] = [];
    let lastRebalanceDate = from;
    const dailyReturns: number[] = [];
    let peakValue = totalUsd;
    let maxDrawdown = 0;

    // Generate daily timestamps
    const allDates = this.generateDailyDates(from, to);

    for (const currentDate of allDates) {
      let dailyPortfolioValue = 0;
      let dailyRewardAccrued = 0;
      const currentRates: Record<string, number> = {};

      for (const asset of strategy.assets) {
        const dayData = this.getSnapshotForDate(apyDataMap[asset], currentDate);
        if (!dayData) continue;

        const pos = positions[asset];
        const dailyApy = (dayData.totalApyPercent / 100) / 365;

        // Compound daily
        if (strategy.compoundFrequencyDays <= 1) {
          const dailyReturn = pos.valueUsd * dailyApy;
          pos.valueUsd += dailyReturn;
          pos.cumulativeRewards += dailyReturn;
          dailyRewardAccrued += dailyReturn;
        }

        // Cập nhật exchange rate tracking
        currentRates[asset] = dayData.exchangeRateHuman;

        // Cập nhật value dựa trên price change của base token
        // (vToken value = số vToken * exchange rate * DOT price)
        if (dayData.baseTokenPriceUsd > 0) {
          // Adjust for price movement (nếu DOT tăng 5%, portfolio tăng 5%)
          // Simplified: assume entry price captured in initialValueUsd
        }

        dailyPortfolioValue += pos.valueUsd;
      }

      // ── Rebalance check ──
      const daysSinceRebalance = Math.floor(
        (currentDate.getTime() - lastRebalanceDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (
        strategy.rebalanceIntervalDays > 0 &&
        daysSinceRebalance >= strategy.rebalanceIntervalDays
      ) {
        this.rebalancePositions(positions, strategy);
        lastRebalanceDate = currentDate;
      }

      // ── Track metrics ──
      if (dailyPortfolioValue > peakValue) peakValue = dailyPortfolioValue;
      const drawdown = (peakValue - dailyPortfolioValue) / peakValue;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      const prevValue = timeSeries[timeSeries.length - 1]?.portfolioValueUsd ?? totalUsd;
      const dailyReturnPct = prevValue > 0 ? (dailyPortfolioValue - prevValue) / prevValue : 0;
      dailyReturns.push(dailyReturnPct);

      timeSeries.push({
        date: currentDate.toISOString().split('T')[0],
        portfolioValueUsd: parseFloat(dailyPortfolioValue.toFixed(2)),
        cumulativeRewardsUsd: parseFloat(
          Object.values(positions).reduce((s, p) => s + p.cumulativeRewards, 0).toFixed(2),
        ),
        exchangeRates: currentRates,
        dailyReturnPercent: parseFloat((dailyReturnPct * 100).toFixed(4)),
      });
    }

    // ── 4. Calculate summary stats ──
    const finalValue = Object.values(positions).reduce((s, p) => s + p.valueUsd, 0);
    const netPnl = finalValue - totalUsd;
    const netPnlPercent = (netPnl / totalUsd) * 100;
    const totalDays = allDates.length;

    // Annualized APY realized
    const totalApyRealized = totalDays > 0
      ? (Math.pow(finalValue / totalUsd, 365 / totalDays) - 1) * 100
      : 0;

    // Sharpe Ratio = (mean daily return - risk free) / std dev
    // Assume risk free = 0 (DeFi comparison)
    const sharpeRatio = this.computeSharpeRatio(dailyReturns);

    const totalRewards = Object.values(positions).reduce(
      (s, p) => s + p.cumulativeRewards,
      0,
    );

    const results = {
      finalValueUsd: parseFloat(finalValue.toFixed(2)),
      netPnlUsd: parseFloat(netPnl.toFixed(2)),
      netPnlPercent: parseFloat(netPnlPercent.toFixed(4)),
      stakingRewardsUsd: parseFloat(totalRewards.toFixed(2)),
      farmingRewardsUsd: 0, // TODO
      totalApyRealized: parseFloat(totalApyRealized.toFixed(4)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
      maxDrawdownPercent: parseFloat((maxDrawdown * 100).toFixed(4)),
      totalDays,
    };

    await this.backtestRunModel.updateOne(
      { runId },
      {
        status: 'done',
        results,
        timeSeries: timeSeries.slice(0, 500), // Limit để tránh document size limit
        executionTimeMs: Date.now() - startTime,
      },
    );

    this.logger.log(
      `Backtest ${runId} done: APY=${totalApyRealized.toFixed(2)}% | Sharpe=${sharpeRatio.toFixed(2)} | ${Date.now() - startTime}ms`,
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────

  private rebalancePositions(
    positions: Record<string, any>,
    strategy: StrategyConfig,
  ) {
    const totalValue = Object.values(positions).reduce((s: number, p: any) => s + p.valueUsd, 0);
    for (let i = 0; i < strategy.assets.length; i++) {
      const asset = strategy.assets[i];
      positions[asset].valueUsd = totalValue * (strategy.allocation[i] / 100);
    }
  }

  private generateDailyDates(from: Date, to: Date): Date[] {
    const dates: Date[] = [];
    const current = new Date(from);
    while (current <= to) {
      dates.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return dates;
  }

  private getSnapshotForDate(snapshots: any[], date: Date): any | null {
    if (!snapshots || snapshots.length === 0) return null;
    // Tìm snapshot gần nhất với date (linear search, optimize nếu cần)
    const dateStr = date.toISOString().split('T')[0];
    return (
      snapshots.find((s) => new Date(s.timestamp).toISOString().split('T')[0] === dateStr) ??
      snapshots[snapshots.length - 1] // fallback: dùng snapshot cuối cùng có
    );
  }

  private aggregateToDaily(hourlySnapshots: any[]): any[] {
    const grouped = new Map<string, any[]>();
    for (const s of hourlySnapshots) {
      const day = new Date(s.timestamp).toISOString().split('T')[0];
      if (!grouped.has(day)) grouped.set(day, []);
      grouped.get(day).push(s);
    }

    return Array.from(grouped.entries()).map(([day, snaps]) => ({
      timestamp: new Date(day),
      totalApyPercent: snaps.reduce((s, x) => s + x.totalApyPercent, 0) / snaps.length,
      stakingApyPercent: snaps.reduce((s, x) => s + x.stakingApyPercent, 0) / snaps.length,
      farmingAprPercent: snaps.reduce((s, x) => s + x.farmingAprPercent, 0) / snaps.length,
      exchangeRateHuman: snaps[snaps.length - 1].exchangeRateHuman,
      baseTokenPriceUsd: snaps[snaps.length - 1].baseTokenPriceUsd,
    }));
  }

  private computeSharpeRatio(dailyReturns: number[]): number {
    if (dailyReturns.length < 2) return 0;
    const mean = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const variance =
      dailyReturns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (dailyReturns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return 0;
    // Annualized Sharpe
    return (mean / stdDev) * Math.sqrt(365);
  }

  private validateStrategy(strategy: StrategyConfig) {
    if (!strategy.assets?.length) throw new Error('assets is required');
    if (strategy.assets.length !== strategy.allocation.length) {
      throw new Error('assets and allocation must have same length');
    }
    const total = strategy.allocation.reduce((s, a) => s + a, 0);
    if (Math.abs(total - 100) > 0.01) throw new Error('allocation must sum to 100');
    if (new Date(strategy.startDate) >= new Date(strategy.endDate)) {
      throw new Error('startDate must be before endDate');
    }
    if (strategy.initialAmountUsd <= 0) throw new Error('initialAmountUsd must be positive');
  }

  // ─────────────────────────────────────────────────────────────
  // Get backtest result
  // ─────────────────────────────────────────────────────────────
  async getResult(runId: string): Promise<BacktestRun> {
    return this.backtestRunModel.findOne({ runId }).lean() as any;
  }

  async listRuns(limit = 20) {
    return this.backtestRunModel
      .find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('-timeSeries') // Exclude large field
      .lean();
  }
}
