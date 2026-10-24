import { RequestPanel } from "@/components/RequestPanel";
import { SessionTable } from "@/components/SessionTable";
import { TopBar } from "@/components/TopBar";
import { listRuns, loadRun } from "@/lib/runs";
import { getView } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Requests({ searchParams }: { searchParams: Promise<{ run?: string; kind?: string; preset?: string }> }) {
  const sp = await searchParams;
  const v = getView(sp);
  // The session that new requests join: the newest local run, if it's interactive.
  const newest = listRuns().find((r) => !r.demo);
  const session = newest?.interactive ? loadRun(newest.id) : null;
  return (
    <>
      {v && <TopBar v={v} section="New request" title="Put one request through Dumen." base="/requests" />}
      <RequestPanel preset={sp.preset} />
      <div className="card">
        <h3 style={{ marginBottom: 10 }}>This session {session ? <span className="label">· {session.summary.requests?.length ?? 0} requests</span> : null}</h3>
        {session ? <SessionTable run={session} /> : <p className="hint">Your first request starts a new interactive session. (A chaos run or comparison resets the databases, so a session starts again after one.)</p>}
      </div>
    </>
  );
}
