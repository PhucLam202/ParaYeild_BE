const { OpenAI } = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function run() {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-5-nano",
            messages: [{ role: "user", content: "Hello, please reply in JSON." }],
            max_completion_tokens: 2500,
            response_format: { type: 'json_object' }
        });
        console.log("Success:", JSON.stringify(response.choices[0], null, 2));
    } catch (err) {
        if (err.response) {
            console.error("RESPONSE ERROR:", err.response.data);
        } else {
            console.error("MESSAGE ERROR:", err.message);
        }
    }
}
run();
