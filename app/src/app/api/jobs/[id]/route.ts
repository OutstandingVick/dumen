import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getJob((await params).id);
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: "no such job" }, { status: 404 });
}
