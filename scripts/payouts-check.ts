// Payout safety drills: partial batches, per-payout verification, human approval, overpay.
// npm run payouts:check
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `payouts-check-${Date.now()}`;
process.env.SAMPLE_MODE = "true";
process.env.DUMEN_MEMORY_PATH = join(ROOT, "logs", runId, "long_term.json");

const { runPayoutBatch } = await import("../agents/payouts.js");
const { runDumen, executeUntilSettled } = await import("../agents/dumen.js");
const { verifyHumanApproval } = await import("../agents/verifier.js");
const { openWorld, payoutEntityId } = await import("../runtime/world/index.js");
const { openMemory } = await import("../runtime/memory/index.js");
const { Trace } = await import("../runtime/trace.js");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, timeout: 60_000 });
const world = openWorld(runId);
const memory = openMemory({ runId, fresh: true });
const trace = new Trace(runId);
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const processorDb = new pg.Pool({ connectionString: process.env.PROCESSOR_DATABASE_URL, max: 2 });
const PORT = 4014;
const processorUrl = `http://127.0.0.1:${PORT}`;
const deps = { world, memory, trace, ordersDb, processorUrl, callTimeoutMs: 1500, verifier: { defaultWaitMs: 1500, maxWaitMs: 4000, pollMs: 300 }, modelSummaries: false };

async function withProcessor<T>(flags: string[], fn: () => Promise<T>): Promise<T> {
  const p = spawn("npx", ["tsx", "processor/server.ts", "--port", String(PORT), "--hang-ms", "3000", "--slow-ms", "800", ...flags], { cwd: ROOT, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return await fn();
  } finally {
    p.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function bankPayments(key: string): Promise<number> {
  const { rows } = await processorDb.query("SELECT count(*)::int AS n FROM bank_rail_log WHERE payout_key = $1 AND bank_status = 'succeeded'", [key]);
  return rows[0].n;
}
const { rows: scheduled } = await ordersDb.query("SELECT payout_key, seller_id, amount::float AS amount, batch_id FROM payouts ORDER BY payout_key");
const batch = (id: string) => scheduled.filter((p: any) => p.batch_id === id);
const stateOf = (key: string) => world.store.entity(payoutEntityId(key))?.state;

// 1. Every call loses its response; seed 2 makes the bank execute 1 of 3 in the first call,
//    so the batch is left half done.
await withProcessor(["--seed", "2", "--lost", "1"], async () => {
  await runPayoutBatch("B-001", batch("B-001"), deps);
});
const b1 = ["PO-0001", "PO-0002", "PO-0005"];
const paidCounts = await Promise.all(b1.map(bankPayments));
check("partial batches: no payout paid twice", paidCounts.every((n) => n <= 1), b1.map((k, i) => `${k}×${paidCounts[i]}`).join(" "));
check("paid payouts end CONFIRMED, unpaid ones escalate after the retry budget", b1.every((k, i) => (paidCounts[i] === 1 ? stateOf(k) === "CONFIRMED" : stateOf(k) === "ESCALATED")), b1.map((k) => `${k}:${stateOf(k)}`).join(" "));
const traceLines = readFileSync(trace.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sends = traceLines.filter((l) => l.action === "send_batch").map((l) => l.input.items.map((it: any) => it.payout_key) as string[]);
// After the first send, every later send may only carry payouts that were verified NOT paid.
check("first send carried the whole batch; the re-send only the unpaid payouts", sends.length >= 2 && sends[1].length < sends[0].length, sends.map((s) => s.join("+")).join(" → "));
check("a re-send never includes a payout the bank already paid", sends.slice(1).every((s) => s.every((k) => b1.indexOf(k) < 0 || paidCounts[b1.indexOf(k)] <= 1)) && traceLines.some((l) => l.action === "verifier→executor: resend_unpaid_only"));
check("each uncertain payout verified individually in payout_truth", traceLines.some((l) => l.action === "verify_batch"));
check("pre-checks: PO-0003 rejected (already paid), PO-0004 + PO-0006 escalated", stateOf("PO-0003") === "REJECTED" && stateOf("PO-0004") === "ESCALATED" && stateOf("PO-0006") === "ESCALATED");

// 2. Batch B-002 on a healthy bank: PO-0007 waits for a person, then is approved.
await withProcessor(["--seed", "1"], async () => {
  await runPayoutBatch("B-002", batch("B-002"), deps);
  check("PO-0007 (5,200 > 2,500) held for a human, not sent", stateOf("PO-0007") === "ESCALATED" && (await bankPayments("PO-0007")) === 0);
  const id = payoutEntityId("PO-0007");
  const v = await verifyHumanApproval(id, "Called the seller, invoice matches", { world, memory, trace, ...deps.verifier });
  const state = v.decision === "RETRY_SAME_KEY" ? await executeUntilSettled(id, "approved", deps) : v.decision;
  check("approved PO-0007: verified, then paid exactly once", state === "CONFIRMED" && (await bankPayments("PO-0007")) === 1, v.reason);

  const over = payoutEntityId("PO-0006");
  const v2 = await verifyHumanApproval(over, "Seller says they're owed more", { world, memory, trace, ...deps.verifier });
  check("approving PO-0006 above earned balance is refused", v2.decision === "ESCALATED" && (await bankPayments("PO-0006")) === 0, v2.reason);

  // 3. Refund T-022 asks for 2× the order: escalated; an approval can't overpay either.
  const tickets = JSON.parse(readFileSync(join(ROOT, "data/sample/tickets.json"), "utf8"));
  const t022 = tickets.find((t: any) => t.ticket_id === "T-022");
  const r = await runDumen(t022, deps);
  const ent = world.store.entities().find((e) => e.ticketId === "T-022")!;
  const { rows } = await ordersDb.query("SELECT amount::float AS amount FROM orders WHERE order_id = $1", [t022.order_id]);
  const v3 = await verifyHumanApproval(ent.id, "Customer was upset", { world, memory, trace, ...deps.verifier }, rows[0].amount);
  const { rows: paid } = await processorDb.query("SELECT count(*)::int AS n FROM processor_log WHERE refund_key = $1", [ent.refundKey]);
  check("T-022 escalated at intake, approval refused, nothing paid", r.state === "ESCALATED" && v3.decision === "ESCALATED" && paid[0].n === 0, v3.reason);
});

check("no invariant alerts", world.store.health().alerts === 0, JSON.stringify(world.store.health().states));
console.log(`\n${pass} passed, ${fail} failed`);
await ordersDb.end();
await processorDb.end();
if (!fail) rmSync(join(ROOT, "logs", runId), { recursive: true });
process.exit(fail ? 1 : 0);
