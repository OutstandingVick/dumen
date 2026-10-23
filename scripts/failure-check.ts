// Fail-safe drills: when a dependency is down, Dumen must never pay on a guess.
//   1. Zetaris down for a whole run   → nothing executed, every refund escalated
//   2. Zetaris down mid-flight        → the lost-response refund is NOT retried; escalated
//   3. Nightshift down for a whole run → no model decision = no refund; run finishes cleanly
//   4. Processor down                 → retries capped at 2, then escalated
// npm run failure:check
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `failure-check-${Date.now()}`;
process.env.SAMPLE_MODE = "true";
process.env.DUMEN_MEMORY_PATH = join(ROOT, "logs", runId, "long_term.json");

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function chaos(flags: string[]): any {
  const r = spawnSync("npx", ["tsx", "scripts/chaos.ts", "--agent", "dumen", "--seed", "42", "--lost", "0.2", "--quiet", "--fresh-memory", ...flags], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 8 * 60_000,
  });
  const line = r.stdout.split("\n").find((l) => l.startsWith("@@RESULT "));
  if (r.status !== 0 || !line) throw new Error(`chaos ${flags.join(" ")} failed (exit ${r.status}): ${r.stderr.slice(-400)}`);
  return JSON.parse(line.slice("@@RESULT ".length));
}

function traceOf(runIdOf: string): any[] {
  return readFileSync(join(ROOT, "logs", runIdOf, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

// 1. Zetaris down for the whole run
{
  const r = chaos(["--cached-intake", "--zetaris-down"]);
  check("zetaris down: 0 processor calls, 0 paid", r.processor_calls === 0 && r.total_refunded === 0, `calls ${r.processor_calls}, refunded ${r.total_refunded}`);
  check("zetaris down: every refund escalated, 0 doubles", r.outcomes.ESCALATED === r.tickets_processed && r.double_refunds === 0, JSON.stringify(r.outcomes));
  check("zetaris down: run flagged for the dashboard banner", r.failures?.zetaris_down === true);
  const reasons = traceOf(r.run_id).filter((t) => t.action === "verifier→escalation: escalate_at_intake").map((t) => t.reason);
  check("zetaris down: trace says why", reasons.length === r.tickets_processed && reasons.every((x: string) => x.includes("refund_truth unavailable")), reasons[0]?.slice(0, 80));
}

// 3. Nightshift down for the whole run (live intake against a refusing endpoint)
{
  const t0 = Date.now();
  const r = chaos(["--nightshift-down"]);
  check("nightshift down: run finished, 0 processor calls", r.processor_calls === 0 && r.total_refunded === 0, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
  check("nightshift down: already-paid still rejected with evidence, the rest escalated", r.outcomes.REJECTED === 3 && r.outcomes.ESCALATED === r.tickets_processed - 3, JSON.stringify(r.outcomes));
  check("nightshift down: run flagged for the dashboard banner", r.failures?.nightshift_down === true);
  const decide = traceOf(r.run_id).filter((t) => t.action === "decide");
  check("nightshift down: trace says the model gave no decision", decide.length === r.tickets_processed && decide.every((d) => d.reason === "no usable model decision"), decide[0]?.output?.raw?.slice(0, 80));
}

// 2 and 4 drive the agents directly, so Zetaris can fail at an exact moment.
const { execute } = await import("../agents/executor.js");
const { verifyAfterUncertainCall } = await import("../agents/verifier.js");
const { executeUntilSettled } = await import("../agents/dumen.js");
const { openWorld } = await import("../runtime/world/index.js");
const { openMemory } = await import("../runtime/memory/index.js");
const { Trace } = await import("../runtime/trace.js");

spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, timeout: 60_000 });
const world = openWorld(runId);
const memory = openMemory({ runId, fresh: true });
const trace = new Trace(runId);
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const processorDb = new pg.Pool({ connectionString: process.env.PROCESSOR_DATABASE_URL, max: 2 });
const PORT = 4013;
const processorUrl = `http://127.0.0.1:${PORT}`;
const verifier = { defaultWaitMs: 1500, maxWaitMs: 4000, pollMs: 300 };
const realZetaris = process.env.ZETARIS_URL;

async function withProcessor<T>(flags: string[], fn: () => Promise<T>): Promise<T> {
  const p = spawn("npx", ["tsx", "processor/server.ts", "--port", String(PORT), "--hang-ms", "3000", ...flags], { cwd: ROOT, stdio: "ignore" });
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

async function approved(ticketId: string, orderId: string, amount: number) {
  const { entity } = await world.ingest.receive({ ticket_id: ticketId, order_id: orderId, amount_requested: amount }, { agentId: "dumen", taskId: ticketId });
  const actor = { agentId: "intake", taskId: ticketId };
  await world.ingest.transition(entity.id, "INTAKE_REVIEW", actor, { provenance: { source: "ticket" } });
  await world.ingest.transition(entity.id, "APPROVED", actor, { provenance: { source: "policy", note: "failure-check" }, data: { amount } });
  return entity.id;
}

async function paid(refundKey: string): Promise<number> {
  const { rows } = await processorDb.query("SELECT count(*)::int AS n FROM processor_log WHERE refund_key = $1 AND processor_status = 'succeeded'", [refundKey]);
  return rows[0].n;
}

// 2. The processor pays but the reply is lost; then Zetaris goes down before the check.
await withProcessor(["--seed", "1", "--lost", "1"], async () => {
  const id = await approved("T-901", "ORD-1027", 50);
  const exec = await execute(id, { world, trace, ordersDb, processorUrl, callTimeoutMs: 1500 });
  process.env.ZETARIS_URL = "http://127.0.0.1:59999";
  const v = await verifyAfterUncertainCall(id, exec.callStartedAt, exec.state === "UNKNOWN" ? exec.uncertainty : "timeout", { world, memory, trace, ...verifier });
  process.env.ZETARIS_URL = realZetaris;
  const e = world.store.entity(id)!;
  check("zetaris down mid-flight: escalated, not retried", v.decision === "ESCALATED" && e.executions === 1, v.reason);
  check("zetaris down mid-flight: processor paid exactly once", (await paid(e.refundKey)) === 1);
});

// 4. Processor completely down: capped retries, then escalation (Zetaris up).
await withProcessor(["--seed", "1", "--down", "1"], async () => {
  const id = await approved("T-902", "ORD-1028", 60);
  const state = await executeUntilSettled(id, "drill", { world, memory, trace, ordersDb, processorUrl, callTimeoutMs: 1500, verifier, modelSummaries: false });
  const e = world.store.entity(id)!;
  check("processor down: 3 calls (2 retries), then escalated, nothing paid", state === "ESCALATED" && e.executions === 3 && (await paid(e.refundKey)) === 0, `${e.executions} calls`);
});

check("no invariant alerts in the drills", world.store.health().alerts === 0, JSON.stringify(world.store.health().states));

console.log(`\n${pass} passed, ${fail} failed`);
await ordersDb.end();
await processorDb.end();
if (!fail) rmSync(join(ROOT, "logs", runId), { recursive: true }); // keep the drill's own logs only on failure
process.exit(fail ? 1 : 0);
