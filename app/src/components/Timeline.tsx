import type { TimelineItem } from "@/lib/runs";

function tone(i: TimelineItem): string {
  if (i.kind === "handoff") return "handoff";
  if (i.kind === "alert") return "alert";
  if (i.kind === "memory") return "memory";
  if (i.to === "CONFIRMED") return "good";
  if (i.to === "ESCALATED") return "warn";
  if (i.to === "UNKNOWN" || i.to === "FAILED_DEFINITE") return "bad";
  if (/timeout|no response/.test(i.reason ?? "")) return "bad";
  return "";
}

function Evidence({ e }: { e: NonNullable<TimelineItem["evidence"]> }) {
  const parts: string[] = [];
  if (e.query) parts.push(`query:\n${e.query}`);
  if (e.truth) parts.push(`result:\n${JSON.stringify(e.truth, null, 2)}`);
  if (e.rows && (e.rows as unknown[]).length) parts.push(`rows:\n${JSON.stringify(e.rows, null, 2)}`);
  if (e.response) parts.push(`response:\n${JSON.stringify(e.response, null, 2)}`);
  if (e.note) parts.push(`note: ${e.note}`);
  if (!parts.length) return null;
  const label = e.query ? "Zetaris evidence" : e.response ? "processor / step detail" : "detail";
  return (
    <details>
      <summary>{label}</summary>
      <pre className="ev">{parts.join("\n\n")}</pre>
    </details>
  );
}

export function Timeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <p className="hint">No events recorded for this refund.</p>;
  const t0 = Date.parse(items[0].ts);
  return (
    <ol className="timeline">
      {items.map((i, n) => (
        <li key={n} className={`tl ${tone(i)}`}>
          <div className="head">
            <span className="agent">{i.agent}</span>
            <span className="title">{i.title}</span>
            <span className="when">+{((Date.parse(i.ts) - t0) / 1000).toFixed(1)}s</span>
          </div>
          {i.reason && <div className="why">{i.reason}</div>}
          {i.evidence && <Evidence e={i.evidence} />}
        </li>
      ))}
    </ol>
  );
}
