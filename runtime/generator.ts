// The one place in Dumen that talks to an LLM. Every agent calls generate().
import OpenAI from "openai";

export interface GenerateResult {
  text: string;
}

const TIMEOUT_MS = Number(process.env.NIGHTSHIFT_TIMEOUT_MS ?? 30_000);

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const baseURL = process.env.NIGHTSHIFT_BASE_URL;
    const apiKey = process.env.NIGHTSHIFT_API_KEY;
    if (!baseURL || !apiKey) {
      throw new Error("NIGHTSHIFT_BASE_URL and NIGHTSHIFT_API_KEY must be set (or use SAMPLE_MODE=true)");
    }
    // maxRetries: 0 — callers decide about retries, the SDK must not retry silently.
    client = new OpenAI({ baseURL, apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

// Deterministic stand-in for the model: same prompt in, same text out.
function sampleResponse(prompt: string): string {
  const amount = prompt.match(/amount requested:\s*(\d+(?:\.\d+)?)/i)?.[1];
  if (amount) {
    return JSON.stringify({ decision: "refund", amount: Number(amount), reason: "sample mode: refund the requested amount" });
  }
  return "sample mode response";
}

export async function generate(prompt: string, systemPrompt: string): Promise<GenerateResult> {
  if (process.env.SAMPLE_MODE === "true") {
    return { text: sampleResponse(prompt) };
  }
  const model = process.env.NIGHTSHIFT_MODEL;
  if (!model) throw new Error("NIGHTSHIFT_MODEL must be set (or use SAMPLE_MODE=true)");

  const res = await getClient().chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    },
    { timeout: TIMEOUT_MS },
  );
  return { text: res.choices[0]?.message?.content ?? "" };
}
