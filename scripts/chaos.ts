// One command runs an agent against the chaotic processor and reports what was really paid:
//   npm run chaos -- --agent baseline --seed 42 --lost 0.2      (the bug)
//   npm run chaos -- --agent dumen    --seed 42 --lost 0.2      (the fix)
// Resets both databases, starts the mock processor (always naive mode) with seeded chaos,
// runs the agent over the tickets, then asks Zetaris (refund_truth) what was actually paid.
// Prints a report and writes logs/<runId>/summary.json; the last line is a JSON result
// marker that scripts/compare.ts reads.
import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { runBaseline } from "../agents/baseline.js";
import { runBaselinePayoutBatch } from "../agents/baseline-payouts.js";
import { runPayoutBatch, type ScheduledPayout } from "../agents/payouts.js";
import { PAYOUT_APPROVAL_THRESHOLD } from "../agents/verifier.js";
import { runDumen, type DumenResult } from "../agents/dumen.js";
import type { IntakeDecision, Ticket } from "../agents/intake.js";
import { generator } from "../runtime/generator.js";
import { openMemory, PROMOTION_POLICY } from "../runtime/memory/index.js";
import { Trace } from "../runtime/trace.js";
import { openWorld } from "../runtime/world/index.js";
import { getAllPayoutTruth, getAllRefundTruth } from "../runtime/zetaris.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTAKE_CACHE = join(ROOT, "samples", "intake_cache.json");

const { values: args } = parseArgs({
  allowNegative: true, // --no-payouts
  options: {
    agent: { type: "string", default: "baseline" },
    tickets: { type: "string", default: "22" },
    seed: { type: "string", default: "42" },
    lost: { type: "string", default: "0.2" },
    slow: { type: "string", default: "0" },
    fail: { type: "string", default: "0" },
    down: { type: "string", default: "0" },
    port: { type: "string", default: "4010" },
    "call-timeout-ms": { type: "string", default: "3000" },
    concurrency: { type: "string" },
    "cached-intake": { type: "boolean", default: false },
    "save-intake": { type: "boolean", default: false },
    payouts: { type: "boolean", default: true }, // after the refunds, run the seller payout batches
    "fresh-memory": { type: "boolean", default: false }, // ignore and don't touch saved H-MEM lessons
    // Failure drills: point the client at a closed port, so the real "connection refused"
    // path runs. Zetaris comes back before the final report so the run can still be scored.
    "zetaris-down": { type: "boolean", default: false },
    "nightshift-down": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});
if (args.agent !== "baseline" && args.agent !== "dumen") throw new Error(`unknown agent "${args.agent}" (baseline | dumen)`);

const PORT = Number(args.port);
const CALL_TIMEOUT_MS = Number(args["call-timeout-ms"]);
const SLOW_MS = 1500;
const HANG_MS = CALL_TIMEOUT_MS + 2000; // processor hangs longer than the agent waits
const CONCURRENCY = Number(args.concurrency ?? (args.agent === "dumen" ? 4 : 1));
const SAMPLE_MODE = process.env.SAMPLE_MODE === "true" && !args["nightshift-down"];
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}_${args.agent}_seed${args.seed}`;
const money = (n: number) => n.toFixed(2);
const log = (msg: string) => !args.quiet && console.log(msg);
const step = (msg: string) => log(`\n▸ ${msg}`);

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

// Run items through fn with at most `limit` in flight, keeping input order in the results.
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const DEAD_URL = "http://127.0.0.1:59999"; // a closed port: real ECONNREFUSED
const zetarisUrl = process.env.ZETARIS_URL;
if (args["nightshift-down"]) {
  if (args["cached-intake"]) throw new Error("--nightshift-down needs live intake; drop --cached-intake");
  process.env.SAMPLE_MODE = "false";
  process.env.NIGHTSHIFT_BASE_URL = `${DEAD_URL}/v1`;
  process.env.NIGHTSHIFT_API_KEY ||= "simulated-outage";
  process.env.NIGHTSHIFT_MODEL ||= "simulated-outage";
}

let cachedIntake: Record<string, IntakeDecision> | undefined;
if (args["cached-intake"]) {
  if (!existsSync(INTAKE_CACHE)) throw new Error(`--cached-intake needs ${INTAKE_CACHE}; create it with a live run and --save-intake`);
  cachedIntake = JSON.parse(readFileSync(INTAKE_CACHE, "utf8")).decisions;
}
const intakeMode = args.agent === "baseline" ? (SAMPLE_MODE ? "sample" : "live") : cachedIntake ? "cached" : SAMPLE_MODE ? "sample" : "live";

step("Resetting both databases");
const seeded = spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
if (seeded.status !== 0) throw new Error(`seed failed: ${seeded.stderr || seeded.stdout}`);
log(`  ${seeded.stdout.trim()}`);

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

const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: CONCURRENCY + 2 });
const trace = new Trace(runId);
const runDir = dirname(trace.path);
const t0 = Date.now();

try {
  await waitForProcessor(processor);
  const allTickets: Ticket[] = JSON.parse(readFileSync(join(ROOT, "data/sample/tickets.json"), "utf8"));
  const tickets = allTickets.slice(0, Number(args.tickets));

  // Nemotron cold start: one throwaway call so the first ticket doesn't pay for it.
  if (intakeMode === "live") {
    step("Warming up the model");
    const w0 = Date.now();
    try {
      await generator("Reply with the word ready.", null, "Reply with one word.");
      log(`  warm in ${Date.now() - w0}ms`);
    } catch (e: any) {
      log(`  warm-up failed after ${Date.now() - w0}ms (${e.message}); continuing`);
    }
  }

  if (args["zetaris-down"]) {
    step("Simulating a Zetaris outage for the agent phase");
    process.env.ZETARIS_URL = DEAD_URL;
  }
  if (args["nightshift-down"]) step("Simulating a Nightshift outage: the model endpoint refuses connections");

  step(`Running ${args.agent} on ${tickets.length} tickets · concurrency ${CONCURRENCY} · intake ${intakeMode}`);
  const outcomes: Record<string, number> = {};
  const count = (k: string) => (outcomes[k] = (outcomes[k] ?? 0) + 1);
  let dumenResults: DumenResult[] = [];
  let manifest: unknown = null;
  const payoutStates = new Map<string, string>(); // payout_key → final state (dumen) or batch outcome (baseline)

  // Payouts run after every refund, so refund chaos (the processor's seeded call order) is
  // exactly what it was before payouts existed.
  const { rows: scheduled } = await ordersDb.query<ScheduledPayout>(
    "SELECT payout_key, seller_id, amount::float AS amount, batch_id FROM payouts WHERE internal_status = 'pending' ORDER BY batch_id, payout_key",
  );
  const batches = new Map<string, ScheduledPayout[]>();
  if (args.payouts) for (const p of scheduled) batches.set(p.batch_id, [...(batches.get(p.batch_id) ?? []), p]);

  if (args.agent === "baseline") {
    await pool(tickets, CONCURRENCY, async (ticket) => {
      const s = Date.now();
      const { outcome } = await runBaseline(ticket, { ordersDb, processorUrl: `http://127.0.0.1:${PORT}`, trace, callTimeoutMs: CALL_TIMEOUT_MS });
      count(outcome);
      log(`  ${ticket.ticket_id} ${ticket.order_id} → ${outcome} (${Date.now() - s}ms)`);
    });
    if (batches.size) step(`Running baseline payouts: ${scheduled.length} payouts in ${batches.size} batches`);
    for (const [batchId, list] of batches) {
      const s = Date.now();
      const outcome = await runBaselinePayoutBatch(batchId, list, { ordersDb, processorUrl: `http://127.0.0.1:${PORT}`, trace, callTimeoutMs: CALL_TIMEOUT_MS });
      for (const p of list) payoutStates.set(p.payout_key, outcome);
      log(`  ${batchId} (${list.length} payouts) → ${outcome} (${Date.now() - s}ms)`);
    }
  } else {
    const world = openWorld(runId);
    const fresh = args["fresh-memory"];
    const memory = openMemory({ runId, fresh });
    log(fresh ? "  H-MEM: fresh memory (saved lessons ignored, nothing persisted)" : `  H-MEM: ${memory.hydrated} long-term memories hydrated`);
    dumenResults = await pool(tickets, CONCURRENCY, async (ticket) => {
      const s = Date.now();
      const r = await runDumen(ticket, {
        world,
        memory,
        trace,
        ordersDb,
        processorUrl: `http://127.0.0.1:${PORT}`,
        callTimeoutMs: CALL_TIMEOUT_MS,
        verifier: { defaultWaitMs: 2000, maxWaitMs: 8000, pollMs: 300 },
        cachedIntake,
        modelSummaries: intakeMode === "live",
      });
      count(r.state);
      log(`  ${ticket.ticket_id} ${ticket.order_id} → ${r.state}${r.executions ? ` (${r.executions} call${r.executions > 1 ? "s" : ""})` : ""} (${Date.now() - s}ms)`);
      return r;
    });

    if (batches.size) step(`Running Dumen payouts: ${scheduled.length} payouts in ${batches.size} batches`);
    for (const [batchId, list] of batches) {
      const s = Date.now();
      const results = await runPayoutBatch(batchId, list, {
        world,
        memory,
        trace,
        ordersDb,
        processorUrl: `http://127.0.0.1:${PORT}`,
        callTimeoutMs: CALL_TIMEOUT_MS,
        verifier: { defaultWaitMs: 2000, maxWaitMs: 8000, pollMs: 300 },
        modelSummaries: intakeMode === "live",
      });
      for (const r of results) payoutStates.set(r.payoutKey, r.state);
      log(`  ${batchId} → ${results.map((r) => `${r.payoutKey} ${r.state}${r.executions ? ` (${r.executions})` : ""}`).join(", ")} (${Date.now() - s}ms)`);
    }

    // Run end: promote lessons that meet the policy, persist long-term memory.
    // With --fresh-memory the lessons still drive this run, but nothing is saved for the next.
    const promoted = memory.store.promote(PROMOTION_POLICY, "policy:auto");
    const persisted = fresh ? 0 : memory.store.persist();
    log(`  H-MEM: ${promoted.length} lesson(s) promoted${fresh ? " (not persisted)" : `, ${persisted} long-term memories saved`}`);
    manifest = { world: world.context.manifest(), worldHealth: world.store.health(), memory: { fresh, hydrated: memory.hydrated, promoted: promoted.map((m) => m.id), longTerm: persisted } };

    if (args["save-intake"]) {
      if (intakeMode !== "live") throw new Error("--save-intake only makes sense on a live run");
      const decisions = Object.fromEntries(dumenResults.filter((r) => r.decision).map((r) => [r.ticketId, r.decision]));
      mkdirSync(dirname(INTAKE_CACHE), { recursive: true });
      writeFileSync(INTAKE_CACHE, JSON.stringify({ saved_at: new Date().toISOString(), run_id: runId, decisions }, null, 2) + "\n");
      log(`  saved ${Object.keys(decisions).length} intake decisions → samples/intake_cache.json`);
    }
  }

  // slow_confirm writes its log row late; let those land before reading the truth.
  await new Promise((r) => setTimeout(r, SLOW_MS + 1000));
  stopProcessor();
  if (args["zetaris-down"]) {
    process.env.ZETARIS_URL = zetarisUrl;
    log("  Zetaris outage over (restored for the report)");
  }

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
  const runRows = truth.filter((r) => !r.refund_key.startsWith("rf_hist_"));
  const totalRefunded = runRows.reduce((s, r) => s + r.paid_amount, 0);
  const doubles = [...byOrder.entries()].filter(([, o]) => o.payments > 1);
  // Money lost = everything paid on an order beyond what it was worth: second payments and
  // overpayments alike.
  const { rows: orderRows } = await ordersDb.query<{ order_id: string; amount: string }>("SELECT order_id, amount FROM orders");
  const orderAmount = new Map(orderRows.map((o) => [o.order_id, Number(o.amount)]));
  const excess = (orderId: string, o: { paid: number }) => Math.max(0, o.paid - (orderAmount.get(orderId) ?? o.paid));
  const moneyLost = [...byOrder.entries()].reduce((s, [id, o]) => s + excess(id, o), 0);
  const overpaid = [...byOrder.entries()].filter(([id, o]) => o.payments === 1 && excess(id, o) > 0.005);
  for (const [orderId, o] of doubles) log(`  DOUBLE  ${orderId}  paid ${o.payments}× = ${money(o.paid)}  [${o.keys.join(", ")}]`);
  for (const [orderId, o] of overpaid) log(`  OVERPAID  ${orderId}  paid ${money(o.paid)} on a ${money(orderAmount.get(orderId) ?? 0)} order`);

  // Payouts, from payout_truth: duplicates, money beyond what was owed (scheduled amount,
  // capped at the seller's earned balance), and risky payments that went out.
  let payoutSummary: Record<string, unknown> | undefined;
  if (batches.size) {
    step("Asking Zetaris what the bank actually paid (dumen.payout_truth)");
    const pt = await getAllPayoutTruth();
    const owedPayout = (p: (typeof pt)[number]) => Math.min(p.amount, p.earned_balance);
    const isNew = (p: (typeof pt)[number]) => p.payout_key !== "PO-0003" && p.payout_key !== "PO-0008"; // seeded as already paid
    const dupes = pt.filter((p) => p.success_count > 1);
    const payoutLost = pt.reduce((s, p) => s + Math.max(0, p.paid_amount - owedPayout(p)), 0);
    const pOut: Record<string, number> = {};
    for (const st of payoutStates.values()) pOut[st] = (pOut[st] ?? 0) + 1;
    payoutSummary = {
      batches: batches.size,
      payouts: scheduled.length,
      outcomes: pOut,
      bank_calls: processorLog.filter((l) => l.includes("POST /payouts/batch")).length,
      total_paid: Number(money(pt.filter(isNew).reduce((s, p) => s + p.paid_amount, 0))),
      duplicate_payouts: dupes.length,
      money_lost: Number(money(payoutLost)),
      overpaid: pt.filter((p) => p.success_count >= 1 && p.paid_amount > p.earned_balance + 0.005).map((p) => p.payout_key),
      changed_account_paid: pt.filter((p) => p.account_changed_recently && p.success_count > 0).map((p) => p.payout_key),
      high_value_paid: pt.filter((p) => p.amount > PAYOUT_APPROVAL_THRESHOLD && p.success_count > 0).map((p) => p.payout_key),
      escalations: escalationsOf("payout"),
      rejections: pOut.REJECTED ?? 0,
      key_payouts: { "PO-0004": payoutStates.get("PO-0004") ?? null, "PO-0006": payoutStates.get("PO-0006") ?? null, "PO-0007": payoutStates.get("PO-0007") ?? null },
      duplicates: dupes.map((p) => ({ payout_key: p.payout_key, payments: p.success_count, paid: p.paid_amount })),
    };
    for (const d of dupes) log(`  DUPLICATE PAYOUT  ${d.payout_key}  paid ${d.success_count}× = ${money(d.paid_amount)}`);
  }

  function escalationsOf(kind: "refund" | "payout"): number {
    const path = join(runDir, "escalations.json");
    const all: Array<{ kind?: string }> = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    return all.filter((c) => (c.kind ?? "refund") === kind).length;
  }
  const ticketState = (id: string) => dumenResults.find((r) => r.ticketId === id)?.state ?? null;

  const summary = {
    run_id: runId,
    agent: args.agent,
    seed: Number(args.seed),
    rates: { lost: Number(args.lost), slow: Number(args.slow), fail: Number(args.fail), down: Number(args.down) },
    intake: intakeMode,
    fresh_memory: args["fresh-memory"],
    concurrency: CONCURRENCY,
    duration_ms: Date.now() - t0,
    tickets_processed: tickets.length,
    outcomes,
    processor_calls: processorLog.filter((l) => l.includes("POST /refund")).length,
    total_refunded: Number(money(totalRefunded)),
    double_refunds: doubles.length,
    money_lost: Number(money(moneyLost)),
    overpaid_orders: overpaid.map(([order_id, o]) => ({ order_id, paid: Number(money(o.paid)), owed: orderAmount.get(order_id) })),
    escalations: escalationsOf("refund"),
    failures: { zetaris_down: args["zetaris-down"], nightshift_down: args["nightshift-down"] },
    rejections: outcomes.REJECTED ?? 0,
    key_tickets: args.agent === "dumen" ? { "T-017": ticketState("T-017"), "T-018": ticketState("T-018"), "T-020": ticketState("T-020"), "T-021": ticketState("T-021"), "T-022": ticketState("T-022") } : undefined,
    doubles: doubles.map(([order_id, o]) => ({ order_id, payments: o.payments, paid: Number(money(o.paid)), keys: o.keys })),
    payouts: payoutSummary,
  };
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(runDir, "processor.log"), processorLog.join("\n") + "\n");
  if (manifest) writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  log(`
════════════════ ${args.agent} · seed ${args.seed} · lost ${args.lost} ════════════════
  tickets processed : ${summary.tickets_processed}  (${Object.entries(outcomes).map(([k, n]) => `${k} ${n}`).join(", ")})
  processor calls   : ${summary.processor_calls}
  total refunded    : ${money(totalRefunded)}
  DOUBLE refunds    : ${summary.double_refunds}
  money lost        : ${money(moneyLost)}
  overpaid orders   : ${overpaid.length}
  escalations       : ${summary.escalations}${
    payoutSummary
      ? `
  ── payouts ──
  bank calls        : ${payoutSummary.bank_calls}
  total paid out    : ${money(payoutSummary.total_paid as number)}
  DUPLICATE payouts : ${payoutSummary.duplicate_payouts}
  money lost        : ${money(payoutSummary.money_lost as number)}
  changed-acct paid : ${(payoutSummary.changed_account_paid as string[]).join(", ") || "none"}
  high-value paid   : ${(payoutSummary.high_value_paid as string[]).join(", ") || "none"}
  escalations       : ${payoutSummary.escalations}`
      : ""
  }
  run time          : ${(summary.duration_ms / 1000).toFixed(1)}s
  logs              : logs/${runId}/`);
  console.log(`@@RESULT ${JSON.stringify(summary)}`);
} finally {
  stopProcessor();
  await ordersDb.end();
}
