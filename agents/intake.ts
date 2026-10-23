// Intake: reads the ticket and decides refund yes/no + amount with Nemotron (through the
// shared generator). On every ticket it also asks the Verifier whether the order
// was already refunded or is in conflict — the model never gets the last word on money.
import { generator } from "../runtime/generator.js";
import type { Memory } from "../runtime/memory/index.js";
import type { Trace } from "../runtime/trace.js";
import type { World } from "../runtime/world/index.js";
import { checkOrderBeforeIntake, type VerifierDeps } from "./verifier.js";

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
    const prompt = [
      `Ticket ${ticket.ticket_id} for order ${ticket.order_id}.`,
      `Order amount: ${deps.order.amount} ${deps.order.currency}.`,
      `Customer message: "${ticket.message}"`,
      `amount requested: ${ticket.amount_requested}`,
    ].join("\n");
    const attachments = mem.memories.length ? [{ name: "RELEVANT MEMORIES", content: JSON.stringify(mem.memories.map((m) => m.content)) }] : null;
    try {
      raw = (await generator(prompt, attachments, SYSTEM_PROMPT)).text;
      decision = parseDecision(raw);
    } catch (e: any) {
      raw = `generator error: ${e.message}`;
    }
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

  // 3. The order is clear; now the model's decision matters.
  if (!decision) {
    await world.ingest.transition(entityId, "ESCALATED", actor, { provenance: { source: "intake", response: raw.slice(0, 500) }, evidence: check.evidence, reason: raw.startsWith("generator error") ? `model unavailable (${raw.slice("generator error: ".length)}); no model decision = no refund` : "model gave no usable decision" });
    return { outcome: "ESCALATED", decision };
  }
  if (decision.decision === "decline") {
    await world.ingest.transition(entityId, "REJECTED", actor, { provenance, evidence: check.evidence, reason: `declined by intake: ${decision.reason}` });
    return { outcome: "REJECTED", decision };
  }

  const amount = Math.min(Number.isFinite(decision.amount) && decision.amount > 0 ? decision.amount : ticket.amount_requested, deps.order.amount);
  await world.ingest.transition(entityId, "APPROVED", actor, { provenance, evidence: check.evidence, reason: decision.reason, data: { amount } });
  return { outcome: "APPROVED", decision: { ...decision, amount } };
}
