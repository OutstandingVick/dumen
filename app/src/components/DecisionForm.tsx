"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Approve / Reject an escalated refund or payout. The decision runs scripts/decide.ts, which
// writes it through the World Model as agentId=human; Approve still goes through the Verifier.
// On a run that can't be decided any more, the reason shows only when someone tries.
export function DecisionForm({ run, entity, disabledReason }: { run: string; entity: string; disabledReason: string | null }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; state: string | null; reason: string } | null>(null);
  const [blocked, setBlocked] = useState(false);

  async function decide(verdict: "approve" | "reject") {
    if (disabledReason) {
      setBlocked(true);
      return;
    }
    setBusy(verdict);
    setResult(null);
    const res = await fetch("/api/decide", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ run, entity, verdict, reason }) });
    setResult(await res.json());
    setBusy(null);
    router.refresh();
  }

  const ready = reason.trim().length >= 3 && !busy;
  return (
    <div className="decision">
      <textarea placeholder="Reason for your decision (recorded in the trace)" value={reason} onChange={(e) => setReason(e.target.value)} disabled={!!busy} />
      <div className="row">
        <button className="good" onClick={() => decide("approve")} disabled={!ready}>
          {busy === "approve" ? "Verifying…" : "Approve (verify, then pay)"}
        </button>
        <button className="bad" onClick={() => decide("reject")} disabled={!ready}>
          {busy === "reject" ? "Rejecting…" : "Reject"}
        </button>
        {result && (
          <span className="hint" style={{ color: result.ok ? "var(--good)" : "var(--bad)" }}>
            {result.ok ? `→ ${result.state}: ` : "Not applied: "}
            {result.reason}
          </span>
        )}
      </div>
      {blocked && disabledReason && (
        <div className="banner info" style={{ marginTop: 10 }}>
          {disabledReason}
        </div>
      )}
    </div>
  );
}
