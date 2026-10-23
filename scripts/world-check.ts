// Exercises the World Model: stable IDs, idempotent ingest, the state machine, the three
// invariants, concurrency, and recompute-from-log. npm run world:check
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { InvariantViolation, openWorld, refundEntityId, WorldStoreService, type TruthEvidence } from "../runtime/world/index.js";

const runId = `world-check-${Date.now()}`;
const w = openWorld(runId);
const intake = { agentId: "intake", taskId: "T-900" };
const executor = { agentId: "executor", taskId: "T-900" };
const verifier = { agentId: "verifier", taskId: "T-900" };
const ev = (truth: TruthEvidence["truth"], n: number): TruthEvidence => ({ truth, success_count: n, paid_amount: n * 10, checked_at: new Date().toISOString() });
const prov = { source: "policy" as const, note: "world-check" };

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
async function refused(p: Promise<unknown>, code: string): Promise<boolean> {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof InvariantViolation && e.code === code;
  }
}

// 1. Stable identity
check("same ticket+order → same id", refundEntityId("T-900", "ORD-1") === refundEntityId(" t-900", "ord-1 "));
check("different order → different id", refundEntityId("T-900", "ORD-1") !== refundEntityId("T-900", "ORD-2"));

// 2. Idempotent receive
const ticket = { ticket_id: "T-900", order_id: "ORD-1", amount_requested: 10, currency: "USD" };
const r1 = await w.ingest.receive(ticket, intake);
const r2 = await w.ingest.receive(ticket, intake);
const id = r1.entity.id;
check("re-receiving the same ticket is a no-op", r2.duplicate && w.store.events(id).length === 1);
check("refund_key derived from entity id", r1.entity.refundKey.startsWith("rf_") && w.context.getRefundContext(r1.entity.refundKey)?.entity.id === id);

// 3. Path to a lost confirmation
await w.ingest.transition(id, "INTAKE_REVIEW", intake, { provenance: prov });
await w.ingest.transition(id, "APPROVED", intake, { provenance: prov, data: { amount: 10 } });
const exec = await w.ingest.transition(id, "EXECUTING", executor, { provenance: prov });
const replay = await w.ingest.ingest({ ...exec.event, schemaVersion: undefined, eventId: undefined, seq: undefined, ts: undefined } as any);
check("re-ingesting the same transition is a no-op", replay.duplicate && w.store.entity(id)!.executions === 1);
await w.ingest.transition(id, "UNKNOWN", executor, { provenance: { source: "processor", response: "timeout" } });

// Invariant (b): nothing in UNKNOWN re-executes without VERIFYING
check("UNKNOWN → EXECUTING refused", await refused(w.ingest.transition(id, "EXECUTING", executor, { provenance: prov }), "ILLEGAL_TRANSITION"));
check("UNKNOWN → RETRY_SAME_KEY refused", await refused(w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: prov }), "ILLEGAL_TRANSITION"));
await w.ingest.transition(id, "VERIFYING", verifier, { provenance: prov });

// Invariant (c): leaving VERIFYING needs evidence; undecided → only ESCALATED
check("VERIFYING → RETRY without evidence refused", await refused(w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: prov }), "NO_EVIDENCE"));
check("VERIFYING → CONFIRMED on not_paid refused", await refused(w.ingest.transition(id, "CONFIRMED", verifier, { provenance: prov, evidence: ev("not_paid", 0) }), "CONFIRM_WITHOUT_PAYMENT"));
check("VERIFYING → RETRY on conflict refused", await refused(w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: prov, evidence: ev("conflict", 2) }), "RETRY_WITHOUT_PROOF"));
check("VERIFYING → RETRY on unavailable refused", await refused(w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: prov, evidence: ev("unavailable", 0) }), "RETRY_WITHOUT_PROOF"));

// Two verified retries are allowed, the third must escalate
for (let i = 1; i <= 2; i++) {
  await w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: { source: "zetaris" }, evidence: ev("not_paid", 0) });
  await w.ingest.transition(id, "EXECUTING", executor, { provenance: prov });
  await w.ingest.transition(id, "UNKNOWN", executor, { provenance: { source: "processor", response: "timeout" } });
  await w.ingest.transition(id, "VERIFYING", verifier, { provenance: prov });
}
check("third retry refused (max 2)", await refused(w.ingest.transition(id, "RETRY_SAME_KEY", verifier, { provenance: prov, evidence: ev("not_paid", 0) }), "RETRY_LIMIT"));
await w.ingest.transition(id, "ESCALATED", verifier, { provenance: prov, reason: "retries exhausted" });
const ctx = w.context.getRefundContext(id)!;
check("escalated after retries; same key throughout", ctx.entity.state === "ESCALATED" && ctx.entity.executions === 3 && ctx.terminal);
check("refused transitions recorded as alerts", ctx.alerts.length >= 6, `${ctx.alerts.length} alerts`);

// 4. Lost confirmation that actually paid → CONFIRMED, never re-executed
const t2 = (await w.ingest.receive({ ticket_id: "T-901", order_id: "ORD-2" }, intake)).entity.id;
for (const s of ["INTAKE_REVIEW", "APPROVED", "EXECUTING", "UNKNOWN", "VERIFYING"] as const) await w.ingest.transition(t2, s, executor, { provenance: prov });
await w.ingest.transition(t2, "CONFIRMED", verifier, { provenance: { source: "zetaris" }, evidence: ev("paid", 1) });
check("paid behind a timeout → CONFIRMED with 1 execution", w.store.entity(t2)!.state === "CONFIRMED" && w.store.entity(t2)!.executions === 1);
check("CONFIRMED → EXECUTING refused", await refused(w.ingest.transition(t2, "EXECUTING", executor, { provenance: prov }), "ILLEGAL_TRANSITION"));

// Invariant (a): a duplicate payment observed in the processor becomes an alert
await w.ingest.observe(t2, verifier, { provenance: { source: "zetaris" }, evidence: ev("conflict", 2) });
check("success_count 2 raises DUPLICATE_PAYMENT alert", w.context.getRefundContext(t2)!.alerts.some((a) => a.startsWith("DUPLICATE_PAYMENT")));

// 4b. A 502 is not a dead end, but it is never re-executed without verification either
const t4 = (await w.ingest.receive({ ticket_id: "T-903", order_id: "ORD-4" }, intake)).entity.id;
for (const s of ["INTAKE_REVIEW", "APPROVED", "EXECUTING", "FAILED_DEFINITE"] as const) await w.ingest.transition(t4, s, executor, { provenance: prov });
check("FAILED_DEFINITE is not terminal", !w.context.getRefundContext(t4)!.terminal);
check("FAILED_DEFINITE → EXECUTING refused", await refused(w.ingest.transition(t4, "EXECUTING", executor, { provenance: prov }), "ILLEGAL_TRANSITION"));
check("FAILED_DEFINITE → RETRY_SAME_KEY refused", await refused(w.ingest.transition(t4, "RETRY_SAME_KEY", verifier, { provenance: prov, evidence: ev("not_paid", 0) }), "ILLEGAL_TRANSITION"));
await w.ingest.transition(t4, "VERIFYING", verifier, { provenance: prov });
await w.ingest.transition(t4, "RETRY_SAME_KEY", verifier, { provenance: { source: "zetaris" }, evidence: ev("not_paid", 0) });
await w.ingest.transition(t4, "EXECUTING", executor, { provenance: prov });
await w.ingest.transition(t4, "CONFIRMED", executor, { provenance: { source: "processor", response: { http: 200 } } });
check("502 → verified not_paid → retry same key → CONFIRMED", w.store.entity(t4)!.state === "CONFIRMED" && w.store.entity(t4)!.executions === 2);

// 5. Concurrency: two executors race to execute the same approved refund
const t3 = (await w.ingest.receive({ ticket_id: "T-902", order_id: "ORD-3" }, intake)).entity.id;
await w.ingest.transition(t3, "INTAKE_REVIEW", intake, { provenance: prov });
await w.ingest.transition(t3, "APPROVED", intake, { provenance: prov });
const race = await Promise.allSettled([
  w.ingest.transition(t3, "EXECUTING", { agentId: "executor-a", taskId: "T-902" }, { provenance: prov }),
  w.ingest.transition(t3, "EXECUTING", { agentId: "executor-b", taskId: "T-902" }, { provenance: prov }),
]);
const wins = race.filter((r) => r.status === "fulfilled" && !r.value.duplicate).length;
check("concurrent execute: exactly one wins", wins === 1 && w.store.entity(t3)!.executions === 1, `${wins} winner(s)`);

// 6. Recompute from the log: a fresh store reading world.jsonl agrees with the live one
const reopened = new WorldStoreService(runId);
const same = w.store.entities().every((e) => JSON.stringify(e) === JSON.stringify(reopened.entity(e.id)));
check("state recomputed from world.jsonl matches", same && reopened.health().events === w.store.health().events);

console.log(`\n${pass} passed, ${fail} failed · ${w.store.health().events} events · ${w.store.path}`);
console.log(JSON.stringify(w.store.health()));
rmSync(dirname(w.store.path), { recursive: true }); // scratch run: remove its log folder
process.exit(fail ? 1 : 0);
