const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const systemPrompt = `You are a DeFi investment strategist specializing in Polkadot parachains.
Your task is to analyze a list of liquidity pools and suggest 6–8 diversified investment chains.
Each chain combines 2-3 pools with percentage allocations that MUST sum to exactly 100.
Prefer chains that balance risk (vstaking = low risk, dex = medium risk, farming = higher risk).
Respond ONLY with a valid JSON array. No markdown, no explanation — pure JSON.`;

const userPrompt = `Here are the current available pools (sorted by APY desc):
- protocol=moonwell asset=GLMR poolType=lending apy=10000.00%
- protocol=moonwell asset=USDC poolType=lending apy=5.00%

Generate 6 to 8 investment chain suggestions. Return a JSON array.`;

async function run() {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            max_completion_tokens: 2500,
            response_format: { type: 'json_object' }
        });
        console.log("Full Response:\n", JSON.stringify(response, null, 2));
    } catch (e) {
        console.error("API Error:\n", e.message);
    }
}
run();
