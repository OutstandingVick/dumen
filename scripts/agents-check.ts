// Drives the Dumen agents through each processor behaviour and checks the outcome
// against the processor log. Uses sample-mode intake and a scratch memory file.
// npm run agents:check
import "dotenv/config";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = `agents-check-${Date.now()}`;
process.env.SAMPLE_MODE = "true";
process.env.DUMEN_MEMORY_PATH = join(ROOT, "logs", runId, "long_term.json");

const { runDumen } = await import("../agents/dumen.js");
const { openWorld } = await import("../runtime/world/index.js");
const { openMemory } = await import("../runtime/memory/index.js");
const { Trace } = await import("../runtime/trace.js");

const PORT = 4011;
const tickets = JSON.parse(readFileSync(join(ROOT, "data/sample/tickets.json"), "utf8"));
const byId = (id: string) => tickets.find((t: any) => t.ticket_id === id);

const seeded = spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
if (seeded.status !== 0) throw new Error(seeded.stderr);

const world = openWorld(runId);
const memory = openMemory({ runId });
const trace = new Trace(runId);
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const processorDb = new pg.Pool({ connectionString: process.env.PROCESSOR_DATABASE_URL, max: 2 });
const deps = {
  world,
  memory,
  trace,
  ordersDb,
  processorUrl: `http://127.0.0.1:${PORT}`,
  callTimeoutMs: 2000,
  verifier: { defaultWaitMs: 2500, maxWaitMs: 8000, pollMs: 300 },
};

async function withProcessor<T>(flags: string[], fn: () => Promise<T>): Promise<T> {
  const p = spawn("npx", ["tsx", "processor/server.ts", "--port", String(PORT), "--hang-ms", "4000", "--slow-ms", "1500", ...flags], { cwd: ROOT, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${deps.processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return await fn();
  } finally {
    p.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function payments(refundKey: string): Promise<number> {
  const { rows } = await processorDb.query("SELECT count(*)::int AS n FROM processor_log WHERE refund_key = $1 AND processor_status = 'succeeded'", [refundKey]);
  return rows[0].n;
}
async function orderPayments(orderId: string): Promise<number> {
  const { rows } = await ordersDb.query("SELECT refund_key FROM refunds WHERE order_id = $1", [orderId]);
  let n = 0;
  for (const r of rows) n += await payments(r.refund_key);
  return n;
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function scenario(label: string, flags: string[], ticketId: string, want: string, wantPayments: number) {
  await withProcessor(flags, async () => {
    const t0 = Date.now();
    const r = await runDumen(byId(ticketId), deps);
    const key = world.store.entity(world.store.entities().find((e) => e.ticketId === ticketId)!.id)!.refundKey;
    const paid = await orderPayments(byId(ticketId).order_id);
    check(`${label}: ${ticketId} → ${want}, order paid ${wantPayments}×`, r.state === want && paid === wantPayments, `got ${r.state}, ${r.executions} call(s), order paid ${paid}×, key ${key}, ${Date.now() - t0}ms`);
  });
}

// Already paid behind "pending", the malicious re-send, and the conflict — processor healthy.
await scenario("already paid (pending internally)", ["--seed", "1"], "T-017", "REJECTED", 1);
await scenario("already paid (pending internally)", ["--seed", "1"], "T-018", "REJECTED", 1);
await scenario("malicious re-send", ["--seed", "1"], "T-020", "REJECTED", 1);
await scenario("conflict order", ["--seed", "1"], "T-021", "ESCALATED", 0);
await scenario("never paid before", ["--seed", "1"], "T-019", "CONFIRMED", 1);
// Each chaos behaviour on a fresh ticket.
await scenario("lost_response", ["--seed", "1", "--lost", "1"], "T-001", "CONFIRMED", 1);
await scenario("slow_confirm", ["--seed", "1", "--slow", "1"], "T-002", "CONFIRMED", 1);
// 502s are verified, then retried with the same key from the shared budget (max 2).
await scenario("real_fail then ok (502 → verify → retry)", ["--seed", "8", "--fail", "0.5"], "T-003", "CONFIRMED", 1);
await scenario("real_fail ×3 (retries exhausted)", ["--seed", "1", "--fail", "1"], "T-005", "ESCALATED", 0);
await scenario("down (never answers, never pays)", ["--seed", "1", "--down", "1"], "T-004", "ESCALATED", 0);

// Evidence trail
const traceLines = readFileSync(trace.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const handoffs = new Set(traceLines.map((l) => l.action).filter((a: string) => a.includes("→")));
check("trace shows verifier→intake, verifier→executor and verifier→escalation", ["verifier→intake: reject_already_paid", "verifier→executor: retry_same_key", "verifier→escalation: escalate"].every((h) => handoffs.has(h)), [...handoffs].join(" | "));
const t020 = traceLines.find((l) => l.ticket_id === "T-020" && l.action.startsWith("verifier→intake"));
check("T-020 rejection carries the Zetaris rows as evidence", !!t020 && t020.input.rows.length > 0 && t020.output.truth === "paid", t020?.reason);
const queuePath = join(dirname(trace.path), "escalations.json");
const queue = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : [];
const t003 = traceLines.filter((l) => l.ticket_id === "T-003").map((l) => l.action);
check("T-003 trail: 502 → verify → retry_same_key → 200", t003.join(">").includes("call_refund>verifier→executor: retry_same_key>call_refund"), t003.join(" > "));
const t005 = world.store.entity(world.store.entities().find((e) => e.ticketId === "T-005")!.id)!;
check("T-005 used the shared retry budget: 3 calls, same key", t005.executions === 3 && t005.retries === 2);
check("escalation queue has T-021, T-004 and T-005 cases", ["T-021", "T-004", "T-005"].every((id) => queue.some((c: any) => c.ticket_id === id)), queue.map((c: any) => `${c.ticket_id}:${c.summary_source}`).join(", "));
check("world recorded no invariant alerts", world.store.health().alerts === 0, JSON.stringify(world.store.health().states));
const lessons = memory.store.all().map((m) => `${m.data.kind}×${m.data.observations}`);
check("verifier mined memory lessons", lessons.some((l) => l.startsWith("settle_delay")), lessons.join(", "));

console.log(`\n${pass} passed, ${fail} failed · logs/${runId}/`);
await ordersDb.end();
await processorDb.end();
if (!fail) rmSync(join(ROOT, "logs", runId), { recursive: true }); // keep logs only when something failed
process.exit(fail ? 1 : 0);
