import { NextResponse } from "next/server";
import { runningJob, startRequest } from "@/lib/jobs";

export const dynamic = "force-dynamic";

const CHAOS = ["ok", "lost_response", "real_fail", "slow_confirm", "down"];

// Start one refund or payout through the real Dumen loop. Validation here mirrors
// scripts/request.ts, which validates again before anything runs.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const chaos = CHAOS.includes(b.chaos) ? b.chaos : null;
  if (!chaos) return NextResponse.json({ error: `chaos must be one of ${CHAOS.join(", ")}` }, { status: 400 });
  const flags = { zetarisDown: b.zetarisDown === true, nightshiftDown: b.nightshiftDown === true };
  let params;
  if (b.kind === "refund") {
    const order = String(b.order ?? "").trim().toUpperCase();
    const message = String(b.message ?? "").trim();
    if (!/^ORD-\d{4}$/.test(order)) return NextResponse.json({ error: "order id looks like ORD-1028" }, { status: 400 });
    if (message.length < 3 || message.length > 500) return NextResponse.json({ error: "write the customer's message (3–500 characters)" }, { status: 400 });
    params = { kind: "refund" as const, order, message, chaos, ...flags };
  } else if (b.kind === "payout") {
    const seller = String(b.seller ?? "").trim().toUpperCase();
    const amount = Number(b.amount);
    if (!/^S-\d{2}$/.test(seller)) return NextResponse.json({ error: "seller id looks like S-02" }, { status: 400 });
    if (!(amount > 0) || amount > 1_000_000) return NextResponse.json({ error: "amount must be a positive number" }, { status: 400 });
    params = { kind: "payout" as const, seller, amount: Math.round(amount * 100) / 100, chaos, ...flags };
  } else {
    return NextResponse.json({ error: "kind must be refund or payout" }, { status: 400 });
  }
  const busy = runningJob();
  if (busy) return NextResponse.json({ error: `wait for the running ${busy.kind} to finish`, job: busy }, { status: 409 });
  return NextResponse.json({ job: startRequest(params) });
}
