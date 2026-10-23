// The one place in Dumen that talks to an LLM. Every agent calls generator().
// Signature matches the Meterless Agent Engines README exactly:
//   generator(prompt, attachments, systemPrompt, onStream, abortSignal) → { text }
// Point it at a different OpenAI-compatible provider by changing .env, nothing else.
import OpenAI from "openai";

export interface GeneratorResult {
  text: string;
}

// Text attachments are appended to the prompt; the refund flow doesn't use binary ones.
export type Attachment = string | { name?: string; content: string };

export type Generator = (
  prompt: string,
  attachments?: Attachment[] | null,
  systemPrompt?: string | null,
  onStream?: ((chunk: string) => void) | null,
  abortSignal?: AbortSignal | null,
) => Promise<GeneratorResult>;

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

function withAttachments(prompt: string, attachments?: Attachment[] | null): string {
  if (!attachments?.length) return prompt;
  const blocks = attachments.map((a, i) =>
    typeof a === "string" ? `[ATTACHMENT ${i + 1}]\n${a}` : `[ATTACHMENT ${i + 1}${a.name ? `: ${a.name}` : ""}]\n${a.content}`,
  );
  return `${prompt}\n\n${blocks.join("\n\n")}`;
}

export const generator: Generator = async (prompt, attachments, systemPrompt, onStream, abortSignal) => {
  const fullPrompt = withAttachments(prompt, attachments);
  if (process.env.SAMPLE_MODE === "true") {
    const text = sampleResponse(fullPrompt);
    onStream?.(text);
    return { text };
  }
  const model = process.env.NIGHTSHIFT_MODEL;
  if (!model) throw new Error("NIGHTSHIFT_MODEL must be set (or use SAMPLE_MODE=true)");

  const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const messages = [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    { role: "user" as const, content: fullPrompt },
  ];

  if (onStream) {
    const stream = await getClient().chat.completions.create({ model, messages, stream: true }, { signal });
    let text = "";
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        text += delta;
        onStream(delta);
      }
    }
    return { text };
  }

  const res = await getClient().chat.completions.create({ model, messages }, { signal });
  return { text: res.choices[0]?.message?.content ?? "" };
};
