// Baseline payout agent: the bug, payout edition. It sends each batch as scheduled and, on a
// timeout, re-sends the WHOLE batch from memory (up to 2 times). No check of what the bank
// already executed, of recent bank-account changes, of earned balances or of size.
import type pg from "pg";
import type { Trace } from "../runtime/trace.js";
import type { ScheduledPayout } from "./payouts.js";

const AGENT = "baseline";
const MAX_RETRIES = 2;

export async function runBaselinePayoutBatch(
  batchId: string,
  payouts: ScheduledPayout[],
  deps: { ordersDb: pg.Pool; processorUrl: string; trace: Trace; callTimeoutMs: number },
): Promise<"paid" | "failed" | "timed_out"> {
  const items = payouts.map((p) => ({ payout_key: p.payout_key, amount: p.amount }));
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let status: number | null = null;
    try {
      const res = await fetch(`${deps.processorUrl}/payouts/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch_id: batchId, items }),
        signal: AbortSignal.timeout(deps.callTimeoutMs),
      });
      status = res.status;
    } catch {
      // The bug: no answer = "nothing happened", so the whole batch goes again.
      deps.trace.write({ agent: AGENT, ticket_id: batchId, action: attempt ? "resend_batch" : "send_batch", input: { batch_id: batchId, items, attempt }, output: { result: "timeout" }, reason: attempt < MAX_RETRIES ? "no response, re-sending the whole batch" : "no response, giving up" });
      continue;
    }
    deps.trace.write({ agent: AGENT, ticket_id: batchId, action: attempt ? "resend_batch" : "send_batch", input: { batch_id: batchId, items, attempt }, output: { http: status } });
    const ok = status === 200 || status === 202;
    for (const p of payouts) await deps.ordersDb.query("UPDATE payouts SET internal_status = $2 WHERE payout_key = $1", [p.payout_key, ok ? "succeeded" : "failed"]);
    return ok ? "paid" : "failed";
  }
  return "timed_out";
}
