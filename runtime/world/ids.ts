// Stable IDs derived from content, not autoincrement: any agent that sees the same
// ticket and order computes the same refund identity, with no coordination.
import { createHash } from "node:crypto";

export function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function refundEntityId(ticketId: string, orderId: string): string {
  return `ent_refund_${stableHash(`${ticketId.trim().toUpperCase()}|${orderId.trim().toUpperCase()}`).slice(0, 16)}`;
}

// Payouts already carry a stable key from the orders DB; the entity id hashes it.
export function payoutEntityId(payoutKey: string): string {
  return `ent_payout_${stableHash(payoutKey.trim().toUpperCase()).slice(0, 16)}`;
}

// The processor idempotency key. Same entity → same key, on every retry and every agent.
export function refundKeyFor(entityId: string): string {
  return `rf_${entityId.slice("ent_refund_".length)}`;
}

export function eventIdFor(fields: Record<string, unknown>): string {
  return `evt_${stableHash(JSON.stringify(fields)).slice(0, 24)}`;
}
