// Intake: reads the ticket and decides refund yes/no + amount with Nemotron (through the
// shared generator). On every ticket it also asks the Verifier whether the order
// was already refunded or is in conflict — the model never gets the last word on money.
import { generator } from "../runtime/generator.js";
import type { Memory } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import type { World } from "../runtime/world/index.js";
import { checkAmountOwed, checkOrderBeforeIntake, type VerifierDeps } from "./verifier.js";

export const AGENT = "intake";

export interface Ticket {
  ticket_id: string;
  order_id: string;
  message: string;
  amount_requested: number;
  currency: string;
}

export interface IntakeDecision {
  decision: "refund" | "decline";
  amount: number;
  reason: string;
}

export interface IntakeDeps {
  world: World;
  memory: Memory;
  trace: Trace;
  verifier: VerifierDeps;
  order: { amount: number; currency: string };
  // --cached-intake: a decision saved from an earlier run, used instead of calling the model
  cached?: IntakeDecision;
}

export type IntakeOutcome = "APPROVED" | "REJECTED" | "ESCALATED";

const SYSTEM_PROMPT = `You are a refund operations agent for an online store.
Decide whether to refund the customer and how much. Never refund more than the order amount.
Reply with one JSON object and nothing else: {"decision": "refund" | "decline", "amount": number, "reason": string}`;

export function parseDecision(text: string): IntakeDecision | null {
  for (const m of (text.match(/\{[^{}]*\}/g) ?? []).reverse()) {
    try {
      const d = JSON.parse(m);
      if (typeof d.decision !== "string") continue;
      const decision = /^(refund|approved?)$/i.test(d.decision.trim()) ? "refund" : "decline";
      return { decision, amount: Number(d.amount), reason: String(d.reason ?? "") };
    } catch {
      // not JSON; try the previous match
    }
  }
  return null;
}

export function intakePrompt(ticket: Ticket, order: { amount: number; currency: string }): string {
  return [
    `Ticket ${ticket.ticket_id} for order ${ticket.order_id}.`,
    `Order amount: ${order.amount} ${order.currency}.`,
    `Customer message: "${ticket.message}"`,
    `amount requested: ${ticket.amount_requested}`,
  ].join("\n");
}

// The model's refund decision for one ticket, with no world side effects, so a comparison can
// ask for every ticket up front (in parallel) and hand the same decisions to both agents.
export async function decideIntake(ticket: Ticket, order: { amount: number; currency: string }, memories: unknown[] = []): Promise<{ decision: IntakeDecision | null; raw: string }> {
  const attachments = memories.length ? [{ name: "RELEVANT MEMORIES", content: JSON.stringify(memories) }] : null;
  try {
    const raw = (await generator(intakePrompt(ticket, order), attachments, SYSTEM_PROMPT)).text;
    return { decision: parseDecision(raw), raw };
  } catch (e: any) {
    return { decision: null, raw: `generator error: ${e.message}` };
  }
}

export async function runIntake(ticket: Ticket, entityId: string, deps: IntakeDeps): Promise<{ outcome: IntakeOutcome; decision: IntakeDecision | null }> {
  const { world, trace } = deps;
  const actor = { agentId: AGENT, taskId: ticket.ticket_id };
  await world.ingest.transition(entityId, "INTAKE_REVIEW", actor, { provenance: { source: "ticket", rows: [ticket] } });

  // 1. The model's opinion.
  let decision: IntakeDecision | null = deps.cached ?? null;
  let raw = "";
  if (!decision) {
    // Only intake lessons: processor-timing lessons belong to the Verifier and mislead the model.
    const mem = deps.memory.retrieval.retrieve({ text: ticket.message, tags: ["intake"], entities: [ticket.order_id], agentId: AGENT, strategy: "minimal", namespacePrefix: "refund-ops/intake" });
    ({ decision, raw } = await decideIntake(ticket, deps.order, mem.memories.map((m) => m.content)));
  }
  trace.write({ agent: AGENT, ticket_id: ticket.ticket_id, action: "decide", input: { cached: !!deps.cached }, output: decision ?? { raw: raw.slice(0, 500) }, reason: decision?.reason ?? "no usable model decision" });

  // 2. Always ask the Verifier what the system of record says about this order — whatever
  //    the model decided. Facts about money come from refund_truth, not from the model.
  const check = await checkOrderBeforeIntake(ticket.order_id, ticket.ticket_id, deps.verifier);
  const provenance = { source: "zetaris" as const, query: `SELECT * FROM dumen.refund_truth WHERE order_id = '${ticket.order_id}'`, rows: "rows" in check ? check.rows : [] };

  if (check.verdict === "already_paid") {
    const reason = `order ${ticket.order_id} already refunded: ${check.evidence.success_count} processor payment(s) totalling ${check.evidence.paid_amount}`;
    await world.ingest.transition(entityId, "REJECTED", actor, { provenance, evidence: check.evidence, reason });
    trace.write({ agent: AGENT, ticket_id: ticket.ticket_id, action: "verifier→intake: reject_already_paid", input: provenance, output: check.evidence, reason });
    return { outcome: "REJECTED", decision };
  }
  if (check.verdict === "conflict" || check.verdict === "unavailable") {
    const reason = check.verdict === "conflict" ? `order ${ticket.order_id} is in conflict in refund_truth; paying could double-pay` : `refund_truth unavailable (${check.error}); never pay blind`;
    await world.ingest.transition(entityId, "ESCALATED", actor, { provenance, evidence: check.evidence, reason });
    trace.write({ agent: AGENT, ticket_id: ticket.ticket_id, action: "verifier→escalation: escalate_at_intake", input: provenance, output: check.evidence, reason });
    return { outcome: "ESCALATED", decision };
  }

  // 3. The customer asking for more than is still owed is the signal, whatever the model
  //    decided: a model can trim the amount (or decline) and hide that the ask itself was off.
  const owed = Math.max(0, deps.order.amount - check.evidence.paid_amount);
  const asked = checkAmountOwed(ticket.ticket_id, "refund", ticket.amount_requested, owed, deps.verifier);
  if (!asked.ok) {
    const reason = `customer ${asked.reason}`;
    await world.ingest.transition(entityId, "ESCALATED", actor, { provenance, evidence: check.evidence, reason, data: { requested: ticket.amount_requested, owed, model: decision } });
    trace.write({ agent: AGENT, ticket_id: ticket.ticket_id, action: "verifier→escalation: requested_over_owed", input: provenance, output: { requested: ticket.amount_requested, owed, model: decision }, reason });
    return { outcome: "ESCALATED", decision };
  }

  // 4. The order is clear and the ask is within what's owed; now the model's decision matters.
  if (!decision) {
    await world.ingest.transition(entityId, "ESCALATED", actor, { provenance: { source: "intake", response: raw.slice(0, 500) }, evidence: check.evidence, reason: raw.startsWith("generator error") ? `model unavailable (${raw.slice("generator error: ".length)}); no model decision = no refund` : "model gave no usable decision" });
    return { outcome: "ESCALATED", decision };
  }
  if (decision.decision === "decline") {
    await world.ingest.transition(entityId, "REJECTED", actor, { provenance, evidence: check.evidence, reason: `declined by intake: ${decision.reason}` });
    return { outcome: "REJECTED", decision };
  }

  // Confident and wrong: the model (or the customer) can ask for more than was paid. The
  // Verifier checks the amount against what's owed; above it escalates, it is never trimmed
  // silently and never paid.
  const amount = Number.isFinite(decision.amount) && decision.amount > 0 ? decision.amount : ticket.amount_requested;
  const amountCheck = checkAmountOwed(ticket.ticket_id, "refund", amount, owed, deps.verifier);
  if (!amountCheck.ok) {
    await world.ingest.transition(entityId, "ESCALATED", actor, { provenance, evidence: check.evidence, reason: amountCheck.reason, data: { amount, owed } });
    return { outcome: "ESCALATED", decision: { ...decision, amount } };
  }
  await world.ingest.transition(entityId, "APPROVED", actor, { provenance, evidence: check.evidence, reason: decision.reason, data: { amount } });
  return { outcome: "APPROVED", decision: { ...decision, amount } };
}
