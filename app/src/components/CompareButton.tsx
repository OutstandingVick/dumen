"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  log: string;
}

interface Progress {
  agent: "baseline" | "dumen";
  tickets: number;
  ticketsTotal: number;
  payoutsPhase: boolean;
  step: string | null;
}

// Starts baseline vs Dumen on one seed (scripts/compare.ts), shows where it is, then opens
// the new Dumen run. Cached replays saved Nemotron intake decisions (fast, reproducible);
// Live has Dumen decide on live Nemotron.
const MODE_KEY = "dumen.compare.mode"; // "live" | "cached", remembered per browser

export function CompareButton({ defaultSeed, defaultLost, defaultLive = false }: { defaultSeed: number; defaultLost: number; defaultLive?: boolean }) {
  const router = useRouter();
  const [seed, setSeed] = useState(String(defaultSeed));
  const [lost, setLost] = useState(String(defaultLost));
  // Server default (DEMO_DEFAULT_LIVE) first; a choice made in this browser wins after that.
  const [live, setLiveState] = useState(defaultLive);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY);
      if (saved === "live" || saved === "cached") setLiveState(saved === "live");
    } catch {
      // storage blocked (private mode): keep the default
    }
  }, []);
  const setLive = (v: boolean) => {
    setLiveState(v);
    try {
      localStorage.setItem(MODE_KEY, v ? "live" : "cached");
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  };
  const [job, setJob] = useState<Job | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      const body = await res.json();
      setJob(body.job);
      setProgress(body.progress ?? null);
      if (body.job.status !== "running") {
        clearInterval(t);
        if (body.job.status === "done") router.push("/");
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [job, router]);

  async function start() {
    setError(null);
    setProgress(null);
    const res = await fetch("/api/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seed: Number(seed), lost: Number(lost), live }) });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error);
      if (body.job) setJob(body.job);
      return;
    }
    setJob(body.job);
  }

  const running = job?.status === "running";
  // Two runs (baseline, then Dumen), each: refund tickets, then payouts.
  const pct = progress
    ? Math.min(99, Math.round(((progress.agent === "dumen" ? 50 : 0) + (progress.payoutsPhase ? 40 : (progress.tickets / progress.ticketsTotal) * 40) + (progress.payoutsPhase ? 5 : 0)) ))
    : 2;
  return (
    <div className="compare">
      <div className="row">
        <label className="hint">
          seed <input style={{ width: 64 }} value={seed} onChange={(e) => setSeed(e.target.value)} disabled={running} />
        </label>
        <label className="hint">
          lost rate <input style={{ width: 56 }} value={lost} onChange={(e) => setLost(e.target.value)} disabled={running} />
        </label>
        <div className="switch small" role="tablist" aria-label="Intake mode">
          <button className={!live ? "on" : ""} onClick={() => setLive(false)} disabled={running} role="tab" aria-selected={!live} title="Replay saved Nemotron decisions: fast and reproducible">
            Cached
          </button>
          <button className={live ? "on" : ""} onClick={() => setLive(true)} disabled={running} role="tab" aria-selected={live} title="Dumen decides on live Nemotron: slower">
            Live (Nemotron)
          </button>
        </div>
        <button className="cta" onClick={start} disabled={running}>
          <span className="sq">
            <Icon name="activity" size={20} />
          </span>
          <span className="txt">{running ? "Running…" : "Run comparison"}</span>
        </button>
        {job?.status === "failed" && <span className="hint" style={{ color: "var(--cherry)" }}>comparison failed: {job.log.trim().split("\n").slice(-2).join(" ")}</span>}
        {error && !running && <span className="hint" style={{ color: "var(--cherry)" }}>{error}</span>}
      </div>
      {running && (
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="bar">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="hint">
            {progress
              ? `${progress.agent === "dumen" ? "2/2 Dumen" : "1/2 baseline"} · ${progress.payoutsPhase ? "payouts" : `ticket ${Math.max(1, progress.tickets)}/${progress.ticketsTotal}`}${progress.step ? ` · ${progress.step}` : ""}`
              : "resetting the databases…"}
          </div>
        </div>
      )}
    </div>
  );
}
