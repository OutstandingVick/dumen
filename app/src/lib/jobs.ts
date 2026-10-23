// Background jobs the dashboard starts: the repo's own scripts, run as child processes.
// Job state lives in logs/jobs/<id>.json so it survives dev-server reloads.
import "server-only";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGS, ROOT } from "./runs";

const JOBS = join(LOGS, "jobs");
const MAX_MS = 15 * 60_000;

export interface Job {
  id: string;
  kind: "compare";
  args: Record<string, string>;
  status: "running" | "done" | "failed";
  log: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
}

function save(job: Job) {
  mkdirSync(JOBS, { recursive: true });
  writeFileSync(join(JOBS, `${job.id}.json`), JSON.stringify(job, null, 2));
}

export function getJob(id: string): Job | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const p = join(JOBS, `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Job) : null;
}

export function runningJob(): Job | null {
  if (!existsSync(JOBS)) return null;
  for (const f of readdirSync(JOBS)) {
    const j = getJob(f.replace(/\.json$/, ""));
    // A job left "running" past the time limit died with an earlier server; treat it as gone.
    if (j?.status === "running" && Date.now() - Date.parse(j.startedAt) < MAX_MS) return j;
  }
  return null;
}

export function startCompare(seed: number, lost: number): Job {
  const id = `compare-${Date.now()}`;
  const job: Job = { id, kind: "compare", args: { seed: String(seed), lost: String(lost) }, status: "running", log: "", startedAt: new Date().toISOString() };
  save(job);
  const p = spawn("npx", ["tsx", "scripts/compare.ts", "--seeds", String(seed), "--lost", String(lost), "--no-control"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const append = (d: Buffer) => {
    job.log += d.toString();
    save(job);
  };
  p.stdout.on("data", append);
  p.stderr.on("data", append);
  const timer = setTimeout(() => p.kill("SIGTERM"), MAX_MS);
  p.on("close", (code) => {
    clearTimeout(timer);
    job.status = code === 0 ? "done" : "failed";
    job.exitCode = code;
    job.finishedAt = new Date().toISOString();
    save(job);
  });
  return job;
}

export function runDecide(run: string, entity: string, verdict: "approve" | "reject", reason: string): Promise<{ ok: boolean; state: string | null; reason: string }> {
  return new Promise((resolve) => {
    const p = spawn("npx", ["tsx", "scripts/decide.ts", "--run", run, "--entity", entity, `--${verdict}`, "--reason", reason], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), 3 * 60_000);
    p.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
      try {
        resolve(JSON.parse(line ?? ""));
      } catch {
        resolve({ ok: false, state: null, reason: (err || out).trim().split("\n").slice(-3).join(" ") || "decision script failed" });
      }
    });
  });
}
