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
  summary_pending?: boolean; // template for now; Nemotron's summary is being written (scripts/summaries.ts)
  created_at: string;
}

const SYSTEM_PROMPT = `You write escalation notes for a payments operations team (customer refunds and seller payouts).
Given the evidence, write 2-3 plain sentences: what was asked or scheduled, what the systems show, and what a human should check.
Do not recommend paying. No preamble.`;

// Serialize writes to the queue file across concurrent tickets.
let queueLock: Promise<unknown> = Promise.resolve();

// deferModel: the case goes in at once with the template summary; Nemotron's summary replaces
// it later (fillSummaries, all cases in parallel), off the payment path.
export interface PendingSummary {
  caseId: string;
  ticketId: string;
  evidence: unknown;
}
const pending: PendingSummary[] = [];

export const takePendingSummaries = (): PendingSummary[] => pending.splice(0);

async function modelSummary(evidence: unknown): Promise<string> {
  // Model thinking can leak before the answer; keep the last paragraph.
  const text = (await generator(JSON.stringify(evidence, null, 2), null, SYSTEM_PROMPT)).text.trim();
  const summary = text.split(/\n\s*\n/).pop()!.trim();
  if (!summary || summary.startsWith("{") || summary === "sample mode response") throw new Error("empty or non-prose summary");
  return summary;
}

function templateSummary(e: NonNullable<ReturnType<World["context"]["getRefundContext"]>>["entity"], reason: string): string {
  const ev = e.lastEvidence;
  return e.kind === "payout"
    ? `Payout ${e.ticketId} of ${e.amount} to seller ${e.orderId} (batch ${e.batchId}). ${reason}.${ev ? ` payout_truth shows truth=${ev.truth}, ${ev.success_count} bank payment(s) totalling ${ev.paid_amount}.` : ""} Nothing was sent by Dumen; a person should approve or reject this payout.`
    : `Ticket ${e.ticketId} asks about a refund on ${e.orderId}. ${reason}.${ev ? ` refund_truth shows truth=${ev.truth}, ${ev.success_count} processor payment(s) totalling ${ev.paid_amount}.` : ""} Nothing was paid by Dumen after escalation; a human should reconcile the order before any refund.`;
}

export async function fillSummaries(trace: Trace, jobs: PendingSummary[], limit = 6, onProgress?: (done: number, total: number) => void): Promise<{ model: number; template: number }> {
  const path = join(dirname(trace.path), "escalations.json");
  const total = jobs.length;
  const queue = [...jobs];
  let done = 0;
  let model = 0;
  const update = (caseId: string, patch: Partial<EscalationCase>) => {
    queueLock = queueLock.then(() => {
      const cases: EscalationCase[] = JSON.parse(readFileSync(path, "utf8"));
      const c = cases.find((x) => x.case_id === caseId);
      if (c) Object.assign(c, patch);
      writeFileSync(path, JSON.stringify(cases, null, 2) + "\n");
    });
    return queueLock;
  };
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      try {
        const summary = await modelSummary(j.evidence);
        await update(j.caseId, { summary, summary_source: "model", summary_pending: false });
        trace.write({ agent: AGENT, ticket_id: j.ticketId, action: "summary_ready", output: { case_id: j.caseId, summary_source: "model" }, reason: summary });
        model++;
      } catch {
        await update(j.caseId, { summary_pending: false }); // the template stays
      }
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, total) }, worker));
  return { model, template: total - model };
}

export async function escalate(entityId: string, deps: { world: World; trace: Trace; ticketMessage: string; useModel?: boolean; deferModel?: boolean }): Promise<EscalationCase> {
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
    if (deps.useModel === false || deps.deferModel) throw new Error("no inline model summary");
    summary = await modelSummary(evidence);
  } catch {
    summary_source = "template";
    summary = templateSummary(e, reason);
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
    ...(deps.useModel !== false && deps.deferModel ? { summary_pending: true } : {}),
    created_at: new Date().toISOString(),
  };

  const path = join(dirname(deps.trace.path), "escalations.json");
  queueLock = queueLock.then(() => {
    const queue: EscalationCase[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    if (!queue.some((c) => c.case_id === item.case_id)) queue.push(item);
    writeFileSync(path, JSON.stringify(queue, null, 2) + "\n");
  });
  await queueLock;
  if (item.summary_pending) pending.push({ caseId: item.case_id, ticketId: item.ticket_id, evidence });
  deps.trace.write({ agent: AGENT, ticket_id: e.ticketId, action: "enqueue_case", input: evidence, output: { case_id: item.case_id, summary_source }, reason: summary });
  return item;
}
