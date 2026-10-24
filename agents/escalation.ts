// Escalation: Nemotron writes a short case summary for a human from the world evidence,
// and the case goes into the escalation queue (logs/<runId>/escalations.json). If the
// model is unavailable, a plain template summary is used — escalation never blocks.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { generator } from "../runtime/generator.js";
import type { Trace } from "../runtime/trace.js";
import type { World } from "../runtime/world/index.js";

export const AGENT = "escalation";

export interface EscalationCase {
  case_id: string;
  kind: "refund" | "payout";
  ticket_id: string;
  order_id: string;
  refund_key: string;
  amount: number | null;
  state_history: string[];
  last_evidence: unknown;
  reason: string;
  summary: string;
  summary_source: "model" | "template";
  created_at: string;
}

const SYSTEM_PROMPT = `You write escalation notes for a payments operations team (customer refunds and seller payouts).
Given the evidence, write 2-3 plain sentences: what was asked or scheduled, what the systems show, and what a human should check.
Do not recommend paying. No preamble.`;

// Serialize writes to the queue file across concurrent tickets.
let queueLock: Promise<unknown> = Promise.resolve();

export async function escalate(entityId: string, deps: { world: World; trace: Trace; ticketMessage: string; useModel?: boolean }): Promise<EscalationCase> {
  const ctx = deps.world.context.getRefundContext(entityId)!;
  const e = ctx.entity;
  const reason = [...ctx.history].reverse().find((h) => h.to === "ESCALATED")?.reason ?? "escalated";
  const evidence = {
    ticket: { id: e.ticketId, order_id: e.orderId, message: deps.ticketMessage, amount: e.amount },
    states: ctx.history.filter((h) => h.type === "state.transition").map((h) => h.to),
    executions: e.executions,
    last_evidence: e.lastEvidence,
    reason,
  };

  let summary: string;
  let summary_source: EscalationCase["summary_source"] = "model";
  try {
    if (deps.useModel === false) throw new Error("model disabled for this run");
    // Model thinking can leak before the answer; keep the last paragraph.
    const text = (await generator(JSON.stringify(evidence, null, 2), null, SYSTEM_PROMPT)).text.trim();
    summary = text.split(/\n\s*\n/).pop()!.trim();
    if (!summary || summary.startsWith("{")) throw new Error("empty or non-prose summary");
  } catch {
    summary_source = "template";
    const ev = e.lastEvidence;
    summary =
      e.kind === "payout"
        ? `Payout ${e.ticketId} of ${e.amount} to seller ${e.orderId} (batch ${e.batchId}). ${reason}.${ev ? ` payout_truth shows truth=${ev.truth}, ${ev.success_count} bank payment(s) totalling ${ev.paid_amount}.` : ""} Nothing was sent by Dumen; a person should approve or reject this payout.`
        : `Ticket ${e.ticketId} asks about a refund on ${e.orderId}. ${reason}.${ev ? ` refund_truth shows truth=${ev.truth}, ${ev.success_count} processor payment(s) totalling ${ev.paid_amount}.` : ""} Nothing was paid by Dumen after escalation; a human should reconcile the order before any refund.`;
  }
  if (process.env.SAMPLE_MODE === "true" && summary === "sample mode response") {
    summary_source = "template";
    summary = `${e.kind === "payout" ? "Payout" : "Ticket"} ${e.ticketId} on ${e.orderId}: ${reason}. A person should decide before any money moves.`;
  }

  const item: EscalationCase = {
    case_id: `esc_${e.id.replace(/^ent_(refund|payout)_/, e.kind === "payout" ? "po_" : "")}`,
    kind: e.kind,
    ticket_id: e.ticketId,
    order_id: e.orderId,
    refund_key: e.refundKey,
    amount: e.amount,
    state_history: evidence.states.filter((s): s is NonNullable<typeof s> => !!s),
    last_evidence: e.lastEvidence,
    reason,
    summary,
    summary_source,
    created_at: new Date().toISOString(),
  };

  const path = join(dirname(deps.trace.path), "escalations.json");
  queueLock = queueLock.then(() => {
    const queue: EscalationCase[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    if (!queue.some((c) => c.case_id === item.case_id)) queue.push(item);
    writeFileSync(path, JSON.stringify(queue, null, 2) + "\n");
  });
  await queueLock;
  deps.trace.write({ agent: AGENT, ticket_id: e.ticketId, action: "enqueue_case", input: evidence, output: { case_id: item.case_id, summary_source }, reason: summary });
  return item;
}
