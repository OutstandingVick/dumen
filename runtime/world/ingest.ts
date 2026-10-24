// IngestPipelineService: the only write path into the world. Every agent writes through it.
// Of the spec's 10-step canonical pipeline, Dumen wires the steps a refund timeline needs
// (see PIPELINE_MANIFEST); the rest are recorded as not applicable rather than left silent.
import { payoutEntityId, refundEntityId, refundKeyFor } from "./ids.js";
import { checkTransition, InvariantViolation } from "./machine.js";
import type { WorldStoreService } from "./store.js";
import type { EventInput, Provenance, RefundEntity, RefundState, TruthEvidence, WorldEvent } from "./types.js";

export const PIPELINE_MANIFEST = {
  reconcile: "wired — duplicate events detected by content-hash eventId and skipped",
  cluster_classify: "wired — events grouped per refund entity (stable id from ticket_id + order_id)",
  persist_primary: "wired — appended to logs/<runId>/world.jsonl before indexing",
  score_measure: "not applicable — refunds have no ranking/velocity",
  infer_derived: "wired — invariant violations and duplicate payments become alert events",
  persist_edges: "implicit — entity carries order_id/ticket_id; no edge store needed yet",
  rebuild_views: "wired — entity state recomputed from the log on every read",
  patch_source_items: "not applicable — tickets are immutable inputs",
  rebuild_aggregates: "wired — executions/retries/lastEvidence recomputed by reduceEntity",
  mark_stale: "not wired — no long-lived entities across runs yet",
} as const;

export interface IngestResult {
  event: WorldEvent;
  entity: RefundEntity;
  duplicate: boolean;
}

export interface Actor {
  agentId: string;
  taskId: string;
}

export class IngestPipelineService {
  constructor(private readonly store: WorldStoreService) {}

  // Raw event ingest: idempotent, invariant-checked, serialized per entity.
  ingest(input: EventInput): Promise<IngestResult> {
    return this.store.withEntityLock(input.entityId, () => {
      const eventId = this.store.eventIdOf(input);
      if (this.store.has(eventId)) {
        const event = this.store.events(input.entityId).find((e) => e.eventId === eventId)!;
        return { event, entity: this.store.entity(input.entityId)!, duplicate: true };
      }

      if (input.type === "state.transition") {
        const current = this.store.entity(input.entityId);
        if (!current) throw new InvariantViolation("UNKNOWN_ENTITY", input.entityId);
        try {
          checkTransition(current, input);
        } catch (err) {
          if (err instanceof InvariantViolation) {
            // Refused transitions are evidence too: record them, then refuse.
            this.store.append({ ...input, type: "alert", reason: err.message });
          }
          throw err;
        }
      }

      const event = this.store.append(input);
      if (input.evidence && input.evidence.success_count > 1) {
        this.store.append({
          ...input,
          type: "alert",
          from: undefined,
          to: undefined,
          reason: `DUPLICATE_PAYMENT: processor paid ${input.evidence.success_count}× for ${this.store.entity(input.entityId)?.refundKey}`,
        });
      }
      return { event, entity: this.store.entity(input.entityId)!, duplicate: false };
    });
  }

  // Create (or re-find) the refund entity for a ticket. Same ticket + order → same entity.
  async receive(
    ticket: { ticket_id: string; order_id: string; amount_requested?: number; currency?: string },
    actor: Actor,
  ): Promise<IngestResult> {
    const entityId = refundEntityId(ticket.ticket_id, ticket.order_id);
    return this.ingest({
      entityId,
      type: "entity.created",
      agentId: actor.agentId,
      runId: this.store.runId,
      taskId: actor.taskId,
      provenance: { source: "ticket", rows: [ticket] },
      data: {
        refundKey: refundKeyFor(entityId),
        ticketId: ticket.ticket_id,
        orderId: ticket.order_id,
        amount: ticket.amount_requested,
        currency: ticket.currency,
      },
    });
  }

  // Create (or re-find) the payout entity. Its idempotency key is the payout_key itself.
  async receivePayout(
    payout: { payout_key: string; seller_id: string; batch_id: string; amount: number },
    actor: Actor,
  ): Promise<IngestResult> {
    return this.ingest({
      entityId: payoutEntityId(payout.payout_key),
      type: "entity.created",
      agentId: actor.agentId,
      runId: this.store.runId,
      taskId: actor.taskId,
      provenance: { source: "ticket", rows: [payout], note: "scheduled payout" },
      data: {
        kind: "payout",
        refundKey: payout.payout_key,
        ticketId: payout.payout_key,
        orderId: payout.seller_id,
        batchId: payout.batch_id,
        amount: payout.amount,
      },
    });
  }

  async transition(
    entityId: string,
    to: RefundState,
    actor: Actor,
    opts: { provenance: Provenance; evidence?: TruthEvidence; reason?: string; data?: Record<string, unknown> },
  ): Promise<IngestResult> {
    const current = this.store.entity(entityId);
    if (!current) throw new InvariantViolation("UNKNOWN_ENTITY", entityId);
    return this.ingest({
      entityId,
      type: "state.transition",
      from: current.state,
      to,
      attempt: current.executions,
      agentId: actor.agentId,
      runId: this.store.runId,
      taskId: actor.taskId,
      ...opts,
    });
  }

  async observe(
    entityId: string,
    actor: Actor,
    opts: { provenance: Provenance; evidence?: TruthEvidence; reason?: string; data?: Record<string, unknown> },
  ): Promise<IngestResult> {
    const current = this.store.entity(entityId);
    return this.ingest({
      entityId,
      type: "observation",
      attempt: current?.executions ?? 0,
      agentId: actor.agentId,
      runId: this.store.runId,
      taskId: actor.taskId,
      ...opts,
    });
  }
}
