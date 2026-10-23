// One command reproduces the double-refund bug:
//   npm run chaos -- --agent baseline --tickets 20 --seed 42 --lost 0.2
// Resets both databases, starts the mock processor with seeded chaos, runs the agent
// over the tickets, then asks Zetaris (refund_truth) what was actually paid.
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { runBaseline, type Ticket, type TicketOutcome } from "../agents/baseline.js";
import { Trace } from "../runtime/trace.js";
import { getAllRefundTruth } from "../runtime/zetaris.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values: args } = parseArgs({
  options: {
    agent: { type: "string", default: "baseline" },
    tickets: { type: "string", default: "20" },
    seed: { type: "string", default: "42" },
    lost: { type: "string", default: "0.2" },
    slow: { type: "string", default: "0" },
    fail: { type: "string", default: "0" },
    down: { type: "string", default: "0" },
    port: { type: "string", default: "4010" },
    "call-timeout-ms": { type: "string", default: "3000" },
  },
});
if (args.agent !== "baseline") throw new Error(`unknown agent "${args.agent}" (Phase 2 has only: baseline)`);

const PORT = Number(args.port);
const CALL_TIMEOUT_MS = Number(args["call-timeout-ms"]);
const SLOW_MS = 1500;
const HANG_MS = CALL_TIMEOUT_MS + 2000; // processor hangs longer than the agent waits
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${args.agent}_seed${args.seed}`;
const money = (n: number) => n.toFixed(2);

function step(msg: string) {
  console.log(`\n▸ ${msg}`);
}

async function waitForProcessor(proc: ChildProcess) {
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) throw new Error("processor exited during startup");
    try {
      await fetch(`http://127.0.0.1:${PORT}/refunds/ping`, { signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("processor did not start within 10s");
}

step("Resetting both databases");
const seeded = spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);
console.log(`  ${seeded.stdout.trim()}`);

step(`Starting processor (naive) seed=${args.seed} lost=${args.lost} slow=${args.slow} fail=${args.fail} down=${args.down}`);
const processor = spawn(
  "npx",
  ["tsx", "processor/server.ts", "--port", String(PORT), "--seed", args.seed!, "--lost", args.lost!, "--slow", args.slow!,
    "--fail", args.fail!, "--down", args.down!, "--mode", "naive", "--hang-ms", String(HANG_MS), "--slow-ms", String(SLOW_MS)],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
const processorLog: string[] = [];
processor.stdout!.on("data", (d) => processorLog.push(...String(d).trim().split("\n")));
processor.stderr!.on("data", (d) => processorLog.push(...String(d).trim().split("\n")));
const stopProcessor = () => processor.exitCode === null && processor.kill("SIGTERM");
process.on("exit", stopProcessor);

const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 3 });
const trace = new Trace(runId);

try {
  await waitForProcessor(processor);

  const allTickets: Ticket[] = JSON.parse(readFileSync(join(ROOT, "data/sample/tickets.json"), "utf8"));
  const tickets = allTickets.slice(0, Number(args.tickets));
  step(`Running ${args.agent} agent on ${tickets.length} tickets (SAMPLE_MODE=${process.env.SAMPLE_MODE ?? "false"})`);

  const outcomes: Record<TicketOutcome, number> = { refunded: 0, declined: 0, failed: 0, timed_out: 0, error: 0 };
  for (const ticket of tickets) {
    const t0 = Date.now();
    const { outcome } = await runBaseline(ticket, { ordersDb, processorUrl: `http://127.0.0.1:${PORT}`, trace, callTimeoutMs: CALL_TIMEOUT_MS });
    outcomes[outcome]++;
    console.log(`  ${ticket.ticket_id} ${ticket.order_id} → ${outcome} (${Date.now() - t0}ms)`);
  }

  // slow_confirm writes its log row late; let those land before reading the truth.
  await new Promise((r) => setTimeout(r, SLOW_MS + 1000));
  stopProcessor();

  step("Asking Zetaris what was actually paid (dumen.refund_truth)");
  const truth = await getAllRefundTruth();
  const byOrder = new Map<string, { payments: number; paid: number; keys: string[] }>();
  for (const r of truth) {
    if (!r.order_id || r.success_count === 0) continue;
    const o = byOrder.get(r.order_id) ?? { payments: 0, paid: 0, keys: [] };
    o.payments += r.success_count;
    o.paid += r.paid_amount;
    o.keys.push(`${r.refund_key}×${r.success_count}`);
    byOrder.set(r.order_id, o);
  }
  const runRows = truth.filter((r) => r.refund_key.startsWith("rf_T-"));
  const totalRefunded = runRows.reduce((s, r) => s + r.paid_amount, 0);
  const doubles = [...byOrder.entries()].filter(([, o]) => o.payments > 1);
  // Everything paid beyond the first payment per order is money lost.
  const moneyLost = doubles.reduce((s, [, o]) => s + (o.paid - o.paid / o.payments), 0);

  for (const [orderId, o] of doubles) console.log(`  DOUBLE  ${orderId}  paid ${o.payments}× = ${money(o.paid)}  [${o.keys.join(", ")}]`);

  const summary = {
    run_id: runId,
    agent: args.agent,
    seed: Number(args.seed),
    rates: { lost: Number(args.lost), slow: Number(args.slow), fail: Number(args.fail), down: Number(args.down) },
    sample_mode: process.env.SAMPLE_MODE === "true",
    tickets_processed: tickets.length,
    outcomes,
    processor_calls: processorLog.filter((l) => l.includes("POST /refund")).length,
    total_refunded: Number(money(totalRefunded)),
    double_refunds: doubles.length,
    money_lost: Number(money(moneyLost)),
    doubles: doubles.map(([order_id, o]) => ({ order_id, payments: o.payments, paid: Number(money(o.paid)), keys: o.keys })),
  };
  writeFileSync(join(ROOT, "logs", runId, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(ROOT, "logs", runId, "processor.log"), processorLog.join("\n") + "\n");

  console.log(`
════════════════ ${args.agent} · seed ${args.seed} · lost ${args.lost} ════════════════
  tickets processed : ${summary.tickets_processed}  (${Object.entries(outcomes).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")})
  processor calls   : ${summary.processor_calls}
  total refunded    : ${money(totalRefunded)}
  DOUBLE refunds    : ${summary.double_refunds}
  money lost        : ${money(moneyLost)}
  trace             : logs/${runId}/trace.jsonl`);
} finally {
  stopProcessor();
  await ordersDb.end();
}
