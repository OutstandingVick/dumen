import Link from "next/link";
import { Badge } from "@/components/Badge";
import { SessionTable } from "@/components/SessionTable";
import { Timeline } from "@/components/Timeline";
import { TopBar } from "@/components/TopBar";
import { timelineOf } from "@/lib/runs";
import { getView, money, type SearchParams } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Activity({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const v = getView(await searchParams);
  if (!v) return <div className="card empty">No runs yet.</div>;
  const { run, kind, refunds, otherRefunds, other, selected, selectedKey, counterpart } = v;
  const s = run.summary;
  return (
    <>
      <TopBar v={v} section="Activity & traces" title="Every step, with its evidence." base="/activity" />

      {run.info.interactive && (
        <div className="card">
          <div className="between" style={{ marginBottom: 10 }}>
            <h3>Requests in this session · {s.requests?.length ?? 0}</h3>
            <Link className="chip" href="/requests">
              New request
            </Link>
          </div>
          <SessionTable run={run} />
        </div>
      )}

      <div className="split">
        <div className="card">
          <div className="between" style={{ marginBottom: 12 }}>
            <h3>
              {kind === "payout" ? "Payouts" : "Refunds"} <span className="label">· {run.info.agent} run</span>
            </h3>
            <div className="switch small" role="tablist" aria-label="Money movement">
              <Link href={`/activity?run=${run.info.id}&kind=refund`} className={kind === "refund" ? "on" : ""} role="tab" aria-selected={kind === "refund"}>
                Refunds
              </Link>
              <Link href={`/activity?run=${run.info.id}&kind=payout`} className={kind === "payout" ? "on" : ""} role="tab" aria-selected={kind === "payout"}>
                Payouts
              </Link>
            </div>
          </div>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>{kind === "payout" ? "Payout" : "Ticket"}</th>
                  <th>{kind === "payout" ? "Seller · batch" : "Order"}</th>
                  <th className="num">Amount</th>
                  <th className="num">Calls</th>
                  <th>Outcome</th>
                  {other && <th>{other.info.agent}</th>}
                </tr>
              </thead>
              <tbody>
                {refunds.map((r) => {
                  const o = otherRefunds.find((x) => x.ticketId === r.ticketId);
                  return (
                    <tr key={r.key} className={r.key === selectedKey ? "sel" : ""}>
                      <td>
                        <Link href={`/activity?run=${run.info.id}&kind=${kind}&refund=${r.key}#trace`} scroll={false}>
                          {r.ticketId}
                        </Link>
                      </td>
                      <td>{r.orderId}</td>
                      <td className="num">{r.amount !== null ? money(Number(r.amount)) : "—"}</td>
                      <td className="num">{r.calls}</td>
                      <td>
                        <Badge r={r} />
                      </td>
                      {other && <td>{o ? <Badge r={o} /> : <span className="hint">—</span>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!refunds.length && <p className="hint">No {kind === "payout" ? "payouts" : "refunds"} in this run.</p>}
          </div>
        </div>

        <div className="card" id="trace">
          <h3>Trace {selected ? <span className="label">· {selected.ticketId} ({selected.orderId})</span> : null}</h3>
          {selected ? (
            <>
              <p className="hint" style={{ margin: "4px 0 14px" }}>
                {run.info.agent === "dumen" ? "Every World Model event: which agent, the state change, the reason and the evidence. Blue rows are handoffs between agents." : "The baseline agent's steps from its trace."}
              </p>
              <Timeline items={timelineOf(run, selected.key)} />
              {other && counterpart && (
                <>
                  <div className="vs-label">
                    vs. same {kind === "payout" ? "payout" : "ticket"}, {other.info.agent} <Badge r={counterpart} />
                  </div>
                  <Timeline items={timelineOf(other, counterpart.key)} />
                </>
              )}
            </>
          ) : (
            <p className="hint">Pick a {kind === "payout" ? "payout" : "refund"} on the left.</p>
          )}
        </div>
      </div>
    </>
  );
}
