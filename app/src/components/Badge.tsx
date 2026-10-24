import type { Refund } from "@/lib/runs";

// An action's outcome, plus retried / human-decided marks.
export function Badge({ r }: { r: Refund }) {
  const badges: Array<[string, string]> = [];
  if (r.paidTwice) badges.push(["b-twice", "paid twice"]);
  else if (r.state === "PAID_RISKY") badges.push(["b-twice", "paid without a check"]);
  else if (r.state === "CONFIRMED" || r.state === "PAID") badges.push(["b-confirmed", "confirmed"]);
  else if (r.state === "REJECTED" || r.state === "DECLINED") badges.push(["b-rejected", "rejected"]);
  else if (r.state === "ESCALATED") badges.push(["b-escalated", "escalated"]);
  else badges.push(["b-failed", r.state.toLowerCase().replace(/_/g, " ")]);
  if (r.retried && !r.paidTwice) badges.push(["b-retried", "retried"]);
  if (r.humanDecision) badges.push(["b-human", "human decision"]);
  return (
    <span className="row" style={{ gap: 4 }}>
      {badges.map(([cls, text]) => (
        <span key={text} className={`badge ${cls}`}>
          {text}
        </span>
      ))}
    </span>
  );
}
