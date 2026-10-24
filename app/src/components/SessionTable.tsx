import Link from "next/link";
import type { Run } from "@/lib/runs";

// Requests made from the dashboard in an interactive run, newest first.
export function SessionTable({ run }: { run: Run }) {
  const requests = [...(run.summary.requests ?? [])].reverse();
  if (!requests.length) return <p className="hint">No requests in this session yet.</p>;
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Request</th>
            <th>Order / seller</th>
            <th>Chaos</th>
            <th>Outcome</th>
            <th className="num">Calls</th>
            <th className="num">Paid (Zetaris)</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((q) => (
            <tr key={q.entity}>
              <td>
                <Link href={`/activity?run=${run.info.id}&kind=${q.kind}&refund=${q.entity}#trace`}>{q.id}</Link>
              </td>
              <td>{q.subject}</td>
              <td>
                {q.chaos.replace("_", " ")}
                {q.zetaris_down ? " · Zetaris down" : ""}
                {q.nightshift_down ? " · Nightshift down" : ""}
              </td>
              <td>
                <span className={`badge ${q.state === "CONFIRMED" ? "b-confirmed" : q.state === "ESCALATED" ? "b-escalated" : "b-rejected"}`}>{q.state.toLowerCase()}</span>
              </td>
              <td className="num">{q.executions}</td>
              <td className="num">{q.success_count === null ? "?" : `${q.success_count}×`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
