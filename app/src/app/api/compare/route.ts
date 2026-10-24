import { NextResponse } from "next/server";
import { runningJob, startCompare } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const seed = Number(body.seed);
  const lost = Number(body.lost);
  if (!Number.isInteger(seed) || seed < 0 || seed > 1_000_000) return NextResponse.json({ error: "seed must be a whole number" }, { status: 400 });
  if (!(lost >= 0 && lost <= 1)) return NextResponse.json({ error: "lost must be between 0 and 1" }, { status: 400 });
  const busy = runningJob();
  if (busy) return NextResponse.json({ error: "a comparison is already running", job: busy }, { status: 409 });
  return NextResponse.json({ job: startCompare(seed, lost, body.live === true) });
}
