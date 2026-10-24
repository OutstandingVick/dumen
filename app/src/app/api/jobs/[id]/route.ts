import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { compareProgress, liveTimeline } from "@/lib/runs";

export const dynamic = "force-dynamic";

// A job's state, plus what's happening inside it: a request's World Model timeline as it's
// written, or a comparison's position (agent, ticket N of total, current step).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const job = getJob((await params).id);
  if (!job) return NextResponse.json({ error: "no such job" }, { status: 404 });
  const timeline = job.kind === "request" && job.run && job.entity ? liveTimeline(job.run, job.entity) : undefined;
  const progress = job.kind === "compare" && job.status === "running" ? compareProgress(job.startedAt) : undefined;
  return NextResponse.json({ job, timeline, progress });
}
