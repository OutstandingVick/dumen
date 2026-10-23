// ContextBuilderService: what agents call instead of reading the log themselves.
// Returns a structured payload (not a prompt string) with trace metadata, so each agent
// formats it for its own purpose.
import { PIPELINE_MANIFEST } from "./ingest.js";
import { MAX_RETRIES } from "./machine.js";
import type { WorldStoreService } from "./store.js";
import { TERMINAL_STATES, type RefundEntity, type RefundState, type TruthEvidence, type WorldEvent } from "./types.js";

export interface RefundContext {
  entity: RefundEntity;
  terminal: boolean;
  canExecute: boolean; // APPROVED or RETRY_SAME_KEY with retries left
  retriesLeft: number;
  lastEvidence: TruthEvidence | null;
  history: Array<Pick<WorldEvent, "seq" | "ts" | "type" | "from" | "to" | "agentId" | "reason">>;
  alerts: string[];
  trace: {
    strategy: string;
    selectionReason: string;
    historyIncluded: number;
    historyTotal: number;
  };
}

const HISTORY_BUDGET = 25;

export class ContextBuilderService {
  constructor(private readonly store: WorldStoreService) {}

  // Accepts a refund_key (what the processor and Zetaris know) or an entity id.
  getRefundContext(refundKeyOrEntityId: string): RefundContext | null {
    const entityId = this.store.entityIdForRefundKey(refundKeyOrEntityId) ?? refundKeyOrEntityId;
    const entity = this.store.entity(entityId);
    if (!entity) return null;
    const events = this.store.events(entityId);
    const recent = events.slice(-HISTORY_BUDGET);
    const state: RefundState = entity.state;
    return {
      entity,
      terminal: TERMINAL_STATES.has(state),
      canExecute: state === "APPROVED" || (state === "RETRY_SAME_KEY" && entity.retries <= MAX_RETRIES + entity.humanApprovals),
      retriesLeft: Math.max(0, MAX_RETRIES + entity.humanApprovals - entity.retries),
      lastEvidence: entity.lastEvidence,
      history: recent.map(({ seq, ts, type, from, to, agentId, reason }) => ({ seq, ts, type, from, to, agentId, reason })),
      alerts: events.filter((e) => e.type === "alert").map((e) => e.reason ?? ""),
      trace: {
        strategy: "single-entity timeline, most recent first by seq",
        selectionReason: `exact match on ${entityId === refundKeyOrEntityId ? "entity id" : "refund_key"}`,
        historyIncluded: recent.length,
        historyTotal: events.length,
      },
    };
  }

  // Wired-vs-helper manifest for the run record: which world-model parts are live.
  manifest() {
    return {
      services: {
        WorldStoreService: "wired",
        IngestPipelineService: "wired",
        ContextBuilderService: "wired",
        EnrichmentService: "not built (no enrichment needed for refunds)",
        RelationshipService: "not built (edges implicit on entity)",
        ControlPlaneService: "partial — health() only",
        SupervisorAgent: "not built — escalations go to the escalation queue (Phase 3 step 3)",
      },
      pipeline: PIPELINE_MANIFEST,
      contextBuilder: { historyBudget: HISTORY_BUDGET, memories: "not wired yet (H-MEM, step 2)" },
    };
  }
}
