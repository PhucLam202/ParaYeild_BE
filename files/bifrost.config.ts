export const BIFROST_CONFIG = {
  // ─── RPC Endpoints (dùng archive nodes để query historical blocks) ───
  RPC_ENDPOINTS: [
    'wss://bifrost-polkadot-rpc.dwellir.com',    // Dwellir archive
    'wss://bifrost-rpc.liebi.com/ws',             // Liebi official
    'wss://eu.bifrost-polkadot-rpc.liebi.com/ws', // Liebi EU
  ],

  // ─── Chain metadata ───
  CHAIN: 'bifrost-polkadot',
  PARA_ID: 2030,

  // ─── Block timing ───
  // Bifrost ~6s/block → 600 blocks/hour, 14400 blocks/day
  BLOCK_TIME_SECONDS: 6,
  BLOCKS_PER_HOUR: 600,
  BLOCKS_PER_DAY: 14400,

  // ─── vToken configuration ───
  // Key format trong Substrate: { Token2: index }
  // Source: https://docs.bifrost.io/for-builders/vtoken-apis
  VTOKENS: {
    vDOT: {
      symbol: 'vDOT',
      baseToken: 'DOT',
      currencyId: { VToken2: 0 },    // VToken2:0 = vDOT
      baseCurrencyId: { Token2: 0 }, // Token2:0 = DOT
      decimals: 10,
      coingeckoId: 'polkadot',       // price của base token
    },
    vKSM: {
      symbol: 'vKSM',
      baseToken: 'KSM',
      currencyId: { VToken: 'KSM' },
      baseCurrencyId: { Token: 'KSM' },
      decimals: 12,
      coingeckoId: 'kusama',
    },
    vGLMR: {
      symbol: 'vGLMR',
      baseToken: 'GLMR',
      currencyId: { VToken2: 1 },
      baseCurrencyId: { Token2: 1 },
      decimals: 18,
      coingeckoId: 'moonbeam',
    },
    vASTR: {
      symbol: 'vASTR',
      baseToken: 'ASTR',
      currencyId: { VToken2: 3 },
      baseCurrencyId: { Token2: 3 },
      decimals: 18,
      coingeckoId: 'astar',
    },
    vBNC: {
      symbol: 'vBNC',
      baseToken: 'BNC',
      currencyId: { VToken2: 6 },
      baseCurrencyId: { Native: 'BNC' },
      decimals: 12,
      coingeckoId: 'bifrost-native-coin',
    },
  },

  // ─── Indexer settings ───
  // Bắt đầu từ block khi Bifrost Polkadot launched (approx. Jan 2023)
  // Block ~3,200,000 ≈ tháng 1/2023
  START_BLOCK: 3_200_000,

  // Số blocks mỗi batch khi crawl (tránh timeout RPC)
  BATCH_SIZE: 100,

  // Lấy snapshot mỗi bao nhiêu blocks (1 giờ = 600 blocks)
  SNAPSHOT_INTERVAL: 600, // hourly

  // Delay giữa các batch (ms) để tránh rate limit
  BATCH_DELAY_MS: 200,

  // Max retries khi RPC fail
  MAX_RETRIES: 3,
};

// ─── CoinGecko config ───
export const PRICE_CONFIG = {
  COINGECKO_BASE_URL: 'https://api.coingecko.com/api/v3',
  // DeFiLlama làm backup (free, no key needed)
  DEFILLAMA_BASE_URL: 'https://coins.llama.fi',
  // Cache price mỗi 5 phút
  PRICE_CACHE_TTL_MS: 5 * 60 * 1000,
};

// ─── MongoDB config ───
export const DB_CONFIG = {
  // Override bằng env var MONGODB_URI
  DEFAULT_URI: 'mongodb://localhost:27017/bifrost-indexer',
};
