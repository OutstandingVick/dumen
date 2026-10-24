// MemoryStoreService: tiered memory. short_term lives for one run; long_term is persisted
// to .dumen/memory/long_term.json and hydrated at the next run start (warm start).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { TrustLedgerService } from "./ledger.js";
import type { MemoryLayer, MemoryRecord } from "./types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function memoryId(kind: string, key: string): string {
  return `mem_${createHash("sha256").update(`${kind}|${key}`).digest("hex").slice(0, 16)}`;
}

export interface MemoryStoreOptions {
  runId: string;
  longTermPath?: string;
  logsDir?: string;
}

export class MemoryStoreService {
  readonly runId: string;
  readonly longTermPath: string;
  readonly ledger: TrustLedgerService;
  private readonly records = new Map<string, MemoryRecord>();

  constructor(opts: MemoryStoreOptions) {
    this.runId = opts.runId;
    this.longTermPath = opts.longTermPath ?? process.env.DUMEN_MEMORY_PATH ?? join(ROOT, ".dumen", "memory", "long_term.json");
    this.ledger = new TrustLedgerService(opts.runId, opts.logsDir ?? join(ROOT, "logs"));
  }

  // Warm start (spec §5): load long-term, de-duplicate by id.
  hydrate(): number {
    if (!existsSync(this.longTermPath)) return 0;
    const saved: MemoryRecord[] = JSON.parse(readFileSync(this.longTermPath, "utf8"));
    for (const m of saved) {
      if (this.records.has(m.id)) continue;
      this.records.set(m.id, { ...m, layer: "long_term" });
      // Record what was loaded, so a run's ledger alone shows the lesson (no need for the store file).
      this.ledger.record({ memoryId: m.id, action: "hydrate", actor: "MemoryStoreService", details: { from: this.longTermPath, content: m.content, confidence: m.confidence, runId: m.runId } });
    }
    return saved.length;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(layer?: MemoryLayer): MemoryRecord[] {
    return [...this.records.values()].filter((m) => !layer || m.layer === layer);
  }

  // Create or update by id. Same lesson re-mined with the same data is a no-op.
  upsert(input: Omit<MemoryRecord, "timestamp" | "lastAccessed" | "accessCount" | "layer"> & { layer?: MemoryLayer }, actor: string): MemoryRecord {
    const now = new Date().toISOString();
    const existing = this.records.get(input.id);
    if (existing && JSON.stringify(existing.data) === JSON.stringify(input.data) && existing.content === input.content) return existing;
    const record: MemoryRecord = {
      ...input,
      layer: existing?.layer === "long_term" ? "long_term" : (input.layer ?? "short_term"),
      timestamp: now,
      lastAccessed: existing?.lastAccessed ?? now,
      accessCount: existing?.accessCount ?? 0,
    };
    this.records.set(record.id, record);
    this.ledger.record({
      memoryId: record.id,
      action: existing ? "update" : "create",
      actor,
      previousState: existing ? { content: existing.content, data: existing.data, confidence: existing.confidence } : undefined,
      newState: { content: record.content, data: record.data, confidence: record.confidence, layer: record.layer },
    });
    return record;
  }

  touch(id: string, actor: string, relevance: number) {
    const m = this.records.get(id);
    if (!m) return;
    m.accessCount++;
    m.lastAccessed = new Date().toISOString();
    this.ledger.record({ memoryId: id, action: "read", actor, details: { relevance: Number(relevance.toFixed(3)) } });
  }

  // Outcome feedback (spec §11.2): helpful ↑, not_helpful ↓ a little, wrong ↓ more.
  feedback(id: string, verdict: "helpful" | "not_helpful" | "wrong", actor: string) {
    const m = this.records.get(id);
    if (!m) return;
    const before = m.confidence;
    const delta = verdict === "helpful" ? 0.05 : verdict === "not_helpful" ? -0.05 : -0.2;
    m.confidence = Math.min(1, Math.max(0, m.confidence + delta));
    if (verdict === "wrong" && !m.tags.includes("review")) m.tags.push("review");
    this.ledger.record({ memoryId: id, action: "feedback", actor, previousState: { confidence: before }, newState: { confidence: m.confidence }, details: { verdict } });
  }

  // Programmable approval boundary: promote short-term lessons that meet the policy.
  promote(policy: (m: MemoryRecord) => boolean, actor: string): MemoryRecord[] {
    const promoted: MemoryRecord[] = [];
    for (const m of this.all("short_term")) {
      if (!policy(m)) continue;
      m.layer = "long_term";
      promoted.push(m);
      this.ledger.record({ memoryId: m.id, action: "promote", actor, previousState: { layer: "short_term" }, newState: { layer: "long_term" } });
    }
    return promoted;
  }

  // Persist long-term only; short-term dies with the run. Atomic write via rename.
  persist(): number {
    const longTerm = this.all("long_term");
    mkdirSync(dirname(this.longTermPath), { recursive: true });
    const tmp = `${this.longTermPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(longTerm, null, 2) + "\n");
    renameSync(tmp, this.longTermPath);
    return longTerm.length;
  }
}
