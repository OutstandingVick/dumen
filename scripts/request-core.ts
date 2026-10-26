// One New-request through the real Dumen loop: the dashboard's request worker calls this for
// each request (warm processes, one Zetaris login), and scripts/request.ts calls it once.
// Same agents, same safety rules, same World Model as a chaos run. Requests are appended to an
// "interactive" run in logs/ (a new one starts after any chaos run, since chaos runs reset the
// databases). The chaos choice applies to the processor's next call only.
// emit() lines: @@RUN <runId>, @@ENTITY <entityId>, @@RESULT <json> as soon as Dumen has decided,
// then @@DONE <json> once the result is checked against Zetaris.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { runDumen } from "../agents/dumen.js";
import { fillSummaries, takePendingSummaries } from "../agents/escalation.js";
import { runPayoutBatch } from "../agents/payouts.js";
import { openMemory, PROMOTION_POLICY } from "../runtime/memory/index.js";
import { Trace } from "../runtime/trace.js";
import { openWorld } from "../runtime/world/index.js";
import { getPayoutTruth, getRefundTruth } from "../runtime/zetaris.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOGS = join(ROOT, "logs");
export const DEAD_URL = "http://127.0.0.1:59999"; // a closed port: real ECONNREFUSED
export const CHAOS = ["ok", "lost_response", "real_fail", "slow_confirm", "down"];

export interface RequestParams {
  kind: "refund" | "payout";
  order?: string;
  message?: string;
  seller?: string;
  amount?: number;
  chaos: string;
  zetarisDown: boolean;
  nightshiftDown: boolean;
  sample: boolean; // sample-mode intake (checks); default is live Nemotron
  newRun: boolean; // always start a fresh interactive run
}

export interface RequestContext {
  ordersDb: pg.Pool;
  processorUrl: string;
  setChaos: (behaviour: string) => Promise<void>; // the processor's next call
}

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

// The amount a customer asks for in their own words ("refund me 382.16"), if they name one;
// otherwise they're asking for the order. Intake's over-ask guard compares it with what's owed.
export function askedAmount(message: string): number | null {
  const m = message.match(/(?:refund(?: me)?|send(?: me)?|pay(?: me)?)\D{0,12}?(\d+(?:[.,]\d{1,2})?)/i) ?? message.match(/(\d+[.,]\d{2})\b/);
  const n = m ? Number(m[1].replace(",", ".")) : NaN;
  return n > 0 ? n : null;
}

export function validate(p: Partial<RequestParams>): string | null {
  if (p.kind !== "refund" && p.kind !== "payout") return "kind must be refund or payout";
  if (!CHAOS.includes(p.chaos ?? "")) return `chaos must be one of ${CHAOS.join(", ")}`;
  if (p.kind === "refund" && (!/^ORD-\d{4}$/.test(p.order ?? "") || !(p.message ?? "").trim())) return "refund needs an order ORD-#### and a message";
  const amount = Number(p.amount);
  if (p.kind === "payout" && (!/^S-\d{2}$/.test(p.seller ?? "") || !(amount > 0) || amount > 1_000_000)) return "payout needs a seller S-## and a positive amount";
  return null;
}

// Runs one request. Resolves with the model summaries still being written (if any), so a
// one-shot caller can wait for them and a long-lived one can let them finish in the background.
export async function runRequest(args: RequestParams, ctx: RequestContext, emit: (line: string) => void): Promise<{ summaries: Promise<unknown> }> {
  const env = { SAMPLE_MODE: process.env.SAMPLE_MODE, NIGHTSHIFT_BASE_URL: process.env.NIGHTSHIFT_BASE_URL, ZETARIS_URL: process.env.ZETARIS_URL };
  // Model mode: live Nemotron unless sample; a Nightshift drill points the client at a closed port.
  process.env.SAMPLE_MODE = args.sample && !args.nightshiftDown ? "true" : "false";
  if (args.nightshiftDown) {
    process.env.NIGHTSHIFT_BASE_URL = `${DEAD_URL}/v1`;
    process.env.NIGHTSHIFT_API_KEY ||= "simulated-outage";
    process.env.NIGHTSHIFT_MODEL ||= "simulated-outage";
  }
  const setEnv = (k: keyof typeof env, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  const restore = () => (Object.keys(env) as Array<keyof typeof env>).forEach((k) => setEnv(k, env[k]));

  // Reuse the newest run if it's interactive; otherwise the databases were just reset by a chaos
  // run, so start a fresh interactive run.
  const runs = existsSync(LOGS) ? readdirSync(LOGS).filter((d) => /_(baseline|dumen)_(seed\d+|interactive)$/.test(d)).sort() : [];
  const runId = runs.at(-1)?.endsWith("_dumen_interactive") && !args.newRun ? runs.at(-1)! : `${new Date().toISOString().replace(/[:.]/g, "-")}_dumen_interactive`;
  emit(`@@RUN ${runId}`);

  // Opened fresh each time: a person's decision (scripts/decide.ts) may have written to it.
  const world = openWorld(runId);
  const memory = openMemory({ runId });
  const trace = new Trace(runId);
  const runDir = dirname(trace.path);
  const summaryPath = join(runDir, "summary.json");
  const { ordersDb, processorUrl } = ctx;
  const deps = {
    world,
    memory,
    trace,
    ordersDb,
    processorUrl,
    callTimeoutMs: 3000,
    verifier: { defaultWaitMs: 2000, maxWaitMs: 8000, pollMs: 300 },
    modelSummaries: process.env.SAMPLE_MODE !== "true",
    deferSummaries: true, // the result shows now; Nemotron's case summary fills in after
  };

  try {
    await ctx.setChaos(args.chaos);
    const prior: { requests?: RequestRecord[] } = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : {};
    const requests = prior.requests ?? [];
    const n = requests.length + 1;

    if (args.zetarisDown) process.env.ZETARIS_URL = DEAD_URL;
    let record: RequestRecord;

    if (args.kind === "refund") {
      const { rows } = await ordersDb.query("SELECT amount::float AS amount, currency FROM orders WHERE order_id = $1", [args.order]);
      if (!rows[0]) throw new Error(`no order ${args.order}`);
      const message = args.message!.trim().slice(0, 500);
      const ticket = { ticket_id: `R-${String(n).padStart(3, "0")}`, order_id: args.order!, message, amount_requested: askedAmount(message) ?? rows[0].amount, currency: rows[0].currency };
      const { entity } = await world.ingest.receive(ticket, { agentId: "dumen", taskId: ticket.ticket_id });
      emit(`@@ENTITY ${entity.id}`);
      const r = await runDumen(ticket, deps);
      record = { at: new Date().toISOString(), kind: "refund", id: ticket.ticket_id, subject: ticket.order_id, entity: entity.id, state: r.state, executions: r.executions, chaos: args.chaos, zetaris_down: args.zetarisDown, nightshift_down: args.nightshiftDown, success_count: null, paid_amount: null };
    } else {
      const amount = Number(args.amount);
      const { rows } = await ordersDb.query("SELECT seller_id FROM sellers WHERE seller_id = $1", [args.seller]);
      if (!rows[0]) throw new Error(`no seller ${args.seller}`);
      const payout = { payout_key: `PO-R${String(n).padStart(3, "0")}-${Date.now().toString(36).toUpperCase()}`, seller_id: args.seller!, amount, batch_id: `B-REQ-${String(n).padStart(3, "0")}` };
      // Source A gets the scheduled payout first, exactly like a batch from the marketplace.
      await ordersDb.query("INSERT INTO payouts VALUES ($1, $2, $3, $4, 'pending')", [payout.payout_key, payout.seller_id, payout.amount, payout.batch_id]);
      const { entity } = await world.ingest.receivePayout(payout, { agentId: "payouts", taskId: payout.payout_key });
      emit(`@@ENTITY ${entity.id}`);
      const [r] = await runPayoutBatch(payout.batch_id, [payout], deps);
      record = { at: new Date().toISOString(), kind: "payout", id: payout.payout_key, subject: payout.seller_id, entity: entity.id, state: r.state, executions: r.executions, chaos: args.chaos, zetaris_down: args.zetarisDown, nightshift_down: args.nightshiftDown, success_count: null, paid_amount: null };
    }
    emit(`@@RESULT ${JSON.stringify({ ok: true, run: runId, ...record })}`);

    // Score it against the system of record (Zetaris back up if it was drilled down).
    if (args.chaos === "slow_confirm") await new Promise((r) => setTimeout(r, 1700)); // that payment lands ~1.5s later
    setEnv("ZETARIS_URL", env.ZETARIS_URL);
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
    emit(`@@DONE ${JSON.stringify({ ok: true, run: runId, ...record })}`);
    const pending = takePendingSummaries();
    return { summaries: pending.length ? fillSummaries(trace, pending, 6) : Promise.resolve() };
  } catch (e: any) {
    takePendingSummaries();
    emit(`@@DONE ${JSON.stringify({ ok: false, run: runId, reason: e.message })}`);
    return { summaries: Promise.resolve() };
  } finally {
    restore();
  }
}
