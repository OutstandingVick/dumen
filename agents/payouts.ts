// Dumen payouts: a marketplace paying its sellers, one batch at a time. Same engine and
// safety rules as refunds:
//   1. every payout gets its own Verifier pre-check (already paid? bank account just changed?
//      more than earned? above the approval threshold?) before it may join the batch
//   2. the clear ones go out in one bank-rail call
//   3. after a call that didn't confirm, the Verifier checks EACH payout in payout_truth;
//      only the ones verified not paid are re-sent, as a smaller batch with the same keys.
//      The whole batch is never re-sent.
import { MAX_RETRIES } from "../runtime/world/index.js";
import type { DumenDeps } from "./dumen.js";
import { escalate } from "./escalation.js";
import { executePayoutBatch } from "./executor.js";
import { checkPayoutBeforeSend, verifyAfterUncertainCall, type VerifierDeps } from "./verifier.js";

export const AGENT = "payouts";

export interface ScheduledPayout {
  payout_key: string;
  seller_id: string;
  amount: number;
  batch_id: string;
}

export interface PayoutResult {
  payoutKey: string;
  sellerId: string;
  state: string;
  executions: number;
}

export async function runPayoutBatch(batchId: string, payouts: ScheduledPayout[], deps: DumenDeps): Promise<PayoutResult[]> {
  const { world, memory, trace } = deps;
  const verifierDeps: VerifierDeps = { world, memory, trace, ...deps.verifier };
  const execDeps = { world, trace, ordersDb: deps.ordersDb, processorUrl: deps.processorUrl, callTimeoutMs: deps.callTimeoutMs };
  const holdMessage = (p: ScheduledPayout) => `Scheduled payout ${p.payout_key} of ${p.amount} to seller ${p.seller_id} in batch ${batchId}`;

  // 1. Pre-check each payout on its own.
  const ids = new Map<string, ScheduledPayout>();
  let toSend: string[] = [];
  for (const p of payouts) {
    const { entity } = await world.ingest.receivePayout(p, { agentId: AGENT, taskId: p.payout_key });
    const id = entity.id;
    ids.set(id, p);
    const actor = { agentId: "verifier", taskId: p.payout_key };
    await world.ingest.transition(id, "INTAKE_REVIEW", actor, { provenance: { source: "ticket", rows: [p], note: `batch ${batchId}` } });
    const check = await checkPayoutBeforeSend(p.payout_key, p.amount, verifierDeps);
    const provenance = { source: "zetaris" as const, query: `SELECT * FROM dumen.payout_truth WHERE payout_key = '${p.payout_key}'`, rows: "row" in check ? [check.row] : [] };
    if (check.verdict === "clear") {
      await world.ingest.transition(id, "APPROVED", actor, { provenance, evidence: check.evidence, reason: "payout_truth: not paid, account stable, within earned balance and threshold", data: { amount: p.amount } });
      toSend.push(id);
    } else if (check.verdict === "already_paid") {
      await world.ingest.transition(id, "REJECTED", actor, { provenance, evidence: check.evidence, reason: check.reason });
    } else {
      await world.ingest.transition(id, "ESCALATED", actor, { provenance, evidence: check.evidence, reason: check.reason });
      await escalate(id, { world, trace, ticketMessage: holdMessage(p), useModel: deps.modelSummaries });
    }
  }

  // 2–3. Send, verify each payout, re-send only the unpaid ones. Bounded by the retry budget.
  for (let round = 0; round <= MAX_RETRIES && toSend.length; round++) {
    const results = await executePayoutBatch(toSend, batchId, execDeps);
    const retry: string[] = [];
    const uncertain = results.filter((r) => r.state !== "CONFIRMED");
    if (uncertain.length) {
      trace.write({
        agent: "verifier",
        ticket_id: batchId,
        action: "verify_batch",
        input: { batch_id: batchId, payouts: uncertain.map((r) => world.store.entity(r.entityId)!.refundKey) },
        reason: `checking each of ${uncertain.length} payout(s) in payout_truth before any re-send`,
      });
    }
    for (const r of uncertain) {
      const v = await verifyAfterUncertainCall(r.entityId, r.callStartedAt, r.uncertainty ?? "timeout", verifierDeps);
      const key = world.store.entity(r.entityId)!.refundKey;
      if (v.decision === "CONFIRMED") await deps.ordersDb.query("UPDATE payouts SET internal_status = 'succeeded' WHERE payout_key = $1", [key]);
      else if (v.decision === "RETRY_SAME_KEY") {
        await deps.ordersDb.query("UPDATE payouts SET internal_status = 'pending' WHERE payout_key = $1", [key]);
        retry.push(r.entityId);
      } else await escalate(r.entityId, { world, trace, ticketMessage: holdMessage(ids.get(r.entityId)!), useModel: deps.modelSummaries });
    }
    if (retry.length && retry.length < toSend.length) {
      trace.write({ agent: "verifier", ticket_id: batchId, action: "verifier→executor: resend_unpaid_only", input: { batch_id: batchId, resend: retry.map((id) => world.store.entity(id)!.refundKey), of: toSend.length }, reason: `${toSend.length - retry.length} already settled; re-sending only the ${retry.length} verified not paid` });
    }
    toSend = retry;
  }

  return [...ids.keys()].map((id) => {
    const e = world.store.entity(id)!;
    return { payoutKey: e.refundKey, sellerId: e.orderId, state: e.state, executions: e.executions };
  });
}
