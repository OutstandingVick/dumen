// Exercises H-MEM across three simulated runs: learn → persist → hydrate → retrieve →
// act differently. Uses a scratch long-term file, never the real one. npm run memory:check
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openMemory, PROMOTION_POLICY, waitWindowFrom } from "../runtime/memory/index.js";

const stamp = Date.now();
const scratch = join(process.cwd(), "logs", `memory-check-${stamp}`);
const longTermPath = join(scratch, "long_term.json");
const DEFAULT_WAIT = 500;
const CAP = 10_000;
const verifierQuery = {
  text: "refund call timed out; how long to wait before deciding the processor did not pay",
  tags: ["wait-window", "verification", "timeout"],
  entities: ["processor", "refund_truth"],
  agentId: "verifier",
};

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// Run 1: cold start, learns from two slow confirmations and one lost response.
{
  const mem = openMemory({ runId: `mc-run1-${stamp}`, longTermPath, logsDir: scratch });
  check("run 1 starts cold", mem.hydrated === 0);
  const before = waitWindowFrom(mem.retrieval.retrieve(verifierQuery), DEFAULT_WAIT, CAP);
  check("run 1 uses the default wait window", before.waitMs === DEFAULT_WAIT, before.source);

  mem.mining.mineVerification({ agentId: "verifier", taskId: "T-001", refundKey: "rf_a", orderId: "ORD-1", executorResult: "accepted", verdict: "paid", settleMs: 1400 });
  mem.mining.mineVerification({ agentId: "verifier", taskId: "T-002", refundKey: "rf_b", orderId: "ORD-2", executorResult: "timeout", verdict: "paid", settleMs: 1700 });
  const sizeBefore = mem.store.all().length;
  mem.mining.mineVerification({ agentId: "verifier", taskId: "T-002", refundKey: "rf_b", orderId: "ORD-2", executorResult: "timeout", verdict: "paid", settleMs: 1700 });
  check("same lesson re-mined updates one record, not a new one", mem.store.all().length === sizeBefore);

  const ctx = mem.retrieval.retrieve(verifierQuery);
  const lesson = ctx.memories.find((m) => m.data.kind === "settle_delay");
  check("settle-delay lesson retrieved above threshold", !!lesson && lesson.relevance >= ctx.trace.threshold, `relevance ${lesson?.relevance}`);
  check("payload has trace metadata", ctx.trace.selected === ctx.memories.length && ctx.trace.retrievalReason.length > 0);
  const during = waitWindowFrom(ctx, DEFAULT_WAIT, CAP);
  check("wait window learned within the run", during.waitMs === 2600, `${during.waitMs}ms from ${during.source}`);

  const promoted = mem.store.promote(PROMOTION_POLICY, "policy:auto");
  check("policy promotes lessons seen ≥2 times", promoted.length === 2 && promoted.every((m) => m.layer === "long_term"), promoted.map((m) => m.data.kind).join(", "));
  check("long-term persisted; short-term not", mem.store.persist() === 2 && existsSync(longTermPath));
}

// Run 2: warm start — retrieves the lesson before seeing any timeout.
{
  const mem = openMemory({ runId: `mc-run2-${stamp}`, longTermPath, logsDir: scratch });
  check("run 2 hydrates long-term memory", mem.hydrated === 2);
  const ctx = mem.retrieval.retrieve(verifierQuery);
  const w = waitWindowFrom(ctx, DEFAULT_WAIT, CAP);
  check("run 2 waits the learned window from its first ticket", w.waitMs === 2600 && w.source.includes("long_term"), w.source);
  const lostLesson = ctx.memories.find((m) => m.data.kind === "paid_despite_timeout");
  check("run 2 also recalls 'a timeout is not a failure'", !!lostLesson);

  // Outcome feedback: the lesson was right, a slower confirmation extends it.
  mem.store.feedback(lostLesson!.id, "helpful", "verifier");
  mem.mining.mineVerification({ agentId: "verifier", taskId: "T-003", refundKey: "rf_c", orderId: "ORD-3", executorResult: "timeout", verdict: "paid", settleMs: 3000 });
  mem.store.persist();
}

// Run 3: picks up the widened window from run 2.
{
  const mem = openMemory({ runId: `mc-run3-${stamp}`, longTermPath, logsDir: scratch });
  const w = waitWindowFrom(mem.retrieval.retrieve(verifierQuery), DEFAULT_WAIT, CAP);
  check("run 3 uses the window widened in run 2", w.waitMs === 4500, `${w.waitMs}ms`);
  const unrelated = mem.retrieval.retrieve({ text: "what colour is the sky", agentId: "intake" });
  check("unrelated query retrieves nothing", unrelated.memories.length === 0, `${unrelated.trace.considered} considered`);
}

// Ledger: every action audited as JSONL
const run1Ledger = readFileSync(join(scratch, `mc-run1-${stamp}`, "memory.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const actions = new Set(run1Ledger.map((e) => e.action));
check("ledger records create/update/read/promote", ["create", "update", "read", "promote"].every((a) => actions.has(a)), [...actions].join(","));

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(scratch, { recursive: true }); // scratch runs: remove their own folder
process.exit(fail ? 1 : 0);
