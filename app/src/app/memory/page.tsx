import { TopBar } from "@/components/TopBar";
import { getView, type SearchParams } from "@/lib/view";

export const dynamic = "force-dynamic";

export default async function Memory({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const v = getView(await searchParams);
  if (!v) return <div className="card empty">No runs yet.</div>;
  const { lessons, run } = v;
  const services = (run.manifest?.world?.services ?? {}) as Record<string, string>;
  return (
    <>
      <TopBar v={v} section="Memory" title="What Dumen learned, and used." base="/memory" />
      <div className="cols2">
        <div className="card">
          <h3 style={{ marginBottom: 6 }}>H-MEM lessons</h3>
          {run.summary.fresh_memory && <p className="hint">Fresh-memory run: saved lessons were ignored; everything below was learned during this run.</p>}
          {!lessons.length && <p className="hint">No lessons recorded in this run.</p>}
          {lessons.map((l) => (
            <div key={l.id} className="lesson">
              <div>{l.content}</div>
              <div className="hint" style={{ marginTop: 6 }}>
                {l.origin === "loaded" ? "loaded from earlier runs" : "learned this run"}
                {l.promoted ? " · promoted to long-term" : ""} · confidence
                <span className="meter">
                  <i style={{ width: `${Math.round((l.confidence ?? 0) * 100)}%` }} />
                </span>
                {(l.confidence ?? 0).toFixed(2)} · used {l.uses.length}×
                {l.uses.length ? `, last by ${l.uses.at(-1)!.actor} at ${new Date(l.uses.at(-1)!.ts).toLocaleTimeString("en-GB")}` : ""}
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 style={{ marginBottom: 6 }}>Engine manifest</h3>
          <p className="hint" style={{ marginTop: 0 }}>Which Meterless World Model services were live in this run (the spec&apos;s wired-vs-helper record).</p>
          {Object.keys(services).length ? (
            <table className="wrap">
              <tbody>
                {Object.entries(services).map(([k, val]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>
                      <span className={`badge ${String(val).startsWith("wired") ? "b-confirmed" : "b-rejected"}`}>{String(val)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">This run has no manifest.</p>
          )}
        </div>
      </div>
    </>
  );
}
