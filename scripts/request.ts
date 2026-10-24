// One request through the real Dumen loop, for the dashboard's "New request" panel.
//   npx tsx scripts/request.ts --kind refund --order ORD-1028 --message "Arrived broken" [--chaos lost_response]
//   npx tsx scripts/request.ts --kind payout --seller S-02 --amount 120 [--chaos down] [--zetaris-down] [--nightshift-down]
// Same agents, same safety rules, same World Model as a chaos run. Requests are appended to an
// "interactive" run in logs/ (a new one starts after any chaos run, since chaos runs reset the
// databases). --chaos forces the processor's next call; the call after it behaves normally.
// Prints @@RUN <runId>, @@ENTITY <entityId> once known, and @@DONE <json> at the end.
import "dotenv/config";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, "logs");
const DEAD_URL = "http://127.0.0.1:59999";
const { values: args } = parseArgs({
  options: {
    kind: { type: "string" },
    order: { type: "string" },
    message: { type: "string" },
    seller: { type: "string" },
    amount: { type: "string" },
    chaos: { type: "string", default: "ok" },
    "zetaris-down": { type: "boolean", default: false },
    "nightshift-down": { type: "boolean", default: false },
    sample: { type: "boolean", default: false }, // sample-mode intake (checks); default is live Nemotron
    "new-run": { type: "boolean", default: false }, // always start a fresh interactive run
    port: { type: "string", default: "4015" },
  },
});

function done(ok: boolean, payload: Record<string, unknown>): never {
  console.log(`@@DONE ${JSON.stringify({ ok, ...payload })}`);
  process.exit(ok ? 0 : 1);
}

const CHAOS = ["ok", "lost_response", "real_fail", "slow_confirm", "down"];
if (args.kind !== "refund" && args.kind !== "payout") done(false, { reason: "--kind must be refund or payout" });
if (!CHAOS.includes(args.chaos!)) done(false, { reason: `--chaos must be one of ${CHAOS.join(", ")}` });
if (args.kind === "refund" && (!/^ORD-\d{4}$/.test(args.order ?? "") || !(args.message ?? "").trim())) done(false, { reason: "refund needs --order ORD-#### and --message" });
const amount = Number(args.amount);
if (args.kind === "payout" && (!/^S-\d{2}$/.test(args.seller ?? "") || !(amount > 0) || amount > 1_000_000)) done(false, { reason: "payout needs --seller S-## and a positive --amount" });

// Model mode before any module reads it: live Nemotron unless --sample; a Nightshift drill
// points the live client at a closed port.
process.env.SAMPLE_MODE = args.sample && !args["nightshift-down"] ? "true" : "false";
if (args["nightshift-down"]) {
  process.env.NIGHTSHIFT_BASE_URL = `${DEAD_URL}/v1`;
  process.env.NIGHTSHIFT_API_KEY ||= "simulated-outage";
  process.env.NIGHTSHIFT_MODEL ||= "simulated-outage";
}

const { runDumen } = await import("../agents/dumen.js");
const { runPayoutBatch } = await import("../agents/payouts.js");
const { openMemory, PROMOTION_POLICY } = await import("../runtime/memory/index.js");
const { Trace } = await import("../runtime/trace.js");
const { openWorld } = await import("../runtime/world/index.js");
const { getPayoutTruth, getRefundTruth } = await import("../runtime/zetaris.js");

// Reuse the newest run if it's interactive; otherwise the databases were just reset by a chaos
// run, so start a fresh interactive run.
const runs = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => /_(baseline|dumen)_(seed\d+|interactive)$/.test(d)).sort() : [];
const runId = runs.at(-1)?.endsWith("_dumen_interactive") && !args["new-run"] ? runs.at(-1)! : `${new Date().toISOString().replace(/[:.]/g, "-")}_dumen_interactive`;
console.log(`@@RUN ${runId}`);

const world = openWorld(runId);
const memory = openMemory({ runId });
const trace = new Trace(runId);
const runDir = dirname(trace.path);
const summaryPath = join(runDir, "summary.json");
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 2 });

const port = Number(args.port);
const processorUrl = `http://127.0.0.1:${port}`;
const processor = spawn("npx", ["tsx", "processor/server.ts", "--port", String(port), "--first", args.chaos!, "--mode", "naive", "--hang-ms", "5000", "--slow-ms", "1500"], { cwd: ROOT, stdio: "ignore" });
const stopProcessor = () => processor.exitCode === null && processor.kill("SIGTERM");
process.on("exit", stopProcessor);

const realZetaris = process.env.ZETARIS_URL;
const deps = {
  world,
  memory,
  trace,
  ordersDb,
  processorUrl,
  callTimeoutMs: 3000,
  verifier: { defaultWaitMs: 2000, maxWaitMs: 8000, pollMs: 300 },
  modelSummaries: process.env.SAMPLE_MODE !== "true",
};

interface RequestRecord {
  at: string;
  kind: "refund" | "payout";
  id: string; // ticket id or payout key
  subject: string; // order or seller
  entity: string;
  state: string;
  executions: number;
  chaos: string;
  zetaris_down: boolean;
  nightshift_down: boolean;
  success_count: number | null; // from refund_truth / payout_truth after the request
  paid_amount: number | null;
}

try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const prior: { requests?: RequestRecord[] } = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
  const requests = prior.requests ?? [];
  const n = requests.length + 1;

  if (args["zetaris-down"]) process.env.ZETARIS_URL = DEAD_URL;
  let record: RequestRecord;

  if (args.kind === "refund") {
    const { rows } = await ordersDb.query("SELECT amount::float AS amount, currency FROM orders WHERE order_id = $1", [args.order]);
    if (!rows[0]) done(false, { reason: `no order ${args.order}` });
    const ticket = { ticket_id: `R-${String(n).padStart(3, "0")}`, order_id: args.order!, message: args.message!.trim().slice(0, 500), amount_requested: rows[0].amount, currency: rows[0].currency };
    const { entity } = await world.ingest.receive(ticket, { agentId: "dumen", taskId: ticket.ticket_id });
    console.log(`@@ENTITY ${entity.id}`);
    const r = await runDumen(ticket, deps);
    record = { at: new Date().toISOString(), kind: "refund", id: ticket.ticket_id, subject: ticket.order_id, entity: entity.id, state: r.state, executions: r.executions, chaos: args.chaos!, zetaris_down: args["zetaris-down"], nightshift_down: args["nightshift-down"], success_count: null, paid_amount: null };
  } else {
    const { rows } = await ordersDb.query("SELECT seller_id FROM sellers WHERE seller_id = $1", [args.seller]);
    if (!rows[0]) done(false, { reason: `no seller ${args.seller}` });
    const payout = { payout_key: `PO-R${String(n).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}`, seller_id: args.seller!, amount, batch_id: `B-REQ-${String(n).padStart(3, "0")}` };
    // Source A gets the scheduled payout first, exactly like a batch from the marketplace.
    await ordersDb.query("INSERT INTO payouts VALUES ($1, $2, $3, $4, 'pending')", [payout.payout_key, payout.seller_id, payout.amount, payout.batch_id]);
    const { entity } = await world.ingest.receivePayout(payout, { agentId: "payouts", taskId: payout.payout_key });
    console.log(`@@ENTITY ${entity.id}`);
    const [r] = await runPayoutBatch(payout.batch_id, [payout], deps);
    record = { at: new Date().toISOString(), kind: "payout", id: payout.payout_key, subject: payout.seller_id, entity: entity.id, state: r.state, executions: r.executions, chaos: args.chaos!, zetaris_down: args["zetaris-down"], nightshift_down: args["nightshift-down"], success_count: null, paid_amount: null };
  }

  // Score it against the system of record (Zetaris back up if it was drilled down).
  await new Promise((r) => setTimeout(r, 1700)); // a slow_confirm lands ~1.5s later
  process.env.ZETARIS_URL = realZetaris;
  const key = world.store.entity(record.entity)!.refundKey;
  try {
    const t = record.kind === "refund" ? await getRefundTruth(key) : await getPayoutTruth(key);
    record.success_count = t?.success_count ?? 0;
    record.paid_amount = t?.paid_amount ?? 0;
  } catch {
    // Zetaris really unreachable: leave null rather than guess
  }
  requests.push(record);

  memory.store.promote(PROMOTION_POLICY, "policy:auto");
  memory.store.persist();

  // A summary the dashboard can read like any run's; every number comes from the requests list.
  const refunds = requests.filter((r) => r.kind === "refund");
  const payouts = requests.filter((r) => r.kind === "payout");
  const count = (list: RequestRecord[]) => list.reduce<Record<string, number>>((o, r) => ((o[r.state] = (o[r.state] ?? 0) + 1), o), {});
  const escalations = existsSync(join(runDir, "escalations.json")) ? (JSON.parse(readFileSync(join(runDir, "escalations.json"), "utf8")) as Array<{ kind?: string }>) : [];
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        run_id: runId,
        agent: "dumen",
        seed: 0,
        interactive: true,
        rates: { lost: 0, slow: 0, fail: 0, down: 0 },
        intake: process.env.SAMPLE_MODE === "true" ? "sample" : "live",
        tickets_processed: refunds.length,
        outcomes: count(refunds),
        processor_calls: refunds.reduce((s, r) => s + r.executions, 0),
        total_refunded: refunds.reduce((s, r) => s + (r.paid_amount ?? 0), 0),
        double_refunds: refunds.filter((r) => (r.success_count ?? 0) > 1).length,
        money_lost: 0,
        escalations: escalations.filter((c) => (c.kind ?? "refund") === "refund").length,
        rejections: count(refunds).REJECTED ?? 0,
        doubles: [],
        payouts: {
          batches: payouts.length,
          payouts: payouts.length,
          outcomes: count(payouts),
          bank_calls: payouts.reduce((s, r) => s + r.executions, 0),
          total_paid: payouts.reduce((s, r) => s + (r.paid_amount ?? 0), 0),
          duplicate_payouts: payouts.filter((r) => (r.success_count ?? 0) > 1).length,
          money_lost: 0,
          overpaid: [],
          changed_account_paid: [],
          high_value_paid: [],
          escalations: escalations.filter((c) => c.kind === "payout").length,
          rejections: count(payouts).REJECTED ?? 0,
          duplicates: payouts.filter((r) => (r.success_count ?? 0) > 1).map((r) => ({ payout_key: r.id, payments: r.success_count, paid: r.paid_amount })),
        },
        requests,
      },
      null,
      2,
    ) + "\n",
  );
  done(true, { run: runId, ...record });
} catch (e: any) {
  done(false, { run: runId, reason: e.message });
} finally {
  stopProcessor();
  await ordersDb.end();
}
