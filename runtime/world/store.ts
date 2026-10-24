// WorldStoreService: the append-only event log and the canonical state recomputed from it.
// Substrate: logs/<runId>/world.jsonl (durable, append-only) with an in-memory index as the
// write-through cache. Reopening a run reloads the file, so a crashed run resumes its world.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventIdFor } from "./ids.js";
import { WORLD_SCHEMA_VERSION, type EventInput, type RefundEntity, type WorldEvent } from "./types.js";

const LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "logs");

// The fields that make two events "the same event". Re-ingesting them is a no-op.
function identityOf(ev: EventInput): Record<string, unknown> {
  const base = { runId: ev.runId, entityId: ev.entityId, type: ev.type, taskId: ev.taskId };
  switch (ev.type) {
    case "entity.created":
      return base;
    case "state.transition":
      return { ...base, from: ev.from, to: ev.to, attempt: ev.attempt ?? null };
    case "observation":
      return { ...base, attempt: ev.attempt ?? null, provenance: ev.provenance, evidence: ev.evidence ?? null };
    case "alert":
      return { ...base, reason: ev.reason, from: ev.from, to: ev.to, attempt: ev.attempt ?? null };
  }
}

// Recompute one entity from its events. Never mutated anywhere else.
export function reduceEntity(events: WorldEvent[]): RefundEntity | null {
  let e: RefundEntity | null = null;
  for (const ev of events) {
    if (ev.type === "entity.created") {
      const d = ev.data as { kind?: "refund" | "payout"; refundKey: string; ticketId: string; orderId: string; batchId?: string; amount?: number; currency?: string };
      e = {
        id: ev.entityId,
        kind: d.kind ?? "refund",
        actionKey: d.refundKey,
        refundKey: d.refundKey,
        ticketId: d.ticketId,
        orderId: d.orderId,
        batchId: d.batchId ?? null,
        amount: d.amount ?? null,
        currency: d.currency ?? null,
        state: "RECEIVED",
        executions: 0,
        retries: 0,
        humanApprovals: 0,
        lastEvidence: null,
        firstSeenAt: ev.ts,
        lastSeenAt: ev.ts,
        lastAgentId: ev.agentId,
        eventCount: 0,
      };
    }
    if (!e) continue;
    if (ev.type === "state.transition" && ev.to) {
      e.state = ev.to;
      if (ev.to === "EXECUTING") e.executions++;
      if (ev.to === "RETRY_SAME_KEY") e.retries++;
      if (ev.from === "ESCALATED" && ev.to === "VERIFYING") e.humanApprovals++;
      if (ev.to === "APPROVED" && typeof ev.data?.amount === "number") e.amount = ev.data.amount;
    }
    if (ev.evidence) e.lastEvidence = ev.evidence;
    e.lastSeenAt = ev.ts;
    e.lastAgentId = ev.agentId;
    e.eventCount++;
  }
  return e;
}

export class WorldStoreService {
  readonly path: string;
  private readonly log: WorldEvent[] = [];
  private readonly byId = new Set<string>();
  private readonly byEntity = new Map<string, WorldEvent[]>();
  private readonly byRefundKey = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly runId: string, dir = join(LOGS_DIR, runId)) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "world.jsonl");
    if (existsSync(this.path)) {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim()) this.index(JSON.parse(line) as WorldEvent);
      }
    }
  }

  private index(ev: WorldEvent) {
    if (ev.schemaVersion !== WORLD_SCHEMA_VERSION) throw new Error(`world.jsonl schema v${ev.schemaVersion}, expected v${WORLD_SCHEMA_VERSION}`);
    this.log.push(ev);
    this.byId.add(ev.eventId);
    const list = this.byEntity.get(ev.entityId) ?? [];
    list.push(ev);
    this.byEntity.set(ev.entityId, list);
    if (ev.type === "entity.created") this.byRefundKey.set(String(ev.data?.refundKey), ev.entityId);
  }

  eventIdOf(input: EventInput): string {
    return eventIdFor(identityOf(input));
  }

  has(eventId: string): boolean {
    return this.byId.has(eventId);
  }

  // Durable append: the file is written before the in-memory index, so the index never
  // knows an event the log doesn't.
  append(input: EventInput): WorldEvent {
    const ev: WorldEvent = {
      schemaVersion: WORLD_SCHEMA_VERSION,
      eventId: this.eventIdOf(input),
      seq: this.log.length,
      ts: new Date().toISOString(),
      ...input,
    };
    appendFileSync(this.path, JSON.stringify(ev) + "\n");
    this.index(ev);
    return ev;
  }

  // Per-entity FIFO: one writer at a time per refund, so concurrent agents can't interleave.
  withEntityLock<T>(entityId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.locks.get(entityId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(entityId, next.catch(() => undefined));
    return next;
  }

  events(entityId: string): WorldEvent[] {
    return [...(this.byEntity.get(entityId) ?? [])];
  }

  entity(entityId: string): RefundEntity | null {
    return reduceEntity(this.byEntity.get(entityId) ?? []);
  }

  entityIdForRefundKey(refundKey: string): string | undefined {
    return this.byRefundKey.get(refundKey);
  }

  entities(): RefundEntity[] {
    return [...this.byEntity.keys()].map((id) => this.entity(id)!).filter(Boolean);
  }

  health() {
    const states: Record<string, number> = {};
    for (const e of this.entities()) states[e.state] = (states[e.state] ?? 0) + 1;
    return {
      schemaVersion: WORLD_SCHEMA_VERSION,
      runId: this.runId,
      events: this.log.length,
      entities: this.byEntity.size,
      alerts: this.log.filter((e) => e.type === "alert").length,
      states,
    };
  }
}
