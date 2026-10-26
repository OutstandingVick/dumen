// Live comparisons: ask Nemotron for every ticket's refund decision up front, in parallel,
// and save them so both agents run the payment phase on the same decisions.
//   npx tsx scripts/decide-all.ts --out logs/compare-…/intake.json [--tickets 22] [--concurrency 6]
// Prints "@@PROGRESS {...}" lines for the dashboard.
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { decideIntake, type IntakeDecision, type Ticket } from "../agents/intake.js";
import { warmUp } from "../runtime/generator.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    tickets: { type: "string", default: "22" },
    concurrency: { type: "string", default: "6" },
  },
});
if (!args.out) throw new Error("--out is required");

const tickets: Ticket[] = JSON.parse(readFileSync(join(ROOT, "data/sample/tickets.json"), "utf8")).slice(0, Number(args.tickets));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 2 });
const t0 = Date.now();
try {
  const { rows } = await db.query<{ order_id: string; amount: string; currency: string }>("SELECT order_id, amount, currency FROM orders WHERE order_id = ANY($1)", [tickets.map((t) => t.order_id)]);
  const orders = new Map(rows.map((r) => [r.order_id, { amount: Number(r.amount), currency: r.currency }]));

  const w = await warmUp();
  console.log(w.skipped ? "warm-up skipped: Nightshift answered in the last 10 minutes" : w.error ? `warm-up failed after ${w.ms}ms (${w.error})` : `warm in ${w.ms}ms`);

  const decisions: Record<string, IntakeDecision> = {};
  const failed: string[] = [];
  let done = 0;
  const queue = tickets.filter((t) => orders.has(t.order_id)); // unknown orders are rejected before intake
  const total = queue.length;
  const progress = () => console.log(`@@PROGRESS ${JSON.stringify({ phase: "deciding", done, total })}`);
  progress();
  const worker = async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const { decision, raw } = await decideIntake(t, orders.get(t.order_id)!);
      if (decision) decisions[t.ticket_id] = decision;
      else failed.push(`${t.ticket_id}: ${raw.slice(0, 120)}`);
      done++;
      progress();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number(args.concurrency), total) }, worker));

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ saved_at: new Date().toISOString(), source: "live", decisions, failed }, null, 2) + "\n");
  console.log(`decided ${Object.keys(decisions).length}/${total} in ${Date.now() - t0}ms${failed.length ? `; no usable decision: ${failed.join(" | ")}` : ""}`);
} finally {
  await db.end();
}
