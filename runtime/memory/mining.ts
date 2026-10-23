// MemoryMiningService: turn runtime events into lessons. Dumen uses the spec's no-model
// path (§6): lessons are mined in code from Verifier outcomes, so the safety path never
// depends on a model being up — and sample mode mines the same lessons as a live run.
import { memoryId, type MemoryStoreService } from "./store.js";
import type { MemoryRecord } from "./types.js";

// One Verifier outcome after an uncertain execution (timeout or 202).
export interface VerificationOutcome {
  agentId: string;
  taskId: string;
  refundKey: string;
  orderId: string;
  executorResult: "timeout" | "accepted" | "failed";
  verdict: "paid" | "not_paid" | "conflict" | "unavailable";
  settleMs: number | null; // call start → first refund_truth check that showed it paid
}

const DOMAIN = "refund-ops";
const SAFETY_MARGIN = 1.5;

export class MemoryMiningService {
  constructor(private readonly store: MemoryStoreService) {}

  mineVerification(o: VerificationOutcome): MemoryRecord[] {
    const mined: MemoryRecord[] = [];
    if (o.verdict === "paid" && o.settleMs !== null) mined.push(this.settleDelay(o));
    if (o.verdict === "paid" && o.executorResult === "timeout") mined.push(this.counter(o, "paid_despite_timeout"));
    if (o.verdict === "not_paid" && o.executorResult !== "failed") mined.push(this.counter(o, "not_paid_after_uncertain_call"));
    return mined;
  }

  // "processor slow_confirm: refund appeared in the log after Xms, wait before retrying"
  private settleDelay(o: VerificationOutcome): MemoryRecord {
    const id = memoryId("settle_delay", "processor");
    const prev = this.store.get(id)?.data as { observations: number; maxMs: number; totalMs: number } | undefined;
    const observations = (prev?.observations ?? 0) + 1;
    const maxMs = Math.max(prev?.maxMs ?? 0, o.settleMs!);
    const totalMs = (prev?.totalMs ?? 0) + o.settleMs!;
    const recommendedWaitMs = Math.ceil((maxMs * SAFETY_MARGIN) / 100) * 100;
    return this.store.upsert(
      {
        id,
        content: `Processor confirmations reached refund_truth up to ${maxMs}ms after the call (${observations} observations, mean ${Math.round(totalMs / observations)}ms). Wait about ${recommendedWaitMs}ms before treating a refund as not paid.`,
        type: "procedural",
        tags: ["processor", "settle-delay", "wait-window", "verification", "slow_confirm"],
        confidence: Math.min(0.95, 0.5 + 0.1 * observations),
        source: "verifier.outcome",
        domain: DOMAIN,
        namespace: "refund-ops/processor-timing",
        entities: ["processor", "refund_truth"],
        relatedTo: [],
        supersedes: null,
        derivedFrom: [],
        agentId: o.agentId,
        runId: this.store.runId,
        taskId: o.taskId,
        data: { kind: "settle_delay", observations, maxMs, totalMs, recommendedWaitMs },
      },
      "MemoryMiningService",
    );
  }

  private counter(o: VerificationOutcome, kind: "paid_despite_timeout" | "not_paid_after_uncertain_call"): MemoryRecord {
    const id = memoryId(kind, "processor");
    const prev = this.store.get(id)?.data as { observations: number; refundKeys: string[] } | undefined;
    const observations = (prev?.observations ?? 0) + 1;
    const refundKeys = [...(prev?.refundKeys ?? []), o.refundKey].slice(-10);
    const content =
      kind === "paid_despite_timeout"
        ? `The processor paid ${observations} refund(s) even though the call timed out. A timeout is not a failure: verify in refund_truth before any retry.`
        : `${observations} uncertain call(s) were verified as not paid; retrying with the same refund_key after verification was safe.`;
    return this.store.upsert(
      {
        id,
        content,
        type: "procedural",
        tags: ["processor", "timeout", "verification", kind === "paid_despite_timeout" ? "lost_response" : "retry"],
        confidence: Math.min(0.95, 0.5 + 0.1 * observations),
        source: "verifier.outcome",
        domain: DOMAIN,
        namespace: "refund-ops/processor-reliability",
        entities: ["processor", "refund_truth"],
        relatedTo: [memoryId("settle_delay", "processor")],
        supersedes: null,
        derivedFrom: [],
        agentId: o.agentId,
        runId: this.store.runId,
        taskId: o.taskId,
        data: { kind, observations, refundKeys },
      },
      "MemoryMiningService",
    );
  }
}

// Auto-policy for the approval boundary (spec §9.1): lessons seen at least twice with
// enough confidence become long-term memory.
export const PROMOTION_POLICY = (m: MemoryRecord) => Number(m.data.observations ?? 0) >= 2 && m.confidence >= 0.6;
