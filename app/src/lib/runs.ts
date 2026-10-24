// Reads Dumen run artifacts from ../logs. Read-only: every number on the dashboard comes
// from these files, nothing is invented or cached.
import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(process.env.DUMEN_ROOT ?? join(process.cwd(), ".."));
export const LOGS = join(ROOT, "logs");
// Committed demo runs (a live Nemotron run and its baseline), so a fresh clone has something real to show.
export const DEMO = join(ROOT, "samples", "demo");
const RUN_DIRS = [LOGS, DEMO];
const RUN_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_(baseline|dumen)_seed(\d+)$/;

export type Agent = "baseline" | "dumen";

export interface Summary {
  run_id: string;
  agent: Agent;
  seed: number;
  rates: { lost: number; slow: number; fail: number; down: number };
  intake?: string;
  fresh_memory?: boolean;
  duration_ms?: number;
  tickets_processed: number;
  outcomes: Record<string, number>;
  processor_calls: number;
  total_refunded: number;
  double_refunds: number;
  money_lost: number;
  escalations?: number;
  rejections?: number;
  doubles: Array<{ order_id: string; payments: number; paid: number; keys: string[] }>;
  overpaid_orders?: Array<{ order_id: string; paid: number; owed: number }>;
  failures?: { zetaris_down?: boolean; nightshift_down?: boolean };
  payouts?: PayoutSummary;
}

export interface PayoutSummary {
  batches: number;
  payouts: number;
  outcomes: Record<string, number>;
  bank_calls: number;
  total_paid: number;
  duplicate_payouts: number;
  money_lost: number;
  overpaid: string[];
  changed_account_paid: string[];
  high_value_paid: string[];
  escalations: number;
  rejections: number;
  duplicates: Array<{ payout_key: string; payments: number; paid: number }>;
}

export interface RunInfo {
  id: string;
  dir: string; // folder holding this run's files
  demo: boolean; // from samples/demo (committed), not a local run
  agent: Agent;
  seed: number;
  startedAt: string;
  summary: Summary | null;
}

export interface TraceLine {
  ts: string;
  agent: string;
  ticket_id: string;
  action: string;
  input?: any;
  output?: any;
  reason?: string;
}

export interface WorldEvent {
  seq: number;
  ts: string;
  entityId: string;
  type: "entity.created" | "state.transition" | "observation" | "alert";
  from?: string;
  to?: string;
  attempt?: number;
  agentId: string;
  taskId: string;
  provenance: { source: string; query?: string; rows?: unknown[]; response?: unknown; note?: string };
  evidence?: { truth: string; success_count: number; paid_amount: number; checked_at: string };
  reason?: string;
  data?: Record<string, any>;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
}

function isoFromRunStamp(stamp: string): string {
  // 2026-10-23T15-37-15-003Z → 2026-10-23T15:37:15.003Z
  return stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
}

export function listRuns(): RunInfo[] {
  const seen = new Set<string>();
  const runs: RunInfo[] = [];
  for (const base of RUN_DIRS) {
    if (!existsSync(base)) continue;
    for (const d of readdirSync(base)) {
      const m = d.match(RUN_RE);
      if (!m || seen.has(d)) continue; // a local copy wins over the committed demo copy
      const summary = readJson<Summary>(join(base, d, "summary.json"));
      if (!summary) continue;
      seen.add(d);
      runs.push({ id: d, dir: join(base, d), demo: base === DEMO, agent: m[2] as Agent, seed: Number(m[3]), startedAt: isoFromRunStamp(m[1]), summary });
    }
  }
  return runs.sort((a, b) => b.id.localeCompare(a.id));
}

// Any chaos run resets the databases, so only the newest local run still matches them.
export function latestRunId(): string | null {
  return listRuns().find((r) => !r.demo)?.id ?? null;
}

export interface ComparePair {
  baseline: RunInfo | null;
  dumen: RunInfo | null;
  source: "compare" | "matched";
}

// The counterpart run for side-by-side: first from a compare.json that contains this run,
// otherwise the closest run of the other agent with the same seed and lost rate.
export function pairFor(run: RunInfo): ComparePair {
  const runs = listRuns();
  const byId = new Map(runs.map((r) => [r.id, r]));
  const compares = RUN_DIRS.filter(existsSync).flatMap((base) => readdirSync(base).filter((x) => x.startsWith("compare-")).map((x) => join(base, x)));
  for (const d of compares.sort().reverse()) {
    const c = readJson<{ rows: Array<{ baseline: { run_id: string }; dumen: { run_id: string } }> }>(join(d, "compare.json"));
    const row = c?.rows.find((r) => r.baseline.run_id === run.id || r.dumen.run_id === run.id);
    if (row) return { baseline: byId.get(row.baseline.run_id) ?? null, dumen: byId.get(row.dumen.run_id) ?? null, source: "compare" };
  }
  const other: Agent = run.agent === "dumen" ? "baseline" : "dumen";
  const lost = run.summary?.rates.lost;
  const candidates = runs
    .filter((r) => r.agent === other && r.seed === run.seed && r.summary?.rates.lost === lost)
    .sort((a, b) => Math.abs(Date.parse(a.startedAt) - Date.parse(run.startedAt)) - Math.abs(Date.parse(b.startedAt) - Date.parse(run.startedAt)));
  const match = candidates[0] ?? null;
  return run.agent === "dumen" ? { baseline: match, dumen: run, source: "matched" } : { baseline: run, dumen: match, source: "matched" };
}

export interface Refund {
  key: string; // entityId for dumen, ticket id for baseline
  ticketId: string;
  orderId: string;
  refundKey: string | null;
  amount: number | null;
  state: string;
  calls: number;
  retried: boolean;
  verified: boolean; // went through VERIFYING (an uncertain call was checked in refund_truth)
  paidTwice: boolean;
  humanDecision: string | null;
}

export interface Run {
  info: RunInfo;
  summary: Summary;
  trace: TraceLine[];
  world: WorldEvent[];
  escalations: Escalation[];
  manifest: any;
  isLatest: boolean;
}

export type Kind = "refund" | "payout";

export interface Escalation {
  case_id: string;
  kind?: Kind;
  ticket_id: string;
  order_id: string;
  refund_key: string;
  amount: number | null;
  state_history: string[];
  last_evidence: { truth: string; success_count: number; paid_amount: number } | null;
  reason: string;
  summary: string;
  summary_source: "model" | "template";
  created_at: string;
  decision?: { verdict: "approve" | "reject"; reason: string; at: string; outcome?: string };
}

export function loadRun(id: string): Run | null {
  const info = listRuns().find((r) => r.id === id);
  if (!info?.summary) return null;
  const dir = info.dir;
  return {
    info,
    summary: info.summary,
    trace: readJsonl<TraceLine>(join(dir, "trace.jsonl")),
    world: readJsonl<WorldEvent>(join(dir, "world.jsonl")),
    escalations: readJson<Escalation[]>(join(dir, "escalations.json")) ?? [],
    manifest: readJson(join(dir, "manifest.json")),
    isLatest: latestRunId() === id,
  };
}

function doubleKeys(s: Summary): Set<string> {
  const keys = new Set<string>();
  for (const d of s.doubles) for (const k of d.keys) keys.add(k.replace(/×\d+$/, ""));
  return keys;
}

export function refundsOf(run: Run, kind: Kind = "refund"): Refund[] {
  if (kind === "payout") return payoutsOf(run);
  const doubled = doubleKeys(run.summary);
  if (run.info.agent === "dumen") {
    const byEntity = new Map<string, WorldEvent[]>();
    for (const e of run.world) byEntity.set(e.entityId, [...(byEntity.get(e.entityId) ?? []), e]);
    return [...byEntity.entries()]
      .filter(([, events]) => (events.find((e) => e.type === "entity.created")?.data?.kind ?? "refund") === "refund")
      .map(([entityId, events]) => {
        const created = events.find((e) => e.type === "entity.created");
        const transitions = events.filter((e) => e.type === "state.transition");
        const approved = transitions.find((e) => e.to === "APPROVED");
        const human = [...transitions].reverse().find((e) => e.agentId === "human");
        const refundKey = (created?.data?.refundKey as string) ?? null;
        return {
          key: entityId,
          ticketId: created?.data?.ticketId ?? events[0].taskId,
          orderId: created?.data?.orderId ?? "",
          refundKey,
          amount: (approved?.data?.amount as number) ?? (created?.data?.amount as number) ?? null,
          state: transitions.at(-1)?.to ?? "RECEIVED",
          calls: transitions.filter((e) => e.to === "EXECUTING").length,
          retried: transitions.some((e) => e.to === "RETRY_SAME_KEY"),
          verified: transitions.some((e) => e.to === "VERIFYING"),
          paidTwice: !!refundKey && doubled.has(refundKey),
          humanDecision: human ? `${human.to} by human` : null,
        };
      })
      .sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  }

  // Baseline has no world model; rebuild each ticket from its trace.
  const byTicket = new Map<string, TraceLine[]>();
  for (const t of run.trace) if (/^T-/.test(t.ticket_id)) byTicket.set(t.ticket_id, [...(byTicket.get(t.ticket_id) ?? []), t]);
  return [...byTicket.entries()]
    .map(([ticketId, lines]) => {
      const pending = lines.find((l) => l.action === "record_pending");
      const refundKey = pending?.input?.refund_key ?? null;
      const calls = lines.filter((l) => l.action === "call_refund" || l.action === "retry_refund").length;
      const result = [...lines].reverse().find((l) => l.action === "record_result");
      const lookup = lines.find((l) => l.action === "lookup_order");
      const decide = lines.find((l) => l.action === "decide");
      const paidTwice = !!refundKey && doubled.has(refundKey);
      const orderDouble = run.summary.doubles.some((d) => d.order_id === lookup?.input?.order_id);
      let state = result?.output?.internal_status === "succeeded" ? "PAID" : result?.output?.internal_status === "failed" ? "FAILED" : calls ? "TIMED_OUT" : decide?.output?.decision === "decline" ? "DECLINED" : "ERROR";
      if (paidTwice || orderDouble) state = "PAID_TWICE";
      return {
        key: ticketId,
        ticketId,
        orderId: lookup?.input?.order_id ?? "",
        refundKey,
        amount: pending?.input?.amount ?? null,
        state,
        calls,
        retried: calls > 1,
        verified: false,
        paidTwice: paidTwice || orderDouble,
        humanDecision: null,
      };
    })
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId));
}

const BATCH_ACTIONS = new Set(["send_batch", "resend_batch", "verify_batch", "verifier→executor: resend_unpaid_only"]);
// Does a batch-level trace line (send / verify / re-send) involve this payout?
const batchLineMentions = (t: TraceLine, key: string) => JSON.stringify([t.input?.items, t.input?.payouts, t.input?.resend]).includes(`"${key}"`);

// Payout rows: Dumen from the World Model, baseline from its batch trace.
export function payoutsOf(run: Run): Refund[] {
  const dupes = new Map((run.summary.payouts?.duplicates ?? []).map((d) => [d.payout_key, d.payments]));
  if (run.info.agent === "dumen") {
    const byEntity = new Map<string, WorldEvent[]>();
    for (const e of run.world) byEntity.set(e.entityId, [...(byEntity.get(e.entityId) ?? []), e]);
    return [...byEntity.entries()]
      .filter(([, events]) => events.find((e) => e.type === "entity.created")?.data?.kind === "payout")
      .map(([entityId, events]) => {
        const created = events.find((e) => e.type === "entity.created")!;
        const transitions = events.filter((e) => e.type === "state.transition");
        const human = [...transitions].reverse().find((e) => e.agentId === "human");
        const key = created.data!.refundKey as string;
        return {
          key: entityId,
          ticketId: key,
          orderId: `${created.data!.orderId} · ${created.data!.batchId}`,
          refundKey: key,
          amount: (created.data!.amount as number) ?? null,
          state: transitions.at(-1)?.to ?? "RECEIVED",
          calls: transitions.filter((e) => e.to === "EXECUTING").length,
          retried: transitions.some((e) => e.to === "RETRY_SAME_KEY"),
          verified: transitions.some((e) => e.to === "VERIFYING"),
          paidTwice: (dupes.get(key) ?? 0) > 1,
          humanDecision: human ? `${human.to} by human` : null,
        };
      })
      .sort((a, b) => a.ticketId.localeCompare(b.ticketId));
  }
  const sends = run.trace.filter((t) => t.action === "send_batch" || t.action === "resend_batch");
  const items = new Map<string, { amount: number; batch: string; calls: number; lastOk: boolean }>();
  for (const t of sends) {
    for (const it of t.input?.items ?? []) {
      const cur = items.get(it.payout_key) ?? { amount: it.amount, batch: t.input.batch_id, calls: 0, lastOk: false };
      cur.calls++;
      cur.lastOk = t.output?.http === 200 || t.output?.http === 202;
      items.set(it.payout_key, cur);
    }
  }
  const risky = new Set([...(run.summary.payouts?.changed_account_paid ?? []), ...(run.summary.payouts?.high_value_paid ?? []), ...(run.summary.payouts?.overpaid ?? [])]);
  return [...items.entries()]
    .map(([key, v]) => ({
      key,
      ticketId: key,
      orderId: v.batch,
      refundKey: key,
      amount: v.amount,
      state: (dupes.get(key) ?? 0) > 1 ? "PAID_TWICE" : risky.has(key) ? "PAID_RISKY" : v.lastOk ? "PAID" : "TIMED_OUT",
      calls: v.calls,
      retried: v.calls > 1,
      verified: false,
      paidTwice: (dupes.get(key) ?? 0) > 1,
      humanDecision: null,
    }))
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId));
}

export interface TimelineItem {
  ts: string;
  kind: "transition" | "observation" | "alert" | "handoff" | "memory" | "step";
  agent: string;
  title: string;
  from?: string;
  to?: string;
  reason?: string;
  evidence?: { query?: string; rows?: unknown[]; response?: unknown; truth?: unknown; note?: string };
}

const HANDOFF = /→/;

export function timelineOf(run: Run, key: string): TimelineItem[] {
  if (run.info.agent === "dumen") {
    const events = run.world.filter((e) => e.entityId === key);
    const ticketId = events[0]?.taskId;
    const items: TimelineItem[] = events.map((e) => ({
      ts: e.ts,
      kind: e.type === "state.transition" ? "transition" : e.type === "alert" ? "alert" : e.type === "observation" ? "observation" : "step",
      agent: e.agentId,
      title: e.type === "entity.created" ? (e.data?.kind === "payout" ? `Payout scheduled · batch ${e.data?.batchId}` : "Refund received") : e.type === "alert" ? "Invariant alert" : e.type === "observation" ? "Observation" : `${e.from} → ${e.to}`,
      from: e.from,
      to: e.to,
      reason: e.reason,
      evidence:
        e.provenance && (e.provenance.query || e.provenance.rows?.length || e.provenance.response || e.evidence)
          ? { query: e.provenance.query, rows: e.provenance.rows, response: e.provenance.response, truth: e.evidence, note: e.provenance.note }
          : e.provenance?.note
            ? { note: e.provenance.note }
            : undefined,
    }));
    const ent = events.find((e) => e.type === "entity.created");
    const isPayout = ent?.data?.kind === "payout";
    for (const t of run.trace.filter((t) => t.ticket_id === ticketId || (isPayout && BATCH_ACTIONS.has(t.action) && batchLineMentions(t, ticketId)))) {
      if (isPayout && BATCH_ACTIONS.has(t.action)) {
        items.push({
          ts: t.ts,
          kind: t.action.includes("→") || t.action === "verify_batch" ? "handoff" : "step",
          agent: t.agent,
          title: t.action === "send_batch" ? `send batch ${t.input?.batch_id} (${t.input?.items?.length} payouts)` : t.action,
          reason: t.reason,
          evidence: { response: { input: t.input, output: t.output } },
        });
        continue;
      }
      if (HANDOFF.test(t.action)) {
        items.push({ ts: t.ts, kind: "handoff", agent: t.agent, title: t.action, reason: t.reason, evidence: { query: t.input?.query, rows: t.input?.rows, truth: t.output } });
      } else if (t.action === "recall_memory") {
        items.push({ ts: t.ts, kind: "memory", agent: t.agent, title: `H-MEM recall → wait ${t.output?.waitMs}ms`, reason: t.output?.source, evidence: { rows: t.output?.memories } });
      }
    }
    return items.sort((a, b) => a.ts.localeCompare(b.ts));
  }
  return run.trace
    .filter((t) => t.ticket_id === key || ((t.action === "send_batch" || t.action === "resend_batch") && batchLineMentions(t, key)))
    .map((t) => ({
      ts: t.ts,
      kind: "step" as const,
      agent: t.agent,
      title: t.action,
      reason: t.reason,
      evidence: t.output !== undefined || t.input !== undefined ? { response: { input: t.input, output: t.output } } : undefined,
    }));
}

export interface Lesson {
  id: string;
  content: string;
  confidence: number | null;
  origin: "loaded" | "learned";
  promoted: boolean;
  uses: Array<{ ts: string; actor: string; relevance: number }>;
}

export function lessonsOf(runId: string): Lesson[] {
  const dir = listRuns().find((r) => r.id === runId)?.dir ?? join(LOGS, runId);
  const ledger = readJsonl<any>(join(dir, "memory.jsonl"));
  const saved = readJson<Array<{ id: string; content: string; confidence: number }>>(join(ROOT, ".dumen", "memory", "long_term.json")) ?? [];
  const byId = new Map<string, Lesson>();
  const get = (id: string) => {
    let l = byId.get(id);
    if (!l) {
      l = { id, content: "", confidence: null, origin: "learned", promoted: false, uses: [] };
      byId.set(id, l);
    }
    return l;
  };
  for (const e of ledger) {
    const l = get(e.memoryId);
    if (e.action === "hydrate") {
      l.origin = "loaded";
      if (e.details?.content) {
        l.content = e.details.content;
        l.confidence = e.details.confidence ?? null;
      }
      const s = saved.find((m) => m.id === e.memoryId);
      if (s && !l.content) {
        l.content = s.content;
        l.confidence = s.confidence;
      }
    }
    if ((e.action === "create" || e.action === "update") && e.newState) {
      l.content = e.newState.content;
      l.confidence = e.newState.confidence;
    }
    if (e.action === "feedback" && e.newState) l.confidence = e.newState.confidence;
    if (e.action === "promote") l.promoted = true;
    if (e.action === "read") l.uses.push({ ts: e.ts, actor: e.actor, relevance: e.details?.relevance ?? 0 });
  }
  return [...byId.values()].filter((l) => l.content);
}
