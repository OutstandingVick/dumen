// Verifier: the safety path. Pure code, no LLM. It answers one question from the system
// of record (Zetaris refund_truth / payout_truth): was this money actually paid, and is it
// owed? Every decision it hands back carries the rows that justify it.
import type { Memory } from "../runtime/memory/index.js";
import { waitWindowFrom } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import type { TruthEvidence, World } from "../runtime/world/index.js";
import { getOrderRefundTruth, getPayoutTruth, getRefundTruth, type PayoutTruth, type RefundTruth } from "../runtime/zetaris.js";

// Payouts above this always wait for a person, whatever the evidence says.
export const PAYOUT_APPROVAL_THRESHOLD = 2500;

// One truth row for an action, whichever view it lives in.
async function truthFor(kind: "refund" | "payout", key: string): Promise<{ row: RefundTruth | PayoutTruth | null; query: string }> {
  if (kind === "payout") return { row: await getPayoutTruth(key), query: `SELECT * FROM dumen.payout_truth WHERE payout_key = '${key}'` };
  return { row: await getRefundTruth(key), query: `SELECT * FROM dumen.refund_truth WHERE refund_key = '${key}'` };
}

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

// A person approved an escalated refund. Approval is not permission to pay blind: the
// Verifier re-checks this refund_key and the whole order in refund_truth first.
//   this key paid once                → CONFIRMED (nothing to pay)
//   this key paid twice / order paid
//   under another key / Zetaris down  → ESCALATED again, with the reason
//   nothing paid                      → RETRY_SAME_KEY (the approval adds one attempt)
export async function verifyHumanApproval(
  entityId: string,
  reason: string,
  deps: VerifierDeps,
  owed?: number, // refunds: the order amount (the caller reads it); payouts use the seller's earned balance
): Promise<{ decision: VerifyDecision; evidence: TruthEvidence; reason: string }> {
  const { world, trace } = deps;
  const { kind, refundKey, ticketId, orderId, executions, amount } = world.context.getRefundContext(entityId)!.entity;
  await world.ingest.transition(entityId, "VERIFYING", { agentId: "human", taskId: ticketId }, { provenance: { source: "policy", note: "human approval" }, reason });

  // Every row that could already have paid this money: the whole order for a refund,
  // this payout_key for a payout.
  const view = kind === "payout" ? "payout_truth" : "refund_truth";
  const q = kind === "payout" ? `SELECT * FROM dumen.payout_truth WHERE payout_key = '${refundKey}'` : `SELECT * FROM dumen.refund_truth WHERE order_id = '${orderId}'`;
  let rows: Array<{ key: string; success_count: number; paid_amount: number }> = [];
  let raw: unknown[] = [];
  let error: string | null = null;
  try {
    if (kind === "payout") {
      const p = await getPayoutTruth(refundKey);
      raw = p ? [p] : [];
      rows = p ? [{ key: p.payout_key, success_count: p.success_count, paid_amount: p.paid_amount }] : [];
      owed = p?.earned_balance;
    } else {
      const r = await getOrderRefundTruth(orderId);
      raw = r;
      rows = r.map((x) => ({ key: x.refund_key, success_count: x.success_count, paid_amount: x.paid_amount }));
    }
  } catch (e: any) {
    error = e.message;
  }
  const own = rows.find((r) => r.key === refundKey) ?? null;
  const othersPaid = rows.filter((r) => r.key !== refundKey).reduce((s, r) => s + r.success_count, 0);
  const ownPaid = own?.success_count ?? 0;
  const evidence: TruthEvidence = error
    ? { truth: "unavailable", success_count: 0, paid_amount: 0, checked_at: now() }
    : { truth: ownPaid === 1 ? "paid" : ownPaid > 1 ? "conflict" : "not_paid", success_count: ownPaid, paid_amount: own?.paid_amount ?? 0, checked_at: now() };
  const provenance = { source: "zetaris" as const, query: q, rows: raw, note: own ? `row for this ${kind} key found` : `no row for this key (${executions} prior execution(s))` };

  let decision: VerifyDecision;
  let why: string;
  if (error) {
    decision = "ESCALATED";
    why = `${view} unavailable (${error}); approval not executed`;
  } else if (ownPaid === 1) {
    decision = "CONFIRMED";
    why = `approved, but this ${kind} was already paid once; nothing more to pay`;
  } else if (ownPaid > 1) {
    decision = "ESCALATED";
    why = `this ${kind} key was already paid ${ownPaid}×; approval not executed`;
  } else if (othersPaid > 0) {
    decision = "ESCALATED";
    why = `order ${orderId} already paid ${othersPaid}× under another refund_key; approval not executed`;
  } else if (owed !== undefined && amount !== null && amount > owed + 0.005) {
    decision = "ESCALATED";
    why = `approval can't pay ${amount} when at most ${owed} is owed; never overpay`;
  } else if (!own && executions > 0) {
    decision = "ESCALATED";
    why = `${kind} was executed before but has no ${view} row; cannot verify`;
  } else {
    decision = "RETRY_SAME_KEY";
    why = `approved by a person; verified not paid${kind === "refund" ? " under any key" : ""}, executing with the same ${kind === "payout" ? "payout_key" : "refund_key"}`;
  }

  await world.ingest.transition(entityId, decision, { agentId: AGENT, taskId: ticketId }, { provenance, evidence, reason: why });
  trace.write({
    agent: AGENT,
    ticket_id: ticketId,
    action: decision === "RETRY_SAME_KEY" ? "verifier→executor: execute_approved" : decision === "ESCALATED" ? "verifier→escalation: escalate" : "confirm",
    input: { key: refundKey, kind, query: q, rows: raw },
    output: { evidence },
    reason: why,
  });
  return { decision, evidence, reason: why };
}

// Is the amount within what's owed? Refunds: the order amount less anything already
// refunded; payouts: the seller's earned balance. Above it → escalate, never pay.
export function checkAmountOwed(ticketId: string, kind: "refund" | "payout", amount: number, owed: number, deps: Pick<VerifierDeps, "trace">): { ok: boolean; reason: string } {
  const ok = amount <= owed + 0.005;
  const reason = ok ? `${amount} is within the ${owed} owed` : `asks for ${amount} but at most ${owed} is owed; never overpay`;
  deps.trace.write({ agent: AGENT, ticket_id: ticketId, action: ok ? "check_amount" : "verifier→escalation: overpay", input: { kind, amount, owed }, output: { ok }, reason });
  return { ok, reason };
}

export type PayoutPrecheck =
  | { verdict: "clear"; evidence: TruthEvidence; row: PayoutTruth }
  | { verdict: "already_paid" | "conflict" | "account_changed" | "overpay" | "needs_approval"; evidence: TruthEvidence; row: PayoutTruth; reason: string }
  | { verdict: "unavailable"; evidence: TruthEvidence; reason: string };

// Before a payout joins a batch: already paid? account just changed? more than earned?
// above the approval threshold? Any of these keeps it out of the batch.
export async function checkPayoutBeforeSend(payoutKey: string, amount: number, deps: Pick<VerifierDeps, "trace">): Promise<PayoutPrecheck> {
  const q = `SELECT * FROM dumen.payout_truth WHERE payout_key = '${payoutKey}'`;
  let row: PayoutTruth | null = null;
  try {
    row = await getPayoutTruth(payoutKey);
  } catch (e: any) {
    const evidence: TruthEvidence = { truth: "unavailable", success_count: 0, paid_amount: 0, checked_at: now() };
    const reason = `payout_truth unavailable (${e.message}); never pay blind`;
    deps.trace.write({ agent: AGENT, ticket_id: payoutKey, action: "check_payout", input: { query: q }, output: { verdict: "unavailable" }, reason });
    return { verdict: "unavailable", evidence, reason };
  }
  if (!row) {
    const evidence: TruthEvidence = { truth: "unavailable", success_count: 0, paid_amount: 0, checked_at: now() };
    return { verdict: "unavailable", evidence, reason: "no payout_truth row for this payout" };
  }
  const evidence: TruthEvidence = { truth: row.truth, success_count: row.success_count, paid_amount: row.paid_amount, checked_at: now() };
  let result: PayoutPrecheck;
  if (row.success_count >= 1 && row.truth === "paid") result = { verdict: "already_paid", evidence, row, reason: `bank already paid ${payoutKey} (${row.paid_amount}); internal record says ${row.internal_status}` };
  else if (row.truth === "conflict") result = { verdict: "conflict", evidence, row, reason: `payout_truth shows conflict for ${payoutKey}; sending could double-pay` };
  else if (row.account_changed_recently) result = { verdict: "account_changed", evidence, row, reason: `seller ${row.seller_id} changed bank account in the last 24h; hold for a person` };
  else if (amount > row.earned_balance + 0.005) result = { verdict: "overpay", evidence, row, reason: `payout ${amount} exceeds seller ${row.seller_id}'s earned balance ${row.earned_balance}; never overpay` };
  else if (amount > PAYOUT_APPROVAL_THRESHOLD) result = { verdict: "needs_approval", evidence, row, reason: `payout ${amount} is above the ${PAYOUT_APPROVAL_THRESHOLD} threshold; a person must approve` };
  else result = { verdict: "clear", evidence, row };
  deps.trace.write({
    agent: AGENT,
    ticket_id: payoutKey,
    action: result.verdict === "clear" ? "check_payout" : result.verdict === "already_paid" ? "verifier→payouts: reject_already_paid" : "verifier→escalation: hold_payout",
    input: { query: q, rows: [row] },
    output: { verdict: result.verdict, evidence },
    reason: "reason" in result ? result.reason : "clear to send",
  });
  return result;
}

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
  const { kind, refundKey, ticketId, orderId } = ctx.entity;
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

  const view = kind === "payout" ? "payout_truth" : "refund_truth";
  let q = `SELECT * FROM dumen.${view} WHERE ${kind === "payout" ? "payout_key" : "refund_key"} = '${refundKey}'`;
  let row: RefundTruth | PayoutTruth | null = null;
  let error: string | null = null;
  let settleMs: number | null = null;
  const deadline = Date.now() + waitMs;
  let checks = 0;
  do {
    checks++;
    try {
      ({ row, query: q } = await truthFor(kind, refundKey));
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
    reason = `${kind === "payout" ? "bank" : "processor"} paid exactly once (${evidence.paid_amount}); confirmed without re-executing`;
  } else if (evidence.success_count > 1) {
    decision = "ESCALATED";
    reason = `processor paid ${evidence.success_count}× — duplicate payment, human review`;
  } else if (error || !row) {
    decision = "ESCALATED";
    reason = error ? `${view} unavailable: ${error}` : `no ${view} row for this key`;
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
