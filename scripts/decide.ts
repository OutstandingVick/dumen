// A person's decision on an escalated refund, written through the World Model.
//   npx tsx scripts/decide.ts --run <runId> --entity <entityId> --approve --reason "..."
//   npx tsx scripts/decide.ts --run <runId> --entity <entityId> --reject  --reason "..."
// Works for refunds and payouts. Reject ends the action. Approve goes back through the Verifier
// (refund_truth / payout_truth, and never more than is owed) and only then the Executor —
// never a payment without that check.
// Only the newest run can be decided: every chaos run resets the databases.
// Prints one JSON line: { ok, state, reason }.
import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { executeUntilSettled } from "../agents/dumen.js";
import type { EscalationCase } from "../agents/escalation.js";
import { verifyHumanApproval } from "../agents/verifier.js";
import { openMemory } from "../runtime/memory/index.js";
import { Trace } from "../runtime/trace.js";
import { HUMAN_AGENT, openWorld } from "../runtime/world/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    run: { type: "string" },
    entity: { type: "string" },
    approve: { type: "boolean", default: false },
    reject: { type: "boolean", default: false },
    reason: { type: "string" },
    port: { type: "string", default: "4012" },
  },
});

function finish(ok: boolean, state: string | null, reason: string): never {
  console.log(JSON.stringify({ ok, state, reason }));
  process.exit(ok ? 0 : 1);
}

if (!args.run || !args.entity || args.approve === args.reject || !args.reason?.trim()) {
  finish(false, null, "need --run, --entity, exactly one of --approve/--reject, and --reason");
}
const runs = readdirSync(join(ROOT, "logs")).filter((d) => /_(baseline|dumen)_(seed\d+|interactive)$/.test(d)).sort();
if (runs.at(-1) !== args.run) finish(false, null, "only the newest run can be decided: a later run has reset the databases");
if (!existsSync(join(ROOT, "logs", args.run!, "world.jsonl"))) finish(false, null, "run has no world model (baseline runs have no escalations)");

const world = openWorld(args.run!);
const entity = world.store.entity(args.entity!);
if (!entity) finish(false, null, "unknown refund");
if (entity!.state !== "ESCALATED") finish(false, entity!.state, `refund is ${entity!.state}, not ESCALATED`);

const trace = new Trace(args.run!);
const reason = args.reason!.trim();
const human = { agentId: HUMAN_AGENT, taskId: entity!.ticketId };
const queuePath = join(ROOT, "logs", args.run!, "escalations.json");

function recordDecision(outcome: string) {
  const queue: EscalationCase[] & { decision?: unknown }[] = existsSync(queuePath) ? JSON.parse(readFileSync(queuePath, "utf8")) : [];
  const item = queue.find((c) => c.refund_key === entity!.refundKey) as any;
  if (item) {
    item.decision = { verdict: args.approve ? "approve" : "reject", reason, at: new Date().toISOString(), outcome };
    writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
  }
}

if (args.reject) {
  await world.ingest.transition(entity!.id, "REJECTED", human, { provenance: { source: "policy", note: "human decision" }, reason });
  trace.write({ agent: HUMAN_AGENT, ticket_id: entity!.ticketId, action: "human→world: reject", input: { refund_key: entity!.refundKey }, output: { state: "REJECTED" }, reason });
  recordDecision("REJECTED");
  finish(true, "REJECTED", reason);
}

// Approve: a healthy processor stands in for the real one while the decision executes.
trace.write({ agent: HUMAN_AGENT, ticket_id: entity!.ticketId, action: "human→verifier: approve", input: { refund_key: entity!.refundKey }, reason });
const processor = spawn("npx", ["tsx", "processor/server.ts", "--port", args.port!, "--seed", "1", "--mode", "naive"], { cwd: ROOT, stdio: "ignore" });
const stop = () => processor.exitCode === null && processor.kill("SIGTERM");
process.on("exit", stop);
const processorUrl = `http://127.0.0.1:${args.port}`;
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`${processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}

const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 2 });
const memory = openMemory({ runId: args.run!, fresh: true });
const deps = {
  world,
  memory,
  trace,
  ordersDb,
  processorUrl,
  callTimeoutMs: 3000,
  verifier: { defaultWaitMs: 2000, maxWaitMs: 8000, pollMs: 300 },
  modelSummaries: false,
};
try {
  // An approval can never pay more than is owed: for refunds that's the order amount
  // (payouts read the seller's earned balance from payout_truth).
  let owed: number | undefined;
  if (entity!.kind === "refund") {
    const { rows } = await ordersDb.query("SELECT amount::float AS amount FROM orders WHERE order_id = $1", [entity!.orderId]);
    owed = rows[0]?.amount;
  }
  const v = await verifyHumanApproval(entity!.id, reason, { world, memory, trace, ...deps.verifier }, owed);
  let state: string = v.decision;
  if (v.decision === "RETRY_SAME_KEY") state = await executeUntilSettled(entity!.id, "approved by a person", deps);
  recordDecision(state);
  finish(true, state, v.reason);
} finally {
  stop();
  await ordersDb.end();
}
