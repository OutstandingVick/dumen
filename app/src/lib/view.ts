// Everything a page needs about the selected run, resolved the same way on every page.
import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO, LOGS, latestRunId, lessonsOf, listRuns, loadRun, pairFor, refundsOf, type Kind, type Refund, type Run, type RunInfo } from "./runs";

export interface SearchParams {
  run?: string;
  refund?: string;
  kind?: string;
}

const drill = (r: RunInfo) => !!(r.summary?.failures?.zetaris_down || r.summary?.failures?.nightshift_down);

// Open the trace where the contrast is sharpest: Dumen lost a confirmation, verified it
// (UNKNOWN → VERIFYING → CONFIRMED) without calling again, and the baseline paid it twice.
function pickDefault(refunds: Refund[], other: Refund[]): string | undefined {
  const twiceElsewhere = (r: Refund) => other.some((o) => o.ticketId === r.ticketId && o.paidTwice);
  const savedByVerify = (r: Refund) => r.verified && r.calls === 1 && r.state === "CONFIRMED";
  return (
    refunds.find((r) => savedByVerify(r) && twiceElsewhere(r)) ??
    refunds.find((r) => twiceElsewhere(r) && r.verified) ??
    refunds.find((r) => savedByVerify(r)) ??
    refunds.find((r) => twiceElsewhere(r) && r.calls > 0) ??
    refunds.find((r) => r.paidTwice) ??
    refunds.find((r) => r.retried) ??
    refunds[0]
  )?.key;
}

export function runLabel(r: RunInfo): string {
  const when = new Date(r.startedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  if (r.interactive) return `Interactive · ${r.summary?.requests?.length ?? 0} requests · ${when}`;
  const f = r.summary?.failures;
  const d = f?.zetaris_down ? " · ⚠ Zetaris down" : f?.nightshift_down ? " · ⚠ Nightshift down" : "";
  return `${r.demo ? "★ Demo · " : ""}${r.agent === "dumen" ? "Dumen" : "Baseline"} · seed ${r.seed} · lost ${r.summary?.rates.lost ?? "?"}${d}${r.summary?.intake === "live" ? " · live Nemotron" : ""} · ${when}`;
}

export interface ChartRow {
  seed: number;
  lost: number;
  baseline: number; // money paid beyond what was owed, refunds + payouts
  dumen: number;
}

// Bars for the overview chart: the newest comparison (local, else the committed demo).
function chartRows(run: Run, baseline: Run | null, dumen: Run | null): ChartRow[] {
  const lostOf = (r: Run | null) => (r ? r.summary.money_lost + (r.summary.payouts?.money_lost ?? 0) : 0);
  // Newest comparison with several rows (a one-seed comparison from the dashboard is too thin).
  const dirs = [LOGS, DEMO].filter(existsSync).flatMap((base) => readdirSync(base).filter((d) => d.startsWith("compare-")).map((d) => ({ d, base })));
  for (const { d: dir, base } of dirs.sort((a, b) => b.d.localeCompare(a.d))) {
    try {
      const c = JSON.parse(readFileSync(join(base, dir, "compare.json"), "utf8")) as {
        rows: Array<{ seed: string; lost: string; baseline: { money_lost: number; payouts?: { money_lost: number } }; dumen: { money_lost: number; payouts?: { money_lost: number } } }>;
      };
      if (c.rows.length > 1)
        return c.rows.map((r) => ({
          seed: Number(r.seed),
          lost: Number(r.lost),
          baseline: r.baseline.money_lost + (r.baseline.payouts?.money_lost ?? 0),
          dumen: r.dumen.money_lost + (r.dumen.payouts?.money_lost ?? 0),
        }));
    } catch {
      // ignore an unreadable compare file
    }
  }
  return baseline || dumen ? [{ seed: run.summary.seed, lost: run.summary.rates.lost, baseline: lostOf(baseline), dumen: lostOf(dumen) }] : [];
}

export function getView(sp: SearchParams) {
  const runs = listRuns();
  if (!runs.length) return null;
  // Open on the newest local run: it's the only one whose escalations can still be decided.
  // A fresh clone has no local runs, so it falls back to the committed demo's Dumen run.
  const defaultRun =
    runs.find((r) => !r.demo) ??
    runs.find((r) => r.agent === "dumen" && !drill(r) && !!r.summary?.payouts) ??
    runs.find((r) => r.agent === "dumen") ??
    runs[0];
  const run = loadRun(sp.run ?? defaultRun.id) ?? loadRun(defaultRun.id)!;
  // An interactive session has no baseline twin; the comparison cards then show the newest
  // chaos run that does.
  const compareInfo = run.info.interactive ? (runs.find((r) => !r.interactive && !drill(r) && !r.demo) ?? runs.find((r) => !r.interactive && !drill(r)) ?? run.info) : run.info;
  const pair = pairFor(compareInfo);
  const baseline = pair.baseline ? loadRun(pair.baseline.id) : null;
  const dumen = pair.dumen ? loadRun(pair.dumen.id) : null;
  const other = run.info.agent === "dumen" ? baseline : dumen;
  const kind: Kind = sp.kind === "payout" ? "payout" : "refund";
  const refunds = refundsOf(run, kind);
  const otherRefunds = other && !run.info.interactive ? refundsOf(other, kind) : [];
  const selectedKey = sp.refund && refunds.some((r) => r.key === sp.refund) ? sp.refund : pickDefault(refunds, otherRefunds);
  const selected = refunds.find((r) => r.key === selectedKey);
  return {
    runs,
    run,
    baseline,
    dumen,
    other: run.info.interactive ? null : other,
    kind,
    refunds,
    otherRefunds,
    selectedKey,
    selected,
    counterpart: selected ? otherRefunds.find((r) => r.ticketId === selected.ticketId) : undefined,
    lessons: run.info.agent === "dumen" ? lessonsOf(run.info.id) : [],
    latest: latestRunId(),
    openCases: run.escalations.filter((c) => !c.decision),
    chart: chartRows(run, baseline, dumen),
    // keep the selection when moving between pages
    qs: (extra: Record<string, string> = {}) => "?" + new URLSearchParams({ run: run.info.id, kind, ...extra }).toString(),
  };
}

export type View = NonNullable<ReturnType<typeof getView>>;

export const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
