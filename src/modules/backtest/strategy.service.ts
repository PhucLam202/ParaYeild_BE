import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Interval } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { MongoRepository } from 'typeorm';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { PoolsClientService, PoolSnapshot } from '../../common/services/pools-client.service';
import { StrategyCache } from '../../entities';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StrategyAllocation {
    protocol: string;
    assetSymbol: string;
    percentage: number;
    poolType: string;
    apyMin: number;
    apyMax: number;
    // Live pool detail — populated from pool snapshot after LLM generation
    network?: string;
    tvlUsd?: number;
    currentApy?: number;  // totalApy from live data
    supplyApy?: number;
    rewardApy?: number;
    dataTimestamp?: string;
}

export interface InvestmentChain {
    id: string;
    title: string;
    description: string;
    riskLevel: 'low' | 'medium' | 'high';
    estimatedApyMin: number;
    estimatedApyMax: number;
    allocations: StrategyAllocation[];
}

export interface SuggestStrategiesResult {
    generatedAt: string;
    totalPools: number;
    chains: InvestmentChain[];
}

interface SuggestFilter {
    riskLevel?: 'low' | 'medium' | 'high';
    minApy?: number;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
    data: SuggestStrategiesResult;
    expiresAt: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class StrategyService implements OnModuleInit {
    private readonly logger = new Logger(StrategyService.name);
    private readonly openai: OpenAI | null;
    private readonly CACHE_TTL_MS = 60 * 60 * 1000; // 60 min (cron refresh every 30 min)
    private cache: CacheEntry | null = null;
    /** Shared promise to prevent concurrent LLM calls */
    private refreshPromise: Promise<void> | null = null;

    constructor(
        private readonly poolsClient: PoolsClientService,
        private readonly configService: ConfigService,
        @InjectRepository(StrategyCache)
        private readonly cacheRepo: MongoRepository<StrategyCache>,
    ) {
        const apiKey = this.configService.get<string>('openaiApiKey');
        if (apiKey) {
            this.openai = new OpenAI({ apiKey });
            this.logger.log('OpenAI client initialized');
        } else {
            this.openai = null;
            this.logger.error('OPENAI_API_KEY not set — will use fallback mock strategies');
        }
    }

    /** Load from MongoDB on startup; fall back to LLM if missing/expired */
    async onModuleInit() {
        this.logger.log('Initializing strategy cache — checking MongoDB...');
        try {
            const cached = await this.cacheRepo.findOne({ where: { cacheKey: 'strategies' } });
            if (cached && new Date() < cached.expiresAt) {
                this.cache = {
                    data: cached.data as SuggestStrategiesResult,
                    expiresAt: cached.expiresAt.getTime(),
                };
                this.logger.log(`Strategy cache loaded from MongoDB (expires ${cached.expiresAt.toISOString()})`);
                return;
            }
            this.logger.log('MongoDB cache missing/expired — scheduling LLM refresh');
        } catch (err) {
            this.logger.error(`MongoDB cache load failed: ${err.message} — falling back to LLM`);
        }
        this.scheduleRefresh();
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    async suggestStrategies(
        filter: SuggestFilter = {},
        forceRefresh = false,
    ): Promise<SuggestStrategiesResult> {
        const cacheExpired = !this.cache || Date.now() >= this.cache.expiresAt;

        // Trigger a background refresh when needed (stale-while-revalidate)
        if ((cacheExpired || forceRefresh) && !this.refreshPromise) {
            this.scheduleRefresh();
        }

        // Serve stale/cached data immediately — no waiting for LLM
        if (this.cache) {
            if (!cacheExpired) {
                this.logger.debug('Returning fresh cached strategy suggestions');
            } else {
                this.logger.debug('Cache stale — returning cached data, refreshing in background');
            }
            return this.applyFilter(this.cache.data, filter);
        }

        // No cache at all (first startup before warm-up completes): wait for the in-flight refresh
        this.logger.log('No cache yet — awaiting initial strategy generation...');
        if (this.refreshPromise) {
            await this.refreshPromise;
        }

        if (this.cache) {
            return this.applyFilter(this.cache.data, filter);
        }

        // Absolute fallback if LLM + pool fetch both failed
        return this.applyFilter(this.buildFallbackResult(0), filter);
    }

    // ─── Background refresh ───────────────────────────────────────────────────

    private scheduleRefresh(): void {
        this.refreshPromise = this.doRefresh().finally(() => {
            this.refreshPromise = null;
        });
    }

    @Interval(30 * 60 * 1000)
    handleStrategyRefreshCron(): void {
        this.logger.log('[Cron] 30-min strategy auto-refresh triggered');
        if (!this.refreshPromise) {
            this.scheduleRefresh();
        } else {
            this.logger.debug('[Cron] Refresh already in progress — skipping');
        }
    }

    private async doRefresh(): Promise<void> {
        let pools: PoolSnapshot[] = [];
        let totalPools = 0;
        try {
            const resp = await this.poolsClient.fetchPools({ limit: 60, sortBy: 'totalApy' });
            pools = resp.data ?? [];
            totalPools = resp.count ?? pools.length;
        } catch (err) {
            this.logger.error(`[refresh] Failed to fetch pools: ${err.message}`);
            return;
        }

        if (pools.length === 0) {
            this.logger.warn('[refresh] No pools found — skipping LLM refresh');
            return;
        }

        let chains: InvestmentChain[];
        if (this.openai) {
            chains = await this.generateWithLLM(pools);
        } else {
            chains = this.buildFallbackChains(pools);
        }

        chains = this.enrichChainsWithPoolData(chains, pools);

        // Enforce minimum 2 valid chains regardless of LLM output
        const validChains = chains.filter((c) => c.id !== 'error-chain-fallback');
        if (validChains.length < 2) {
            this.logger.warn(`[refresh] Only ${validChains.length} valid chains from LLM — supplementing with fallback`);
            const fallback = this.enrichChainsWithPoolData(this.buildFallbackChains(pools), pools);
            chains = [...validChains, ...fallback].slice(0, Math.max(validChains.length + fallback.length, 2));
        }

        const result: SuggestStrategiesResult = {
            generatedAt: new Date().toISOString(),
            totalPools,
            chains,
        };
        this.cache = {
            data: result,
            expiresAt: Date.now() + this.CACHE_TTL_MS,
        };
        this.logger.log('Strategy cache refreshed successfully');

        // Persist to MongoDB — fire-and-forget, does not block serving
        this.persistToDb(result).catch((err) =>
            this.logger.error(`[persistToDb] MongoDB save failed: ${err.message}`)
        );
    }

    private async persistToDb(result: SuggestStrategiesResult): Promise<void> {
        const expiresAt = new Date(Date.now() + this.CACHE_TTL_MS);
        await this.cacheRepo.updateOne(
            { cacheKey: 'strategies' },
            {
                $set: {
                    cacheKey: 'strategies',
                    data: result as unknown as Record<string, any>,
                    expiresAt,
                    generatedAt: new Date(result.generatedAt),
                    updatedAt: new Date(),
                },
            },
            { upsert: true },
        );
        this.logger.log(`Strategy cache persisted to MongoDB (expires ${expiresAt.toISOString()})`);
    }

    // ─── LLM generation ──────────────────────────────────────────────────────

    private async generateWithLLM(pools: PoolSnapshot[]): Promise<InvestmentChain[]> {
        // Remove outlier pools: APY > 300% with TVL < $50k are likely anomalous/illiquid
        const sanitised = pools.filter((p) => {
            const apy = p.totalApy ?? p.supplyApy ?? 0;
            const tvl = p.tvlUsd ?? 0;
            if (apy > 300 && tvl < 50_000) return false;
            return true;
        });

        // Cap 5 pools per protocol to ensure cross-protocol diversity
        const protocolCount = new Map<string, number>();
        const diverse = sanitised.filter((p) => {
            const key = p.protocol.toLowerCase();
            const count = protocolCount.get(key) ?? 0;
            if (count >= 5) return false;
            protocolCount.set(key, count + 1);
            return true;
        });

        const poolLines = diverse
            .slice(0, 30)
            .map((p) => {
                const apy = p.totalApy ?? p.supplyApy ?? 0;
                return `- protocol=${p.protocol} asset=${p.assetSymbol} poolType=${p.poolType} apy=${apy.toFixed(2)}% tvl=${p.tvlUsd ? `$${Math.round(p.tvlUsd / 1000)}k` : 'N/A'}`;
            })
            .join('\n');

        const systemPrompt = `You are a DeFi investment strategist specializing in Polkadot parachains.
Your task is to analyze a list of liquidity pools and generate EXACTLY 6 investment chains — no more, no less.
Each chain combines 2-3 pools with percentage allocations that MUST sum to exactly 100.
You MUST include chains at each risk level: at least 2 low-risk, 2 medium-risk, and 2 high-risk chains.
You MUST diversify across protocols: each chain should ideally combine pools from different protocols (e.g. Bifrost + Hydration, not Hydration + Hydration). Avoid using the same protocol for all allocations in a chain unless no alternatives exist.
Respond ONLY with a valid JSON object containing a "chains" array with exactly 6 items. No markdown, no explanation — pure JSON.`;

        const userPrompt = `Here are the current available pools (sorted by APY desc):

${poolLines}

Generate 6 to 8 investment chain suggestions. Return a JSON object matching this TypeScript type:
{
  "chains": [
    {
      "title": "string — e.g. 'Bifrost → Hydration (Balanced)'",
      "description": "string — 1-2 sentences explaining the rationale",
      "riskLevel": "low | medium | high",
    "estimatedApyMin": number,
    "estimatedApyMax": number,
    "allocations": [
      {
        "protocol": "string",
        "assetSymbol": "string",
        "percentage": number,  // MUST sum to 100 across all allocations in a chain
        "poolType": "string",
        "apyMin": number,
        "apyMax": number
      }
    ]
    ]
  }
]
}

Rules:
- Each chain's allocations[].percentage MUST sum to exactly 100
- Use 2-3 allocations per chain for diversification
- Vary risk levels: some low, some medium, some high chains
- apyMin/apyMax should reflect realistic range based on the pool data provided
- estimatedApyMin/Max = weighted average of allocation apyMin/Max
- Use exact protocol names and assetSymbols from the pool list above
- You MUST generate EXACTLY 6 chains — never fewer. If needed, reuse pools in different combinations with different percentages.
- Ensure risk level diversity: 2 low-risk chains, 2 medium-risk chains, 2 high-risk chains.`;

        try {
            this.logger.log('Calling OpenAI for strategy suggestions...');
            const response = await this.openai!.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                max_completion_tokens: 4096,
                response_format: { type: 'json_object' },
            });

            let raw = response.choices[0]?.message?.content ?? '{}';
            this.logger.debug(`LLM raw response (${raw.length} chars)`);

            // Clean up Markdown or other text formatting that might occur
            if (raw.startsWith('```json')) {
                raw = raw.replace(/^```json/, '').replace(/```$/, '').trim();
            } else if (raw.startsWith('```')) {
                raw = raw.replace(/^```/, '').replace(/```$/, '').trim();
            }

            // Parse — LLM might wrap in { "chains": [...] } or return array directly
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                throw new Error(`JSON Parse Error: ${err.message}. Raw: ${raw.substring(0, 100)}...${raw.substring(raw.length - 100)}`);
            }
            const arr: any[] = Array.isArray(parsed)
                ? parsed
                : (parsed.chains ?? parsed.strategies ?? parsed.suggestions ?? Object.values(parsed)[0]);

            if (!Array.isArray(arr) || arr.length === 0) {
                throw new Error('LLM returned empty or non-array chains');
            }

            return arr.map((item) => this.normaliseChain(item));
        } catch (err) {
            this.logger.error(`LLM generation failed: ${err.message} — using fallback`);
            console.error('Full LLM Error:', err);
            return [
                {
                    id: 'error-chain-fallback',
                    title: `ERROR: ${err.message}`,
                    description: `Full error details generated from LLM breakdown.`,
                    riskLevel: 'high',
                    estimatedApyMin: 0,
                    estimatedApyMax: 0,
                    allocations: []
                }
            ];
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Match each allocation back to its source pool snapshot and attach live
     * fields: network, tvlUsd, currentApy, supplyApy, rewardApy, dataTimestamp.
     */
    private enrichChainsWithPoolData(chains: InvestmentChain[], pools: PoolSnapshot[]): InvestmentChain[] {
        // Build lookup: "protocol|assetSymbol" → best matching pool
        const poolMap = new Map<string, PoolSnapshot>();
        for (const pool of pools) {
            const key = `${pool.protocol.toLowerCase()}|${pool.assetSymbol.toLowerCase()}`;
            // Keep the entry with higher APY when duplicates exist
            const existing = poolMap.get(key);
            const apy = pool.totalApy ?? pool.supplyApy ?? 0;
            const existingApy = existing ? (existing.totalApy ?? existing.supplyApy ?? 0) : -1;
            if (!existing || apy > existingApy) {
                poolMap.set(key, pool);
            }
        }

        return chains.map((chain) => ({
            ...chain,
            allocations: chain.allocations.map((alloc) => {
                const key = `${alloc.protocol.toLowerCase()}|${alloc.assetSymbol.toLowerCase()}`;
                const pool = poolMap.get(key);
                if (!pool) return alloc;
                return {
                    ...alloc,
                    network: pool.network,
                    tvlUsd: pool.tvlUsd,
                    currentApy: pool.totalApy ?? pool.supplyApy,
                    supplyApy: pool.supplyApy,
                    rewardApy: pool.rewardApy,
                    dataTimestamp: pool.dataTimestamp,
                };
            }),
        }));
    }

    /**
     * Normalise & validate one LLM-generated chain.
     * If allocations don't sum to 100, auto-adjust the last item.
     */
    private normaliseChain(raw: any): InvestmentChain {
        const allocations: StrategyAllocation[] = (raw.allocations ?? []).map((a: any) => ({
            protocol: String(a.protocol ?? '').toLowerCase(),
            assetSymbol: String(a.assetSymbol ?? a.asset ?? ''),
            percentage: Number(a.percentage ?? 0),
            poolType: String(a.poolType ?? 'unknown'),
            apyMin: Number(a.apyMin ?? 0),
            apyMax: Number(a.apyMax ?? 0),
        }));

        // Fix percentage sum
        const sum = allocations.reduce((s, a) => s + a.percentage, 0);
        if (allocations.length > 0 && Math.abs(sum - 100) > 0.01) {
            allocations[allocations.length - 1].percentage += 100 - sum;
            allocations[allocations.length - 1].percentage = parseFloat(
                allocations[allocations.length - 1].percentage.toFixed(2),
            );
        }

        return {
            id: uuidv4(),
            title: String(raw.title ?? 'Strategy'),
            description: String(raw.description ?? ''),
            riskLevel: this.parseRisk(raw.riskLevel),
            estimatedApyMin: Number(raw.estimatedApyMin ?? 0),
            estimatedApyMax: Number(raw.estimatedApyMax ?? 0),
            allocations,
        };
    }

    private parseRisk(val: any): 'low' | 'medium' | 'high' {
        if (val === 'low' || val === 'medium' || val === 'high') return val;
        const v = String(val ?? '').toLowerCase();
        if (v.includes('low')) return 'low';
        if (v.includes('high')) return 'high';
        return 'medium';
    }

    private applyFilter(
        result: SuggestStrategiesResult,
        filter: SuggestFilter,
    ): SuggestStrategiesResult {
        let chains = result.chains;
        if (filter.riskLevel) {
            chains = chains.filter((c) => c.riskLevel === filter.riskLevel);
        }
        if (filter.minApy !== undefined) {
            chains = chains.filter((c) => c.estimatedApyMin >= filter.minApy!);
        }
        return { ...result, chains };
    }

    // ─── Fallback (no LLM key or LLM error) ─────────────────────────────────

    private buildFallbackChains(pools: PoolSnapshot[]): InvestmentChain[] {
        // Pick top pools by APY for a simple deterministic fallback
        const sorted = [...pools].sort(
            (a, b) => ((b.totalApy ?? b.supplyApy ?? 0) - (a.totalApy ?? a.supplyApy ?? 0)),
        );
        const top = sorted.slice(0, 4);

        if (top.length < 2) return this.hardcodedFallback();

        const makeAlloc = (p: PoolSnapshot, pct: number): StrategyAllocation => {
            const apy = p.totalApy ?? p.supplyApy ?? 0;
            return {
                protocol: p.protocol.toLowerCase(),
                assetSymbol: p.assetSymbol,
                percentage: pct,
                poolType: p.poolType,
                apyMin: parseFloat((apy * 0.85).toFixed(2)),
                apyMax: parseFloat((apy * 1.15).toFixed(2)),
            };
        };

        return [
            {
                id: uuidv4(),
                title: `${top[0].protocol} → ${top[1].protocol} (High Yield)`,
                description: `Concentrates capital in the two highest-yielding pools available. High potential return with moderate risk.`,
                riskLevel: 'high',
                estimatedApyMin: parseFloat(((top[0].totalApy ?? top[0].supplyApy ?? 0) * 0.85).toFixed(2)),
                estimatedApyMax: parseFloat(((top[0].totalApy ?? top[0].supplyApy ?? 0) * 1.15).toFixed(2)),
                allocations: [makeAlloc(top[0], 60), makeAlloc(top[1], 40)],
            },
            {
                id: uuidv4(),
                title: `Balanced 3-Pool Strategy`,
                description: `Spreads capital across three pools for diversification while maintaining solid yield.`,
                riskLevel: 'medium',
                estimatedApyMin: 8,
                estimatedApyMax: 18,
                allocations: top.length >= 3
                    ? [makeAlloc(top[0], 40), makeAlloc(top[1], 35), makeAlloc(top[2], 25)]
                    : [makeAlloc(top[0], 60), makeAlloc(top[1], 40)],
            },
        ];
    }

    private buildFallbackResult(totalPools: number): SuggestStrategiesResult {
        return {
            generatedAt: new Date().toISOString(),
            totalPools,
            chains: this.hardcodedFallback(),
        };
    }

    private hardcodedFallback(): InvestmentChain[] {
        return [
            {
                id: uuidv4(),
                title: 'Bifrost → Hydration (Balanced)',
                description: 'Combines vDOT liquid staking (~18% APY) with HOLLAR DEX (10-20%). Solid risk/reward balance.',
                riskLevel: 'medium',
                estimatedApyMin: 14,
                estimatedApyMax: 19,
                allocations: [
                    { protocol: 'bifrost', assetSymbol: 'vDOT', percentage: 60, poolType: 'vstaking', apyMin: 17, apyMax: 20 },
                    { protocol: 'hydration', assetSymbol: 'HOLLAR', percentage: 40, poolType: 'dex', apyMin: 10, apyMax: 20 },
                ],
            },
            {
                id: uuidv4(),
                title: 'Bifrost → Moonwell (Conservative)',
                description: 'Combines liquid staking with Moonwell lending for stable blended returns with low IL risk.',
                riskLevel: 'low',
                estimatedApyMin: 16,
                estimatedApyMax: 18,
                allocations: [
                    { protocol: 'bifrost', assetSymbol: 'vDOT', percentage: 55, poolType: 'vstaking', apyMin: 17, apyMax: 20 },
                    { protocol: 'moonwell', assetSymbol: 'USDC', percentage: 45, poolType: 'lending', apyMin: 14, apyMax: 16 },
                ],
            },
        ];
    }
}
