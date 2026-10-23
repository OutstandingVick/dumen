// Meterless H-MEM Agent Engine — canonical memory record (spec §4), with the agent
// attribution fields (agentId, runId, taskId) the headless engine adds.

export type MemoryType = "personal" | "factual" | "preference" | "general" | "procedural";
export type MemoryLayer = "short_term" | "working" | "long_term";

export interface MemoryRecord {
  id: string; // stable content hash: same lesson → same id across runs
  content: string; // human-readable lesson, what gets injected
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: string;
  lastAccessed: string;
  accessCount: number;
  tags: string[];
  // Reliability
  confidence: number; // 0..1
  source: string; // which runtime event produced it
  // Hierarchy
  domain: string;
  namespace: string;
  // Graph
  entities: string[];
  relatedTo: string[];
  supersedes: string | null;
  derivedFrom: string[];
  // Agent attribution
  agentId: string;
  runId: string;
  taskId: string | null;
  // Structured payload consumers can use without parsing `content`
  data: Record<string, unknown>;
}

export interface RetrievedMemory {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  relevance: number;
  confidence: number;
  data: Record<string, unknown>;
}

// Structured reinjection payload (spec §8.2): not a pre-rendered string.
export interface MemoryContext {
  memories: RetrievedMemory[];
  trace: {
    retrievalReason: string;
    strategy: "minimal" | "task_focused" | "comprehensive";
    threshold: number;
    considered: number;
    selected: number;
  };
}

export interface LedgerEntry {
  ts: string;
  memoryId: string;
  action: "create" | "read" | "update" | "promote" | "feedback" | "hydrate" | "supersede";
  actor: string;
  runId: string;
  previousState?: unknown;
  newState?: unknown;
  details?: Record<string, unknown>;
}
