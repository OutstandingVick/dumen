// The refund state machine and its invariants. IngestPipelineService runs every
// transition through checkTransition() before it reaches the log; a violation is
// refused, so the world can never record an unsafe state change.
import type { EventInput, RefundEntity, RefundState } from "./types.js";

export const MAX_RETRIES = 2;

const TRANSITIONS: Record<RefundState, readonly RefundState[]> = {
  RECEIVED: ["INTAKE_REVIEW"],
  // ESCALATED: the Verifier found the order in conflict before anything was paid.
  INTAKE_REVIEW: ["APPROVED", "REJECTED", "ESCALATED"],
  APPROVED: ["EXECUTING"],
  REJECTED: [],
  EXECUTING: ["CONFIRMED", "UNKNOWN", "FAILED_DEFINITE"],
  CONFIRMED: [],
  UNKNOWN: ["VERIFYING"], // invariant (b): UNKNOWN can only go to VERIFYING
  FAILED_DEFINITE: [],
  VERIFYING: ["CONFIRMED", "RETRY_SAME_KEY", "ESCALATED"],
  RETRY_SAME_KEY: ["EXECUTING"],
  ESCALATED: [],
};

export class InvariantViolation extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export function checkTransition(entity: RefundEntity, ev: EventInput): void {
  const from = entity.state;
  const to = ev.to!;
  if (ev.from !== from) {
    throw new InvariantViolation("STALE_TRANSITION", `${entity.id} is ${from}, event expected ${ev.from}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    throw new InvariantViolation("ILLEGAL_TRANSITION", `${from} → ${to} is not allowed`);
  }

  if (to === "EXECUTING") {
    // Invariant (a): at most one successful payment per refund key. Execution is only
    // allowed before any payment (APPROVED) or after VERIFYING proved nothing was paid.
    if (from === "RETRY_SAME_KEY") {
      const e = entity.lastEvidence;
      if (!e || e.truth !== "not_paid" || e.success_count !== 0) {
        throw new InvariantViolation("RETRY_WITHOUT_PROOF", "retry needs verified not_paid evidence with 0 payments");
      }
    }
  }

  if (from === "VERIFYING") {
    // Invariant (c): leaving VERIFYING needs evidence; anything undecided escalates.
    const e = ev.evidence;
    if (to !== "ESCALATED" && !e) throw new InvariantViolation("NO_EVIDENCE", `VERIFYING → ${to} needs refund_truth evidence`);
    if (to === "CONFIRMED" && !(e!.truth === "paid" && e!.success_count === 1)) {
      throw new InvariantViolation("CONFIRM_WITHOUT_PAYMENT", `truth=${e!.truth} success_count=${e!.success_count}`);
    }
    if (to === "RETRY_SAME_KEY") {
      if (!(e!.truth === "not_paid" && e!.success_count === 0)) {
        throw new InvariantViolation("RETRY_WITHOUT_PROOF", `truth=${e!.truth} success_count=${e!.success_count}`);
      }
      if (entity.retries >= MAX_RETRIES) {
        throw new InvariantViolation("RETRY_LIMIT", `already retried ${entity.retries} times; must escalate`);
      }
    }
  }
}
