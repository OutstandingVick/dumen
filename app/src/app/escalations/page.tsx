import Link from "next/link";
import { DecisionForm } from "@/components/DecisionForm";
import { TopBar } from "@/components/TopBar";
import { refundsOf, type Kind } from "@/lib/runs";
import { getView, money, type SearchParams } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Escalations({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const v = getView(await searchParams);
  if (!v) return <div className="card empty">No runs yet.</div>;
  const { run } = v;
  const open = run.escalations.filter((c) => !c.decision);
  const decided = run.escalations.filter((c) => c.decision);
  return (
    <>
      <TopBar v={v} section="Escalations" title={open.length ? `${open.length} waiting for your decision.` : "Nothing waiting for you."} base="/escalations" />
      {run.info.agent !== "dumen" && <div className="card hint">Baseline runs never escalate: that&apos;s the problem. Pick a Dumen run.</div>}
      {[...open, ...decided].map((c) => {
        const ck: Kind = c.kind ?? "refund";
        const entity = refundsOf(run, ck).find((r) => r.refundKey === c.refund_key);
        return (
          <div key={c.case_id} className="card">
            <div className="between">
              <div className="row">
                <span className={`badge ${ck === "payout" ? "b-retried" : "b-rejected"}`}>{ck}</span>
                <h3>
                  {c.ticket_id} · {ck === "payout" ? `seller ${c.order_id}` : c.order_id}
                </h3>
                {c.amount !== null && <span className="label">{money(Number(c.amount))}</span>}
              </div>
              <div className="row">
                <span className="badge b-escalated">{c.decision ? `decided: ${c.decision.outcome ?? c.decision.verdict}` : "needs decision"}</span>
                {entity && (
                  <Link className="chip" href={`/activity?run=${run.info.id}&kind=${ck}&ticket=${encodeURIComponent(entity.ticketId)}`}>
                    Trace
                  </Link>
                )}
              </div>
            </div>
            <p style={{ margin: "12px 0 6px" }}>{c.summary}</p>
            <p className="hint" style={{ margin: 0 }}>
              Summary by {c.summary_source === "model" ? "NVIDIA Nemotron" : c.summary_pending ? "template · Nemotron's summary is on its way (refresh)" : "template (model not used)"} · Why escalated: {c.reason}
            </p>
            {c.last_evidence && (
              <details>
                <summary>evidence</summary>
                <pre className="ev">{JSON.stringify({ state_history: c.state_history, last_evidence: c.last_evidence }, null, 2)}</pre>
              </details>
            )}
            <div className="divider" />
            {c.decision ? (
              <p className="hint" style={{ margin: 0 }}>
                {c.decision.verdict === "approve" ? "Approved" : "Rejected"} by a person: “{c.decision.reason}” → {c.decision.outcome}
              </p>
            ) : (
              entity && <DecisionForm run={run.info.id} entity={entity.key} disabledReason={run.info.id === v.latest ? null : "This is an older run. A later run has reset the databases, so its escalations can be read but not decided. Open the newest run to decide."} />
            )}
          </div>
        );
      })}
      {!run.escalations.length && run.info.agent === "dumen" && <div className="card hint">Nothing was escalated in this run.</div>}
    </>
  );
}
