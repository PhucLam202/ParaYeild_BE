export interface VTokenConfig {
    symbol: string;
    baseToken: string;
    currencyId: Record<string, any>;
    baseCurrencyId: Record<string, any>;
    decimals: number;
    coingeckoId: string;
}

export const BIFROST_CONFIG = {
    // ─── RPC Endpoints ───
    RPC_ENDPOINTS: [
        'wss://bifrost-polkadot-rpc.dwellir.com',
        'wss://eu.bifrost-polkadot-rpc.liebi.com/ws',
    ],

    CHAIN: 'bifrost-polkadot',
    PARA_ID: 2030,

    BLOCK_TIME_SECONDS: 6,
    BLOCKS_PER_HOUR: 600,
    BLOCKS_PER_DAY: 14400,

    // ─── vToken definitions ───
    VTOKENS: {
        vDOT: {
            symbol: 'vDOT',
            baseToken: 'DOT',
            currencyId: { VToken2: 0 },
            baseCurrencyId: { Token2: 0 },
            decimals: 10,
            coingeckoId: 'polkadot',
        } as VTokenConfig,
        vKSM: {
            symbol: 'vKSM',
            baseToken: 'KSM',
            currencyId: { VToken: 'KSM' },
            baseCurrencyId: { Token: 'KSM' },
            decimals: 12,
            coingeckoId: 'kusama',
        } as VTokenConfig,
        vGLMR: {
            symbol: 'vGLMR',
            baseToken: 'GLMR',
            currencyId: { VToken2: 1 },
            baseCurrencyId: { Token2: 1 },
            decimals: 18,
            coingeckoId: 'moonbeam',
        } as VTokenConfig,
        vASTR: {
            symbol: 'vASTR',
            baseToken: 'ASTR',
            currencyId: { VToken2: 3 },
            baseCurrencyId: { Token2: 3 },
            decimals: 18,
            coingeckoId: 'astar',
        } as VTokenConfig,
        vBNC: {
            symbol: 'vBNC',
            baseToken: 'BNC',
            currencyId: { VToken2: 6 },
            baseCurrencyId: { Native: 'BNC' },
            decimals: 12,
            coingeckoId: 'bifrost-native-coin',
        } as VTokenConfig,
    } as Record<string, VTokenConfig>,

    // ─── Indexer settings ───
    START_BLOCK: 3_200_000,
    BATCH_SIZE: 100,
    SNAPSHOT_INTERVAL: 600,
    BATCH_DELAY_MS: 200,
    MAX_RETRIES: 3,
};

export const PRICE_CONFIG = {
    COINGECKO_BASE_URL: 'https://api.coingecko.com/api/v3',
    DEFILLAMA_BASE_URL: 'https://coins.llama.fi',
    PRICE_CACHE_TTL_MS: 5 * 60 * 1000,
};

export const DB_CONFIG = {
    DEFAULT_URI: 'mongodb://localhost:27017/parayield-lab',
};
