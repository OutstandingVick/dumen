// The dashboard's request worker: one warm process for every New request, instead of a fresh
// tsx process, processor and Zetaris login per request. Requests run one at a time.
//   npx tsx scripts/request-worker.ts [--port 4019]
//   POST /request {kind, order, message, seller, amount, chaos, zetarisDown, nightshiftDown}
//     → streams @@RUN / @@ENTITY / @@RESULT / @@DONE lines as they happen (see request-core.ts);
//       Nemotron's escalation summary is written after the stream ends.
//   GET /health → 200 when ready
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { warmUp } from "../runtime/generator.js";
import { query } from "../runtime/zetaris.js";
import { runRequest, validate, type RequestParams } from "./request-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({ options: { port: { type: "string", default: "4019" }, "processor-port": { type: "string", default: "4015" } } });

// Requests only need a quick yes/no from Nemotron, not its reasoning pass (see generator.ts).
process.env.NIGHTSHIFT_NO_THINKING = "true";
const PROCESSOR_PORT = args["processor-port"]!;
const processorUrl = `http://127.0.0.1:${PROCESSOR_PORT}`;
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 4 });

let processor: ChildProcess | null = null;
async function ensureProcessor() {
  const up = async () => {
    try {
      await fetch(`${processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
      return true;
    } catch {
      return false;
    }
  };
  if (await up()) return;
  processor = spawn("npx", ["tsx", "processor/server.ts", "--port", PROCESSOR_PORT, "--mode", "naive", "--hang-ms", "5000", "--slow-ms", "1500"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 200));
}
const setChaos = async (behaviour: string) => {
  await fetch(`${processorUrl}/_chaos/next`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ behaviour }), signal: AbortSignal.timeout(2000) });
};

// Warm everything once: the processor, the Zetaris login (kept for every later query) and Nemotron.
await ensureProcessor();
await query("SELECT 1 AS ok").catch((e) => console.error(`zetaris warm-up failed: ${e.message}`));
if (process.env.SAMPLE_MODE !== "true") await warmUp();

let queue: Promise<unknown> = Promise.resolve();

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return void res.writeHead(200).end("ok");
  if (req.method !== "POST" || req.url !== "/request") return void res.writeHead(404).end();
  let body = "";
  for await (const chunk of req) body += chunk;
  let p: RequestParams;
  try {
    const b = JSON.parse(body);
    p = { kind: b.kind, order: b.order, message: b.message, seller: b.seller, amount: Number(b.amount), chaos: b.chaos ?? "ok", zetarisDown: !!b.zetarisDown, nightshiftDown: !!b.nightshiftDown, sample: !!b.sample, newRun: false };
  } catch {
    return void res.writeHead(400).end("@@DONE {\"ok\":false,\"reason\":\"bad JSON\"}\n");
  }
  const invalid = validate(p);
  if (invalid) return void res.writeHead(400).end(`@@DONE ${JSON.stringify({ ok: false, reason: invalid })}\n`);

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  const run = queue.then(async () => {
    await ensureProcessor();
    const { summaries } = await runRequest(p, { ordersDb, processorUrl, setChaos }, (line) => res.write(line + "\n"));
    res.end();
    summaries.catch(() => {}); // the template summary stays
  });
  queue = run.catch((e) => {
    res.end(`@@DONE ${JSON.stringify({ ok: false, reason: e.message })}\n`);
  });
});

server.listen(Number(args.port), "127.0.0.1", () => console.log(`request worker on http://127.0.0.1:${args.port}`));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    processor?.kill("SIGTERM");
    server.close();
    ordersDb.end().finally(() => process.exit(0));
  });
}
