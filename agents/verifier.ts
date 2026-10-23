// Verifier: the safety path. Pure code, no LLM. It answers one question from the system
// of record (Zetaris refund_truth): was this money actually paid? Every decision it hands
// back carries the rows that justify it.
import type { Memory } from "../runtime/memory/index.js";
import { waitWindowFrom } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import type { TruthEvidence, World } from "../runtime/world/index.js";
import { getOrderRefundTruth, getRefundTruth, type RefundTruth } from "../runtime/zetaris.js";

export const AGENT = "verifier";

export interface VerifierDeps {
  world: World;
  memory: Memory;
  trace: Trace;
  defaultWaitMs: number;
  maxWaitMs: number;
  pollMs: number;
}

export type PreIntakeVerdict =
  | { verdict: "clear"; evidence: TruthEvidence; rows: RefundTruth[] }
  | { verdict: "already_paid"; evidence: TruthEvidence; rows: RefundTruth[] }
  | { verdict: "conflict"; evidence: TruthEvidence; rows: RefundTruth[] }
  | { verdict: "unavailable"; evidence: TruthEvidence; error: string };

const now = () => new Date().toISOString();

function summarize(rows: RefundTruth[]): TruthEvidence {
  const success = rows.reduce((s, r) => s + r.success_count, 0);
  const paid = rows.reduce((s, r) => s + r.paid_amount, 0);
  const truth = rows.some((r) => r.truth === "conflict") || success > 1 ? "conflict" : success === 1 ? "paid" : "not_paid";
  return { truth, success_count: success, paid_amount: Number(paid.toFixed(2)), checked_at: now() };
}

// Before Intake approves: has this order already been refunded, or is it in conflict?
export async function checkOrderBeforeIntake(orderId: string, ticketId: string, deps: VerifierDeps): Promise<PreIntakeVerdict> {
  const q = `SELECT * FROM dumen.refund_truth WHERE order_id = '${orderId}'`;
  try {
    const rows = await getOrderRefundTruth(orderId);
    const evidence = summarize(rows);
    const verdict = evidence.truth === "paid" ? "already_paid" : evidence.truth === "conflict" ? "conflict" : "clear";
    deps.trace.write({ agent: AGENT, ticket_id: ticketId, action: "check_order", input: { order_id: orderId, query: q }, output: { verdict, evidence, rows } });
    return { verdict, evidence, rows } as PreIntakeVerdict;
  } catch (e: any) {
    const evidence: TruthEvidence = { truth: "unavailable", success_count: 0, paid_amount: 0, checked_at: now() };
    deps.trace.write({ agent: AGENT, ticket_id: ticketId, action: "check_order", input: { order_id: orderId, query: q }, output: { verdict: "unavailable" }, reason: e.message });
    return { verdict: "unavailable", evidence, error: e.message };
  }
}

export type VerifyDecision = "CONFIRMED" | "RETRY_SAME_KEY" | "ESCALATED";

// After a call that didn't confirm (timeout / 202 / 502): check refund_truth. For timeouts
// and 202s, poll for the learned wait window; a 502 means the processor refused, so one
// check is enough. Paid once → CONFIRMED. Not paid → RETRY_SAME_KEY (shared budget of
// MAX_RETRIES). Conflict, Zetaris down, or anything unclear → ESCALATED.
export async function verifyAfterUncertainCall(
  entityId: string,
  callStartedAt: number,
  executorResult: "timeout" | "accepted" | "failed",
  deps: VerifierDeps,
): Promise<{ decision: VerifyDecision; evidence: TruthEvidence; reason: string }> {
  const { world, memory, trace } = deps;
  const ctx = world.context.getRefundContext(entityId)!;
  const { refundKey, ticketId, orderId } = ctx.entity;
  const actor = { agentId: AGENT, taskId: ticketId };

  await world.ingest.transition(entityId, "VERIFYING", actor, { provenance: { source: "policy", note: `executor result: ${executorResult}` } });

  let waitMs = 0;
  let source = "processor returned 502: single check";
  if (executorResult !== "failed") {
    const mem = memory.retrieval.retrieve({
      text: `refund call ${executorResult === "timeout" ? "timed out" : "accepted but not confirmed"}; how long to wait before deciding the processor did not pay`,
      tags: ["wait-window", "verification", executorResult === "timeout" ? "timeout" : "slow_confirm"],
      entities: ["processor", "refund_truth"],
      agentId: AGENT,
    });
    ({ waitMs, source } = waitWindowFrom(mem, deps.defaultWaitMs, deps.maxWaitMs));
    trace.write({ agent: AGENT, ticket_id: ticketId, action: "recall_memory", input: mem.trace, output: { memories: mem.memories, waitMs, source } });
  }

  const q = `SELECT * FROM dumen.refund_truth WHERE refund_key = '${refundKey}'`;
  let row: RefundTruth | null = null;
  let error: string | null = null;
  let settleMs: number | null = null;
  const deadline = Date.now() + waitMs;
  let checks = 0;
  do {
    checks++;
    try {
      row = await getRefundTruth(refundKey);
      error = null;
    } catch (e: any) {
      error = e.message;
    }
    if (row && row.success_count > 0) {
      settleMs = Date.now() - callStartedAt;
      break;
    }
    if (Date.now() + deps.pollMs > deadline) break;
    await new Promise((r) => setTimeout(r, deps.pollMs));
  } while (Date.now() < deadline);

  const evidence: TruthEvidence = row
    ? { truth: row.truth === "not_paid" && row.success_count === 0 ? "not_paid" : row.truth, success_count: row.success_count, paid_amount: row.paid_amount, checked_at: now() }
    : { truth: "unavailable", success_count: 0, paid_amount: 0, checked_at: now() };
  const provenance = { source: "zetaris" as const, query: q, rows: row ? [row] : [], note: `${checks} check(s) over ${waitMs}ms window (${source})` };

  let decision: VerifyDecision;
  let reason: string;
  if (evidence.success_count === 1) {
    decision = "CONFIRMED";
    reason = `processor paid exactly once (${evidence.paid_amount}); confirmed without re-executing`;
  } else if (evidence.success_count > 1) {
    decision = "ESCALATED";
    reason = `processor paid ${evidence.success_count}× — duplicate payment, human review`;
  } else if (error || !row) {
    decision = "ESCALATED";
    reason = error ? `refund_truth unavailable: ${error}` : "no refund_truth row for this key";
  } else if (evidence.truth === "not_paid" && ctx.retriesLeft > 0) {
    decision = "RETRY_SAME_KEY";
    reason = `not paid after ${waitMs}ms; safe to retry with the same key (${ctx.retriesLeft} retr${ctx.retriesLeft === 1 ? "y" : "ies"} left)`;
  } else {
    decision = "ESCALATED";
    reason = evidence.truth === "not_paid" ? "still not paid and no retries left" : `truth=${evidence.truth}; cannot decide safely`;
  }

  await world.ingest.transition(entityId, decision, actor, { provenance, evidence, reason });
  trace.write({
    agent: AGENT,
    ticket_id: ticketId,
    action: decision === "RETRY_SAME_KEY" ? "verifier→executor: retry_same_key" : decision === "ESCALATED" ? "verifier→escalation: escalate" : "confirm",
    input: { refund_key: refundKey, order_id: orderId, query: q, waitMs, checks },
    output: { evidence, settleMs },
    reason,
  });

  memory.mining.mineVerification({
    agentId: AGENT,
    taskId: ticketId,
    refundKey,
    orderId,
    executorResult,
    verdict: evidence.truth === "paid" && evidence.success_count === 1 ? "paid" : evidence.truth === "not_paid" ? "not_paid" : evidence.truth === "unavailable" ? "unavailable" : "conflict",
    settleMs,
  });
  return { decision, evidence, reason };
}
