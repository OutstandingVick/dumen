import { NextResponse } from "next/server";
import { runDecide } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { run, entity, verdict, reason } = await req.json().catch(() => ({}));
  if (typeof run !== "string" || !/^[\w-]+$/.test(run)) return NextResponse.json({ ok: false, reason: "bad run" }, { status: 400 });
  if (typeof entity !== "string" || !/^ent_refund_[0-9a-f]+$/.test(entity)) return NextResponse.json({ ok: false, reason: "bad refund" }, { status: 400 });
  if (verdict !== "approve" && verdict !== "reject") return NextResponse.json({ ok: false, reason: "verdict must be approve or reject" }, { status: 400 });
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) return NextResponse.json({ ok: false, reason: "give a reason (3–500 characters)" }, { status: 400 });
  const result = await runDecide(run, entity, verdict, reason.trim());
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
