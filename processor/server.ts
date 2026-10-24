// Mock payment processor with seeded chaos.
//   npm run processor -- --seed 42 --lost 0.2 --slow 0.1 --fail 0.05 --down 0.05 [--mode naive|idempotent]
//
// Every refund it actually processes is written to processor_log (source B).
// naive mode (default) does NOT dedupe by refund_key, so a retry pays again. That is the bug.
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import pg from "pg";

type Behaviour = "ok" | "lost_response" | "real_fail" | "slow_confirm" | "down";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "4010" },
    seed: { type: "string", default: "42" },
    lost: { type: "string", default: "0" },
    slow: { type: "string", default: "0" },
    fail: { type: "string", default: "0" },
    down: { type: "string", default: "0" },
    mode: { type: "string", default: "naive" },
    "hang-ms": { type: "string", default: "15000" }, // how long lost/down calls hang before the socket drops
    "slow-ms": { type: "string", default: "3000" }, // how late slow_confirm writes its log row
  },
});

const rates = { lost: Number(args.lost), slow: Number(args.slow), fail: Number(args.fail), down: Number(args.down) };
for (const [k, v] of Object.entries(rates)) {
  if (!(v >= 0 && v <= 1)) throw new Error(`--${k} must be between 0 and 1`);
}
if (rates.lost + rates.slow + rates.fail + rates.down > 1) throw new Error("--lost + --slow + --fail + --down must be <= 1");
if (args.mode !== "naive" && args.mode !== "idempotent") throw new Error("--mode must be naive or idempotent");
const HANG_MS = Number(args["hang-ms"]);
const SLOW_MS = Number(args["slow-ms"]);

// mulberry32: same seed → same sequence of behaviours, call by call
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(Number(args.seed));

function nextBehaviour(): Behaviour {
  let r = rand();
  if ((r -= rates.lost) < 0) return "lost_response";
  if ((r -= rates.slow) < 0) return "slow_confirm";
  if ((r -= rates.fail) < 0) return "real_fail";
  if ((r -= rates.down) < 0) return "down";
  return "ok";
}

const db = new pg.Pool({ connectionString: process.env.PROCESSOR_DATABASE_URL, statement_timeout: 10_000, max: 5 });

async function logRefund(refundKey: string, amount: number) {
  await db.query(
    "INSERT INTO processor_log (refund_key, processor_status, amount, processed_at) VALUES ($1, 'succeeded', $2, now())",
    [refundKey, amount],
  );
}

async function alreadyPaid(refundKey: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM processor_log WHERE refund_key = $1 AND processor_status = 'succeeded'", [refundKey]);
  return (rowCount ?? 0) > 0;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Hold the connection, then drop it without a reply: what a client sees as a timeout.
function hang(req: IncomingMessage) {
  setTimeout(() => req.socket.destroy(), HANG_MS);
}

async function readJson(req: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error("body too large");
  }
  return JSON.parse(body || "{}");
}

let callNo = 0;

async function handleRefund(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const refundKey = String(body.refund_key ?? "");
  const amount = Number(body.amount);
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(refundKey) || !(amount > 0)) {
    return send(res, 400, { error: "refund_key and a positive amount are required" });
  }

  const behaviour = nextBehaviour();
  const n = ++callNo;
  console.log(`#${n} POST /refund ${refundKey} ${amount} → ${behaviour}`);

  if (behaviour === "down") return hang(req);
  if (behaviour === "real_fail") return send(res, 502, { refund_key: refundKey, status: "failed", error: "processor declined" });

  if (args.mode === "idempotent" && (await alreadyPaid(refundKey))) {
    return send(res, 200, { refund_key: refundKey, status: "succeeded", duplicate: true });
  }

  if (behaviour === "slow_confirm") {
    setTimeout(() => logRefund(refundKey, amount).catch((e) => console.error(`#${n} late log failed: ${e.message}`)), SLOW_MS);
    return send(res, 202, { refund_key: refundKey, status: "processing" });
  }

  await logRefund(refundKey, amount);
  if (behaviour === "lost_response") return hang(req); // paid and logged, but the caller never hears back
  return send(res, 200, { refund_key: refundKey, status: "succeeded" });
}

async function handleGet(res: ServerResponse, refundKey: string) {
  const { rows } = await db.query(
    "SELECT refund_key, processor_status, amount, processed_at FROM processor_log WHERE refund_key = $1 ORDER BY id",
    [refundKey],
  );
  if (!rows.length) return send(res, 404, { refund_key: refundKey, status: "not_found" });
  send(res, 200, { refund_key: refundKey, attempts: rows });
}

// ── Bank rail: batch payouts ───────────────────────────────────────────────
// One call carries several payouts. Same seeded behaviours, one per call; a lost response
// executes only the first k items (k from the same PRNG) before the connection drops, so a
// timeout leaves some payouts done and some not. Naive mode doesn't dedupe by payout_key.

async function logPayout(payoutKey: string, amount: number) {
  await db.query("INSERT INTO bank_rail_log (payout_key, bank_status, amount, executed_at) VALUES ($1, 'succeeded', $2, now())", [payoutKey, amount]);
}

async function alreadyPaidOut(payoutKey: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM bank_rail_log WHERE payout_key = $1 AND bank_status = 'succeeded'", [payoutKey]);
  return (rowCount ?? 0) > 0;
}

async function handlePayoutBatch(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson(req);
  const items: Array<{ payout_key: string; amount: number }> = Array.isArray(body.items) ? body.items : [];
  if (!items.length || items.length > 50 || !items.every((i) => /^[A-Za-z0-9_.:-]{1,100}$/.test(String(i.payout_key)) && Number(i.amount) > 0)) {
    return send(res, 400, { error: "items: 1-50 of {payout_key, amount > 0}" });
  }
  const behaviour = nextBehaviour();
  const n = ++callNo;
  console.log(`#${n} POST /payouts/batch ${body.batch_id ?? "-"} [${items.map((i) => i.payout_key).join(",")}] → ${behaviour}`);

  if (behaviour === "down") return hang(req);
  if (behaviour === "real_fail") return send(res, 502, { batch_id: body.batch_id, status: "failed", error: "bank rejected the batch" });

  const execute = async (list: typeof items) => {
    const results: Array<{ payout_key: string; status: string; duplicate?: boolean }> = [];
    for (const i of list) {
      if (args.mode === "idempotent" && (await alreadyPaidOut(i.payout_key))) {
        results.push({ payout_key: i.payout_key, status: "succeeded", duplicate: true });
        continue;
      }
      await logPayout(i.payout_key, Number(i.amount));
      results.push({ payout_key: i.payout_key, status: "succeeded" });
    }
    return results;
  };

  if (behaviour === "slow_confirm") {
    setTimeout(() => execute(items).catch((e) => console.error(`#${n} late batch failed: ${e.message}`)), SLOW_MS);
    return send(res, 202, { batch_id: body.batch_id, status: "processing" });
  }
  if (behaviour === "lost_response") {
    const k = Math.floor(rand() * (items.length + 1)); // 0..n items executed before the drop
    await execute(items.slice(0, k));
    console.log(`#${n}   executed ${k}/${items.length} before the connection dropped`);
    return hang(req);
  }
  return send(res, 200, { batch_id: body.batch_id, status: "succeeded", items: await execute(items) });
}

async function handleGetPayout(res: ServerResponse, payoutKey: string) {
  const { rows } = await db.query("SELECT payout_key, bank_status, amount, executed_at FROM bank_rail_log WHERE payout_key = $1 ORDER BY id", [payoutKey]);
  if (!rows.length) return send(res, 404, { payout_key: payoutKey, status: "not_found" });
  send(res, 200, { payout_key: payoutKey, attempts: rows });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/refund") return await handleRefund(req, res);
    const m = url.pathname.match(/^\/refunds\/([^/]+)$/);
    if (req.method === "GET" && m) return await handleGet(res, decodeURIComponent(m[1]));
    if (req.method === "POST" && url.pathname === "/payouts/batch") return await handlePayoutBatch(req, res);
    const pm = url.pathname.match(/^\/payouts\/([^/]+)$/);
    if (req.method === "GET" && pm) return await handleGetPayout(res, decodeURIComponent(pm[1]));
    send(res, 404, { error: "not found" });
  } catch (e: any) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

server.listen(Number(args.port), "127.0.0.1", () => {
  console.log(`processor on http://127.0.0.1:${args.port} mode=${args.mode} seed=${args.seed} rates=${JSON.stringify(rates)}`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    db.end().finally(() => process.exit(0));
  });
}
