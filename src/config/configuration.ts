export default () => ({
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',

    mongodb: {
        uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/parayield-lab',
    },

    security: {
        adminApiKey: process.env.ADMIN_API_KEY || 'change-me-in-production',
        allowedOrigins: process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
            : ['http://localhost:3001'],
        jwtSecret: process.env.JWT_SECRET || 'change-me-jwt-secret',
    },

    throttle: {
        ttl: parseInt(process.env.THROTTLE_TTL_MS, 10) || 60000,
        limit: parseInt(process.env.THROTTLE_LIMIT, 10) || 100,
    },

    poolsApiUrl: process.env.POOLS_API_URL || 'http://localhost:3000',

    openaiApiKey: process.env.OPENAI_API_KEY || '',
});
