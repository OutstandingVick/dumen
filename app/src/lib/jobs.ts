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
  kind: "compare" | "request";
  args: Record<string, string>;
  run?: string; // request: the interactive run it lands in
  entity?: string; // request: the World Model action id
  result?: Record<string, unknown>; // request: the runner's @@DONE payload
  status: "running" | "done" | "failed";
  log: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  final?: boolean; // request: checked against Zetaris after the result was shown
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

// Run a repo script as a job; `onLine` sees each stdout line (to pick up markers).
function runJob(job: Job, script: string, argv: string[], onLine?: (line: string) => void): Job {
  save(job);
  const p = spawn("npx", ["tsx", script, ...argv], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let pending = "";
  const append = (d: Buffer) => {
    job.log += d.toString();
    if (onLine) {
      pending += d.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(onLine);
    }
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

export function startCompare(seed: number, lost: number, live: boolean): Job {
  const job: Job = { id: `compare-${Date.now()}`, kind: "compare", args: { seed: String(seed), lost: String(lost), mode: live ? "live" : "cached" }, status: "running", log: "", startedAt: new Date().toISOString() };
  return runJob(job, "scripts/compare.ts", ["--seeds", String(seed), "--lost", String(lost), "--no-control", ...(live ? ["--live"] : [])]);
}

export interface RequestParams {
  kind: "refund" | "payout";
  order?: string;
  message?: string;
  seller?: string;
  amount?: number;
  chaos: string;
  zetarisDown: boolean;
  nightshiftDown: boolean;
}

// One request through the real Dumen loop, sent to the warm request worker
// (scripts/request-worker.ts), which streams @@RUN / @@ENTITY / @@RESULT / @@DONE lines. The job
// is "done" at @@RESULT, as soon as Dumen has decided; `final` is set once the result has been
// checked against Zetaris (@@DONE).
const WORKER = "http://127.0.0.1:4019";
const g = globalThis as { dumenWorker?: Promise<void> };

async function workerUp(): Promise<boolean> {
  try {
    return (await fetch(`${WORKER}/health`, { signal: AbortSignal.timeout(500) })).ok;
  } catch {
    return false;
  }
}

// Started once per dashboard server and kept running; a crashed worker is started again.
function ensureWorker(): Promise<void> {
  g.dumenWorker ??= (async () => {
    if (await workerUp()) return;
    const p = spawn("npx", ["tsx", "scripts/request-worker.ts"], { cwd: ROOT, stdio: "ignore" });
    p.on("exit", () => (g.dumenWorker = undefined));
    for (let i = 0; i < 150; i++) {
      if (await workerUp()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("request worker did not start within 30s");
  })().catch((e) => {
    g.dumenWorker = undefined;
    throw e;
  });
  return g.dumenWorker;
}

export function startRequest(r: RequestParams): Job {
  const job: Job = {
    id: `request-${Date.now()}`,
    kind: "request",
    args: { kind: r.kind, subject: r.kind === "refund" ? r.order! : r.seller!, chaos: r.chaos, zetarisDown: String(r.zetarisDown), nightshiftDown: String(r.nightshiftDown) },
    status: "running",
    log: "",
    startedAt: new Date().toISOString(),
  };
  save(job);
  const finish = (status: Job["status"]) => {
    job.final = true;
    if (job.status === "running") job.status = status;
    job.finishedAt ??= new Date().toISOString();
    save(job);
  };
  const onLine = (line: string) => {
    job.log += line + "\n";
    if (line.startsWith("@@RUN ")) job.run = line.slice(6).trim();
    else if (line.startsWith("@@ENTITY ")) job.entity = line.slice(9).trim();
    else if (line.startsWith("@@RESULT ") || line.startsWith("@@DONE ")) {
      try {
        job.result = JSON.parse(line.slice(line.indexOf(" ") + 1));
      } catch {
        // keep the raw log
      }
      if (line.startsWith("@@RESULT ")) {
        job.status = "done";
        job.finishedAt = new Date().toISOString();
      } else finish(job.result?.ok === false ? "failed" : "done");
    }
    save(job);
  };
  (async () => {
    await ensureWorker();
    const res = await fetch(`${WORKER}/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(r), signal: AbortSignal.timeout(MAX_MS) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(onLine);
    }
    if (pending) onLine(pending);
    if (!job.final) finish("failed");
  })().catch((e) => {
    job.log += `request worker: ${e.message}\n`;
    finish("failed");
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
