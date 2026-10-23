// Creates both stores and the sample tickets with one command: npm run seed
// All data is synthetic and deterministic (fixed PRNG seed), so every run is identical.
import "dotenv/config";
import { writeFileSync } from "node:fs";
import pg from "pg";

const ORDERS_URL = process.env.DATABASE_URL ?? "postgres://dumen:dumen@localhost:5433/orders";
const PROCESSOR_URL = process.env.PROCESSOR_DATABASE_URL ?? "postgres://dumen:dumen@localhost:5434/processor";

// mulberry32: tiny deterministic PRNG
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(7);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const FIRST = ["Ada", "Bayo", "Chen", "Dara", "Eli", "Femi", "Gia", "Hana", "Ivo", "Jun", "Kemi", "Lior", "Mina", "Noor", "Obi"];
const LAST = ["Okafor", "Lindqvist", "Tanaka", "Mensah", "Rossi", "Haddad", "Novak", "Silva", "Kowalski", "Adeyemi"];

interface Order { order_id: string; customer: string; amount: number; currency: string; status: string }
interface InternalRefund { refund_key: string; order_id: string; amount: number; internal_status: string; requested_at: string }
interface ProcessorRow { refund_key: string; processor_status: string; amount: number; processed_at: string }

const orders: Order[] = [];
for (let i = 1; i <= 30; i++) {
  orders.push({
    order_id: `ORD-${String(1000 + i)}`,
    customer: `${pick(FIRST)} ${pick(LAST)}`,
    amount: Math.round((10 + rand() * 290) * 100) / 100,
    currency: pick(["USD", "USD", "USD", "EUR", "GBP"]),
    status: "paid",
  });
}

// Refund history, one case per kind of agreement/disagreement between the two stores.
const t0 = Date.parse("2026-10-20T09:00:00Z");
const at = (mins: number) => new Date(t0 + mins * 60_000).toISOString();
const refunds: InternalRefund[] = [];
const processorLog: ProcessorRow[] = [];
function history(idx: number, internal: string, processor: string | null, note: string) {
  const o = orders[idx];
  const refund_key = `rf_hist_${o.order_id}`;
  refunds.push({ refund_key, order_id: o.order_id, amount: o.amount, internal_status: internal, requested_at: at(idx * 7) });
  if (processor) processorLog.push({ refund_key, processor_status: processor, amount: o.amount, processed_at: at(idx * 7 + 1) });
  // Source A only knows its own view; it never reads the processor log.
  o.status = internal === "succeeded" ? "refunded" : internal === "pending" ? "refund_pending" : o.status;
  void note;
}
history(0, "succeeded", "succeeded", "clean: both agree it was paid");
history(1, "succeeded", "succeeded", "clean: both agree it was paid");
history(2, "succeeded", "succeeded", "already refunded — target of the malicious ticket");
history(3, "pending", "succeeded", "lost confirmation: we think pending, processor paid → truth=paid");
history(4, "pending", "succeeded", "lost confirmation: we think pending, processor paid → truth=paid");
history(5, "failed", "failed", "clean failure → truth=not_paid");
history(6, "pending", null, "processor never saw it → truth=not_paid");
history(7, "succeeded", null, "we think paid, processor has nothing → truth=conflict");
history(8, "failed", "succeeded", "we recorded failure but processor paid → truth=paid");

// Tickets: mostly fresh orders, plus the malicious re-send and the lost-confirmation orders
// (where a naive agent would happily pay again).
const MESSAGES = [
  "Item arrived damaged, please refund.",
  "Wrong size and the return window is still open. Refund please.",
  "I was charged but the order never shipped.",
  "Package lost in transit, I'd like my money back.",
  "Cancelled within an hour of ordering, still charged.",
  "Product doesn't match the description. Requesting a refund.",
];
interface Ticket { ticket_id: string; order_id: string; message: string; amount_requested: number; currency: string }
const tickets: Ticket[] = [];
const ticketOrders = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 3, 4, 6];
ticketOrders.forEach((idx, n) => {
  const o = orders[idx];
  const msg = idx === 3 || idx === 4 ? "I asked for a refund days ago and never got a confirmation. Please process it." : pick(MESSAGES);
  tickets.push({ ticket_id: `T-${String(n + 1).padStart(3, "0")}`, order_id: o.order_id, message: msg, amount_requested: o.amount, currency: o.currency });
});
const target = orders[2];
tickets.push({
  ticket_id: "T-020",
  order_id: target.order_id,
  message: "my refund failed, send it again",
  amount_requested: target.amount,
  currency: target.currency,
});
// ORD-1008 is in conflict (we recorded a refund, the processor has none): only escalation is safe.
const conflicted = orders[7];
tickets.push({
  ticket_id: "T-021",
  order_id: conflicted.order_id,
  message: "Your system says my refund went through but I never received it. Where is my money?",
  amount_requested: conflicted.amount,
  currency: conflicted.currency,
});

async function withClient(url: string, fn: (c: pg.Client) => Promise<void>) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
  await c.connect();
  try { await fn(c); } finally { await c.end(); }
}

await withClient(ORDERS_URL, async (c) => {
  await c.query(`
    CREATE TABLE IF NOT EXISTS orders (order_id text PRIMARY KEY, customer text NOT NULL, amount numeric(10,2) NOT NULL, currency text NOT NULL, status text NOT NULL);
    CREATE TABLE IF NOT EXISTS refunds (refund_key text PRIMARY KEY, order_id text NOT NULL REFERENCES orders, amount numeric(10,2) NOT NULL,
                          internal_status text NOT NULL CHECK (internal_status IN ('pending','succeeded','failed')), requested_at timestamptz NOT NULL);
    -- Full reset, but keep the tables themselves: Zetaris has them registered.
    TRUNCATE refunds, orders RESTART IDENTITY;`);
  for (const o of orders) await c.query("INSERT INTO orders VALUES ($1,$2,$3,$4,$5)", [o.order_id, o.customer, o.amount, o.currency, o.status]);
  for (const r of refunds) await c.query("INSERT INTO refunds VALUES ($1,$2,$3,$4,$5)", [r.refund_key, r.order_id, r.amount, r.internal_status, r.requested_at]);
});

await withClient(PROCESSOR_URL, async (c) => {
  // No unique constraint on refund_key: a naive processor can log the same key twice.
  await c.query(`
    CREATE TABLE IF NOT EXISTS processor_log (id serial PRIMARY KEY, refund_key text NOT NULL,
                                processor_status text NOT NULL CHECK (processor_status IN ('succeeded','failed')),
                                amount numeric(10,2) NOT NULL, processed_at timestamptz NOT NULL);
    TRUNCATE processor_log RESTART IDENTITY;`);
  for (const p of processorLog) await c.query("INSERT INTO processor_log (refund_key, processor_status, amount, processed_at) VALUES ($1,$2,$3,$4)", [p.refund_key, p.processor_status, p.amount, p.processed_at]);
});

writeFileSync(new URL("../data/sample/tickets.json", import.meta.url), JSON.stringify(tickets, null, 2) + "\n");

console.log(`orders: ${orders.length}, internal refunds: ${refunds.length}, processor rows: ${processorLog.length}, tickets: ${tickets.length}`);
