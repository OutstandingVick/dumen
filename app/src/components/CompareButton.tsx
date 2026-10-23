"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  log: string;
}

// Starts baseline vs Dumen on one seed (scripts/compare.ts), shows progress, then opens
// the new Dumen run.
export function CompareButton({ defaultSeed, defaultLost }: { defaultSeed: number; defaultLost: number }) {
  const router = useRouter();
  const [seed, setSeed] = useState(String(defaultSeed));
  const [lost, setLost] = useState(String(defaultLost));
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      const { job: next } = await res.json();
      setJob(next);
      if (next.status !== "running") {
        clearInterval(t);
        if (next.status === "done") router.push("/");
        router.refresh();
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job, router]);

  async function start() {
    setError(null);
    const res = await fetch("/api/compare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seed: Number(seed), lost: Number(lost) }) });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error);
      if (body.job) setJob(body.job);
      return;
    }
    setJob(body.job);
  }

  const running = job?.status === "running";
  const progress = job?.log.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return (
    <div className="row">
      <label className="hint">
        seed <input style={{ width: 64 }} value={seed} onChange={(e) => setSeed(e.target.value)} disabled={running} />
      </label>
      <label className="hint">
        lost rate <input style={{ width: 56 }} value={lost} onChange={(e) => setLost(e.target.value)} disabled={running} />
      </label>
      <button className="primary" onClick={start} disabled={running}>
        {running ? "Running comparison…" : "Run comparison"}
      </button>
      {running && <span className="hint">{progress.includes("dumen") ? "Dumen running (≈20s)…" : progress.includes("baseline") ? "baseline running (≈20s)…" : "starting…"}</span>}
      {job?.status === "failed" && <span className="hint" style={{ color: "var(--bad)" }}>comparison failed: {job.log.trim().split("\n").slice(-2).join(" ")}</span>}
      {error && !running && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}
