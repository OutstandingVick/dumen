// MemoryRetrievalService: hybrid ranking (spec §8.1) and a structured reinjection
// payload with trace metadata (§8.2). Defaults from §15: top-N 5, threshold 0.35.
import type { MemoryStoreService } from "./store.js";
import type { MemoryContext, MemoryRecord } from "./types.js";

export interface RetrievalQuery {
  text: string;
  tags?: string[];
  entities?: string[];
  agentId: string;
  strategy?: MemoryContext["trace"]["strategy"];
}

const TOP_N = 5;
const THRESHOLD = 0.35;
const LAYER_WEIGHT = { long_term: 0.15, working: 0.1, short_term: 0.05 } as const;

const STOPWORDS = new Set(["the", "and", "for", "how", "what", "who", "why", "was", "were", "are", "with", "that", "this", "from", "not", "any", "before", "after", "about", "into"]);

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 2 && !STOPWORDS.has(t)));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n / a.size;
}

export class MemoryRetrievalService {
  constructor(private readonly store: MemoryStoreService) {}

  score(m: MemoryRecord, q: RetrievalQuery, superseded: Set<string>): number {
    const keyword = overlap(tokens(q.text), tokens(`${m.content} ${m.tags.join(" ")}`));
    const tag = q.tags?.length ? q.tags.filter((t) => m.tags.includes(t)).length / q.tags.length : 0;
    const entity = q.entities?.length ? q.entities.filter((e) => m.entities.includes(e)).length / q.entities.length : 0;
    const ageDays = (Date.now() - Date.parse(m.timestamp)) / 86_400_000;
    const recency = 0.05 * Math.exp(-ageDays / 7);
    const sameRun = m.runId === this.store.runId ? 0.05 : 0;
    const penalty = superseded.has(m.id) ? 0.3 : 0;
    // Layer, recency and confidence only rank memories that actually match something.
    if (keyword + tag + entity === 0) return 0;
    return 0.3 * keyword + 0.25 * tag + 0.15 * entity + LAYER_WEIGHT[m.layer] + recency + sameRun + 0.1 * m.confidence - penalty;
  }

  retrieve(q: RetrievalQuery, topN = TOP_N): MemoryContext {
    const all = this.store.all();
    const superseded = new Set(all.map((m) => m.supersedes).filter((s): s is string => !!s));
    const ranked = all
      .map((m) => ({ m, relevance: this.score(m, q, superseded) }))
      .filter((r) => r.relevance >= THRESHOLD)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, topN);
    for (const r of ranked) this.store.touch(r.m.id, q.agentId, r.relevance);
    return {
      memories: ranked.map(({ m, relevance }) => ({
        id: m.id,
        content: m.content,
        type: m.type,
        layer: m.layer,
        relevance: Number(relevance.toFixed(3)),
        confidence: m.confidence,
        data: m.data,
      })),
      trace: {
        retrievalReason: `hybrid rank for "${q.text.slice(0, 80)}"${q.tags?.length ? ` tags=[${q.tags.join(",")}]` : ""}`,
        strategy: q.strategy ?? "task_focused",
        threshold: THRESHOLD,
        considered: all.length,
        selected: ranked.length,
      },
    };
  }
}

// How long the Verifier should wait before deciding "not paid", from retrieved lessons.
// Falls back to the default when nothing has been learned yet; never exceeds the cap.
export function waitWindowFrom(ctx: MemoryContext, defaultMs: number, capMs: number): { waitMs: number; source: string } {
  const lesson = ctx.memories.find((m) => m.data.kind === "settle_delay");
  const learned = Number(lesson?.data.recommendedWaitMs);
  if (!lesson || !Number.isFinite(learned)) return { waitMs: defaultMs, source: "default (no settle-delay lesson yet)" };
  return { waitMs: Math.min(capMs, Math.max(defaultMs, learned)), source: `H-MEM ${lesson.id} (${lesson.layer})` };
}
