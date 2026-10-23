// Append-only JSONL trace: logs/<runId>/trace.jsonl, one line per agent step.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface TraceEvent {
  agent: string;
  ticket_id: string;
  action: string;
  input?: unknown;
  output?: unknown;
  reason?: string;
}

const LOGS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "logs");

export class Trace {
  readonly path: string;

  constructor(readonly runId: string) {
    const dir = join(LOGS_DIR, runId);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "trace.jsonl");
  }

  write(e: TraceEvent) {
    appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");
  }
}
