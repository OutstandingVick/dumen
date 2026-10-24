// Reads the refund_truth semantic view from Zetaris: the one place Dumen asks
// "what actually happened to this refund?". Uses the same HTTP API as the Zetaris UI.
import { randomUUID } from "node:crypto";

export type Truth = "paid" | "not_paid" | "conflict";

export interface RefundTruth {
  refund_key: string;
  order_id: string | null;
  amount: number;
  internal_status: string | null;
  processor_status: string | null;
  success_count: number;
  paid_amount: number;
  truth: Truth;
}

const TIMEOUT_MS = 30_000;

let session: { token: string; orgId: string } | null = null;

function baseUrl(): string {
  return process.env.ZETARIS_URL ?? "http://localhost:3001";
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(baseUrl() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    const why = e.name === "TimeoutError" ? `no answer within ${TIMEOUT_MS / 1000}s` : (e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.cause?.message ?? e.message);
    throw new Error(`Zetaris unreachable at ${baseUrl()} (${why})`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Zetaris ${path} returned ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function login(): Promise<{ token: string; orgId: string }> {
  const username = process.env.ZETARIS_USER;
  const password = process.env.ZETARIS_PASSWORD;
  if (!username || !password) throw new Error("ZETARIS_USER and ZETARIS_PASSWORD must be set");
  const raw = JSON.stringify(await post("/api/auth/login", { username, password }));
  const token = raw.match(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/)?.[0];
  const orgId = raw.match(/"orgId"\s*:\s*(\d+)/)?.[1];
  if (!token || !orgId) throw new Error("Zetaris login returned no token or orgId");
  return { token, orgId };
}

export async function query(sql: string): Promise<Record<string, string>[]> {
  session ??= await login();
  const res = await post(
    "/api/proxy/query/sql/start",
    { select: sql, pageLimit: 100 },
    { Authorization: `Bearer ${session.token}`, "X-Org-ID": session.orgId, "X-Request-ID": randomUUID() },
  );
  return findRows(res);
}

// The response nests its rows; take the first array of plain objects.
function findRows(node: any): Record<string, string>[] {
  if (Array.isArray(node)) {
    if (node.length === 0 || (typeof node[0] === "object" && node[0] !== null && !Array.isArray(node[0]))) return node;
    return [];
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) {
      const rows = findRows(v);
      if (rows.length) return rows;
    }
  }
  return [];
}

function toTruth(r: Record<string, string>): RefundTruth {
  const num = (v: unknown) => (v === null || v === undefined || v === "null" ? 0 : Number(v));
  const str = (v: unknown) => (v === null || v === undefined || v === "null" ? null : String(v));
  return {
    refund_key: String(r.refund_key),
    order_id: str(r.order_id),
    amount: num(r.amount),
    internal_status: str(r.internal_status),
    processor_status: str(r.processor_status),
    success_count: num(r.success_count),
    paid_amount: num(r.paid_amount),
    truth: r.truth as Truth,
  };
}

export async function getRefundTruth(refundKey: string): Promise<RefundTruth | null> {
  if (!/^[A-Za-z0-9_.:-]+$/.test(refundKey)) throw new Error(`invalid refund_key: ${refundKey}`);
  const rows = await query(`SELECT * FROM dumen.refund_truth WHERE refund_key = '${refundKey}'`);
  return rows.length ? toTruth(rows[0]) : null;
}

// Every refund ever recorded for an order: what the Verifier checks before Intake approves.
export async function getOrderRefundTruth(orderId: string): Promise<RefundTruth[]> {
  if (!/^[A-Za-z0-9_.:-]+$/.test(orderId)) throw new Error(`invalid order_id: ${orderId}`);
  return (await query(`SELECT * FROM dumen.refund_truth WHERE order_id = '${orderId}' ORDER BY refund_key`)).map(toTruth);
}

export async function getAllRefundTruth(): Promise<RefundTruth[]> {
  return (await query("SELECT * FROM dumen.refund_truth ORDER BY refund_key")).map(toTruth);
}

// ── Payouts ───────────────────────────────────────────────────────────────

export interface PayoutTruth {
  payout_key: string;
  seller_id: string | null;
  batch_id: string | null;
  amount: number;
  internal_status: string | null;
  bank_status: string | null;
  success_count: number;
  paid_amount: number;
  earned_balance: number;
  account_changed_recently: boolean;
  truth: Truth;
}

function toPayoutTruth(r: Record<string, string>): PayoutTruth {
  const num = (v: unknown) => (v === null || v === undefined || v === "null" ? 0 : Number(v));
  const str = (v: unknown) => (v === null || v === undefined || v === "null" ? null : String(v));
  return {
    payout_key: String(r.payout_key),
    seller_id: str(r.seller_id),
    batch_id: str(r.batch_id),
    amount: num(r.amount),
    internal_status: str(r.internal_status),
    bank_status: str(r.bank_status),
    success_count: num(r.success_count),
    paid_amount: num(r.paid_amount),
    earned_balance: num(r.earned_balance),
    account_changed_recently: String(r.account_changed_recently) === "true",
    truth: r.truth as Truth,
  };
}

export async function getPayoutTruth(payoutKey: string): Promise<PayoutTruth | null> {
  if (!/^[A-Za-z0-9_.:-]+$/.test(payoutKey)) throw new Error(`invalid payout_key: ${payoutKey}`);
  const rows = await query(`SELECT * FROM dumen.payout_truth WHERE payout_key = '${payoutKey}'`);
  return rows.length ? toPayoutTruth(rows[0]) : null;
}

export async function getAllPayoutTruth(): Promise<PayoutTruth[]> {
  return (await query("SELECT * FROM dumen.payout_truth ORDER BY payout_key")).map(toPayoutTruth);
}
