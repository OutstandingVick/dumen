// Baseline agent: the bug. It decides from the ticket alone, pays, and on a timeout
// retries from memory. It never checks whether the processor already paid.
import type pg from "pg";
import { generator } from "../runtime/generator.js";
import type { Trace } from "../runtime/trace.js";

export interface Ticket {
  ticket_id: string;
  order_id: string;
  message: string;
  amount_requested: number;
  currency: string;
}

export interface BaselineDeps {
  ordersDb: pg.Pool;
  processorUrl: string;
  trace: Trace;
  callTimeoutMs: number;
}

export type TicketOutcome = "refunded" | "declined" | "failed" | "timed_out" | "error";

const AGENT = "baseline";
const MAX_RETRIES = 2;

const SYSTEM_PROMPT = `You are a refund operations agent for an online store.
Decide whether to refund the customer and how much. Never refund more than the order amount.
Reply with one JSON object and nothing else: {"decision": "refund" | "decline", "amount": number, "reason": string}`;

// The model sometimes thinks out loud before the JSON; take the last JSON object in the text.
function parseDecision(text: string): { decision: string; amount: number; reason: string } | null {
  const matches = text.match(/\{[^{}]*\}/g);
  for (const m of (matches ?? []).reverse()) {
    try {
      const d = JSON.parse(m);
      if (typeof d.decision === "string") {
        // The model sometimes says "approve(d)" instead of "refund"; they mean the same here.
        const decision = /^(refund|approved?)$/i.test(d.decision.trim()) ? "refund" : d.decision.toLowerCase();
        return { decision, amount: Number(d.amount), reason: String(d.reason ?? "") };
      }
    } catch {
      // not JSON, try the previous match
    }
  }
  return null;
}

type CallResult = { kind: "ok"; status: number; body: any } | { kind: "timeout" } | { kind: "error"; message: string };

async function callRefund(url: string, refundKey: string, amount: number, timeoutMs: number): Promise<CallResult> {
  try {
    const res = await fetch(`${url}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refund_key: refundKey, amount }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { kind: "ok", status: res.status, body: await res.json().catch(() => null) };
  } catch (e: any) {
    // An aborted request and a dropped socket look the same to the caller: no answer.
    if (e.name === "TimeoutError" || e.name === "AbortError" || e.cause?.code === "UND_ERR_SOCKET" || /terminated|socket/i.test(e.message)) {
      return { kind: "timeout" };
    }
    return { kind: "error", message: e.message };
  }
}

export async function runBaseline(ticket: Ticket, deps: BaselineDeps): Promise<{ outcome: TicketOutcome; refundKey?: string }> {
  const { ordersDb, processorUrl, trace, callTimeoutMs } = deps;
  const t = (action: string, input?: unknown, output?: unknown, reason?: string) =>
    trace.write({ agent: AGENT, ticket_id: ticket.ticket_id, action, input, output, reason });

  const { rows } = await ordersDb.query("SELECT order_id, amount, currency FROM orders WHERE order_id = $1", [ticket.order_id]);
  const order = rows[0];
  if (!order) {
    t("lookup_order", { order_id: ticket.order_id }, null, "order not found");
    return { outcome: "error" };
  }
  t("lookup_order", { order_id: ticket.order_id }, order);

  const prompt = [
    `Ticket ${ticket.ticket_id} for order ${ticket.order_id}.`,
    `Order amount: ${order.amount} ${order.currency}.`,
    `Customer message: "${ticket.message}"`,
    `amount requested: ${ticket.amount_requested}`,
  ].join("\n");
  let text: string;
  try {
    text = (await generator(prompt, null, SYSTEM_PROMPT)).text;
  } catch (e: any) {
    t("decide", { prompt }, null, `generator error: ${e.message}`);
    return { outcome: "error" };
  }
  const decision = parseDecision(text);
  t("decide", { prompt }, decision ?? { raw: text.slice(0, 500) }, decision?.reason ?? "could not parse model output");
  if (!decision) return { outcome: "error" };
  if (decision.decision !== "refund") return { outcome: "declined" };

  const amount = Math.min(Number.isFinite(decision.amount) && decision.amount > 0 ? decision.amount : ticket.amount_requested, Number(order.amount));
  const refundKey = `rf_${ticket.ticket_id}`;
  await ordersDb.query(
    "INSERT INTO refunds (refund_key, order_id, amount, internal_status, requested_at) VALUES ($1, $2, $3, 'pending', now()) ON CONFLICT (refund_key) DO NOTHING",
    [refundKey, ticket.order_id, amount],
  );
  t("record_pending", { refund_key: refundKey, amount }, { internal_status: "pending" });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const action = attempt === 0 ? "call_refund" : "retry_refund";
    const res = await callRefund(processorUrl, refundKey, amount, callTimeoutMs);

    if (res.kind === "timeout") {
      // The bug: no answer is treated as "it didn't happen", so pay again from memory.
      t(action, { refund_key: refundKey, amount, attempt }, { result: "timeout" }, attempt < MAX_RETRIES ? "no response, retrying" : "no response, giving up");
      continue;
    }
    if (res.kind === "error") {
      t(action, { refund_key: refundKey, amount, attempt }, { result: "error", message: res.message }, "network error");
      await setStatus(ordersDb, refundKey, "failed");
      return { outcome: "failed", refundKey };
    }
    t(action, { refund_key: refundKey, amount, attempt }, { http: res.status, body: res.body });
    if (res.status === 200 || res.status === 202) {
      await setStatus(ordersDb, refundKey, "succeeded");
      t("record_result", { refund_key: refundKey }, { internal_status: "succeeded" });
      return { outcome: "refunded", refundKey };
    }
    await setStatus(ordersDb, refundKey, "failed");
    t("record_result", { refund_key: refundKey }, { internal_status: "failed" }, `processor returned ${res.status}`);
    return { outcome: "failed", refundKey };
  }

  // Out of retries; internal record stays "pending" even if the processor paid.
  return { outcome: "timed_out", refundKey };
}

async function setStatus(db: pg.Pool, refundKey: string, status: "succeeded" | "failed") {
  await db.query("UPDATE refunds SET internal_status = $2 WHERE refund_key = $1", [refundKey, status]);
}
