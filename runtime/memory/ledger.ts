// TrustLedgerService: append-only audit of every memory action → logs/<runId>/memory.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEntry } from "./types.js";

export class TrustLedgerService {
  readonly path: string;

  constructor(readonly runId: string, logsDir: string) {
    const dir = join(logsDir, runId);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "memory.jsonl");
  }

  record(entry: Omit<LedgerEntry, "ts" | "runId">) {
    appendFileSync(this.path, JSON.stringify({ ts: new Date().toISOString(), runId: this.runId, ...entry }) + "\n");
  }
}
