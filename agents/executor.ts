// Executor: code only. Calls the processor with the entity's stable refund_key and maps
// the answer to a state: 200 → CONFIRMED, 502 → FAILED_DEFINITE, anything uncertain
// (timeout, dropped socket, 202) → UNKNOWN. It never decides to retry; the Verifier
// checks both FAILED_DEFINITE and UNKNOWN before any retry.
import type pg from "pg";
import type { Trace } from "../runtime/trace.js";
import type { World } from "../runtime/world/index.js";

export const AGENT = "executor";

export interface ExecutorDeps {
  world: World;
  trace: Trace;
  ordersDb: pg.Pool;
  processorUrl: string;
  callTimeoutMs: number;
}

export type ExecuteResult =
  | { state: "CONFIRMED"; callStartedAt: number }
  | { state: "FAILED_DEFINITE" | "UNKNOWN"; uncertainty: "timeout" | "accepted" | "failed"; callStartedAt: number };

async function setInternal(db: pg.Pool, refundKey: string, status: "succeeded" | "failed") {
  await db.query("UPDATE refunds SET internal_status = $2 WHERE refund_key = $1", [refundKey, status]);
}

export async function execute(entityId: string, deps: ExecutorDeps): Promise<ExecuteResult> {
  const { world, trace, ordersDb } = deps;
  const ctx = world.context.getRefundContext(entityId)!;
  const { refundKey, ticketId, orderId, amount } = ctx.entity;
  const actor = { agentId: AGENT, taskId: ticketId };

  // The world refuses this unless the refund is APPROVED or verified-not-paid (invariant a).
  await world.ingest.transition(entityId, "EXECUTING", actor, { provenance: { source: "policy", note: `attempt ${ctx.entity.executions}` } });

  // Source A: our own record of the refund, keyed by the same stable key.
  await ordersDb.query(
    "INSERT INTO refunds (refund_key, order_id, amount, internal_status, requested_at) VALUES ($1, $2, $3, 'pending', now()) ON CONFLICT (refund_key) DO NOTHING",
    [refundKey, orderId, amount],
  );

  const callStartedAt = Date.now();
  const input = { refund_key: refundKey, amount, attempt: ctx.entity.executions };
  let status: number | null = null;
  let body: unknown = null;
  let failure: string | null = null;
  try {
    const res = await fetch(`${deps.processorUrl}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refund_key: refundKey, amount }),
      signal: AbortSignal.timeout(deps.callTimeoutMs),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e: any) {
    failure = e.name === "TimeoutError" ? "timeout" : `no response (${e.cause?.code ?? e.message})`;
  }
  const provenance = { source: "processor" as const, response: status ? { http: status, body } : { failure } };

  if (status === 200) {
    await world.ingest.transition(entityId, "CONFIRMED", actor, { provenance, reason: "processor returned 200" });
    await setInternal(ordersDb, refundKey, "succeeded");
    trace.write({ agent: AGENT, ticket_id: ticketId, action: "call_refund", input, output: { http: 200, body }, reason: "confirmed" });
    return { state: "CONFIRMED", callStartedAt };
  }
  if (status === 502) {
    await world.ingest.transition(entityId, "FAILED_DEFINITE", actor, { provenance, reason: "processor declined (502)" });
    await setInternal(ordersDb, refundKey, "failed");
    trace.write({ agent: AGENT, ticket_id: ticketId, action: "call_refund", input, output: { http: 502, body }, reason: "processor declined → handing to verifier" });
    return { state: "FAILED_DEFINITE", uncertainty: "failed", callStartedAt };
  }
  const uncertainty = status === 202 ? "accepted" : "timeout";
  await world.ingest.transition(entityId, "UNKNOWN", actor, { provenance, reason: status ? `processor returned ${status}` : failure! });
  trace.write({ agent: AGENT, ticket_id: ticketId, action: "call_refund", input, output: status ? { http: status, body } : { result: failure }, reason: "outcome unknown → handing to verifier" });
  return { state: "UNKNOWN", uncertainty, callStartedAt };
}
