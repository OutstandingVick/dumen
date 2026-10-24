// Meterless World Model Agent Engine — record types for Dumen's refund world.
// Aggregate shape: timeline (Example A). Each refund entity's state is a sequence of
// immutable events; current state is recomputed from them, never edited in place.

export const WORLD_SCHEMA_VERSION = 1;

export const REFUND_STATES = [
  "RECEIVED",
  "INTAKE_REVIEW",
  "APPROVED",
  "REJECTED",
  "EXECUTING",
  "CONFIRMED",
  "UNKNOWN",
  "FAILED_DEFINITE",
  "VERIFYING",
  "RETRY_SAME_KEY",
  "ESCALATED",
] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<RefundState> = new Set(["REJECTED", "CONFIRMED", "ESCALATED"]);

// Where a belief came from: the query or response that justified it.
export interface Provenance {
  source: "ticket" | "intake" | "processor" | "zetaris" | "policy";
  query?: string;
  rows?: unknown[];
  response?: unknown;
  note?: string;
}

// What the Verifier saw in Zetaris refund_truth. Required to leave VERIFYING.
export interface TruthEvidence {
  truth: "paid" | "not_paid" | "conflict" | "unavailable";
  success_count: number;
  paid_amount: number;
  checked_at: string;
}

export interface WorldEvent {
  schemaVersion: number;
  eventId: string; // content hash of the event's identity fields → idempotent ingest
  seq: number; // position in the append log, assigned by the store
  ts: string;
  entityId: string;
  type: "entity.created" | "state.transition" | "observation" | "alert";
  from?: RefundState;
  to?: RefundState;
  attempt?: number; // execution attempt number (0 = first call)
  agentId: string;
  runId: string;
  taskId: string; // ticket_id
  provenance: Provenance;
  evidence?: TruthEvidence;
  reason?: string;
  data?: Record<string, unknown>;
}

// The fields a caller supplies; the store adds schemaVersion, eventId, seq, ts.
export type EventInput = Omit<WorldEvent, "schemaVersion" | "eventId" | "seq" | "ts">;

export type ActionKind = "refund" | "payout";

// Canonical money-moving action (a refund or a payout), recomputed from the log.
// refundKey / ticketId / orderId are the refund-flavoured names of actionKey / taskId /
// subjectId; payouts fill them too so every agent can read any action the same way.
export interface RefundEntity {
  id: string; // stable content hash (refund: ticket_id + order_id; payout: payout_key)
  kind: ActionKind;
  actionKey: string; // idempotency key sent to the processor or bank rail
  refundKey: string; // = actionKey
  ticketId: string; // refund: ticket id; payout: payout_key
  orderId: string; // refund: order id; payout: seller id
  batchId: string | null; // payouts only
  amount: number | null;
  currency: string | null;
  state: RefundState;
  executions: number; // how many times POST /refund was attempted
  retries: number; // RETRY_SAME_KEY transitions taken
  humanApprovals: number; // ESCALATED → VERIFYING decisions by a person
  lastEvidence: TruthEvidence | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAgentId: string;
  eventCount: number;
}
