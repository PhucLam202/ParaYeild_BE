import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { PoolsClientService, PoolSnapshot } from '../../common/services/pools-client.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StrategyAllocation {
    protocol: string;
    assetSymbol: string;
    percentage: number;
    poolType: string;
    apyMin: number;
    apyMax: number;
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
export class StrategyService {
    private readonly logger = new Logger(StrategyService.name);
    private readonly openai: OpenAI | null;
    private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    private cache: CacheEntry | null = null;

    constructor(
        private readonly poolsClient: PoolsClientService,
        private readonly configService: ConfigService,
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

    // ─── Public API ──────────────────────────────────────────────────────────

    async suggestStrategies(
        filter: SuggestFilter = {},
        forceRefresh = false,
    ): Promise<SuggestStrategiesResult> {
        // Return cached result if valid and not forced refresh
        if (!forceRefresh && this.cache && Date.now() < this.cache.expiresAt) {
            this.logger.debug('Returning cached strategy suggestions');
            return this.applyFilter(this.cache.data, filter);
        }

        // 1. Fetch current pools
        let pools: PoolSnapshot[] = [];
        let totalPools = 0;
        try {
            const resp = await this.poolsClient.fetchPools({ limit: 60, sortBy: 'totalApy' });
            pools = resp.data ?? [];
            totalPools = resp.count ?? pools.length;
        } catch (err) {
            this.logger.error(`Failed to fetch pools: ${err.message}`);
            throw new InternalServerErrorException(
                'Cannot fetch pool data for strategy generation. Is the pools server running?',
            );
        }

        if (pools.length === 0) {
            this.logger.warn('No pools found — returning fallback strategies');
            const fallback = this.buildFallbackResult(0);
            return this.applyFilter(fallback, filter);
        }

        // 2. Generate chains via LLM or fallback
        let chains: InvestmentChain[];
        if (this.openai) {
            chains = await this.generateWithLLM(pools);
        } else {
            chains = this.buildFallbackChains(pools);
        }

        const result: SuggestStrategiesResult = {
            generatedAt: new Date().toISOString(),
            totalPools,
            chains,
        };

        // 3. Cache the full result
        this.cache = { data: result, expiresAt: Date.now() + this.CACHE_TTL_MS };

        return this.applyFilter(result, filter);
    }

    // ─── LLM generation ──────────────────────────────────────────────────────

    private async generateWithLLM(pools: PoolSnapshot[]): Promise<InvestmentChain[]> {
        const poolLines = pools
            .slice(0, 40) // limit context size
            .map((p) => {
                const apy = p.totalApy ?? p.supplyApy ?? 0;
                return `- protocol=${p.protocol} asset=${p.assetSymbol} poolType=${p.poolType} apy=${apy.toFixed(2)}% tvl=${p.tvlUsd ? `$${Math.round(p.tvlUsd / 1000)}k` : 'N/A'}`;
            })
            .join('\n');

        const systemPrompt = `You are a DeFi investment strategist specializing in Polkadot parachains.
Your task is to analyze a list of liquidity pools and suggest 6–8 diversified investment chains.
Each chain combines 2-3 pools with percentage allocations that MUST sum to exactly 100.
Prefer chains that balance risk (vstaking = low risk, dex = medium risk, farming = higher risk).
Respond ONLY with a valid JSON object containing a "chains" array. No markdown, no explanation — pure JSON.`;

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
- Use exact protocol names and assetSymbols from the pool list above`;

        try {
            this.logger.log('Calling OpenAI for strategy suggestions...');
            const response = await this.openai!.chat.completions.create({
                model: 'gpt-5-nano',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                max_completion_tokens: 10000,
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
