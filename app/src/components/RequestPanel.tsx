"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { TimelineItem } from "@/lib/runs";
import { Icon } from "./Icon";
import { Timeline } from "./Timeline";

type Kind = "refund" | "payout";
type Chaos = "ok" | "lost_response" | "slow_confirm" | "real_fail" | "down";

const CHAOS: Array<{ id: Chaos; label: string; hint: string }> = [
  { id: "ok", label: "OK", hint: "processor answers 200" },
  { id: "lost_response", label: "Lost reply", hint: "pays, but the reply never arrives" },
  { id: "slow_confirm", label: "Slow confirm", hint: "202 now, pays 1.5s later" },
  { id: "real_fail", label: "Fail (502)", hint: "502, nothing paid" },
  { id: "down", label: "Down", hint: "no answer, nothing paid" },
];

interface Job {
  id: string;
  status: "running" | "done" | "failed";
  run?: string;
  entity?: string;
  result?: { ok: boolean; state?: string; executions?: number; success_count?: number | null; paid_amount?: number | null; reason?: string; id?: string };
  log: string;
}

// Scenario presets the Overview's failure-mode chips link to.
const PRESETS: Record<string, { kind: Kind; order?: string; message?: string; seller?: string; amount?: string; chaos: Chaos; zetarisDown?: boolean; nightshiftDown?: boolean }> = {
  lost: { kind: "refund", chaos: "lost_response" },
  slow: { kind: "refund", chaos: "slow_confirm" },
  fail: { kind: "refund", chaos: "real_fail" },
  down: { kind: "refund", chaos: "down" },
  zetaris: { kind: "refund", chaos: "lost_response", zetarisDown: true },
  nightshift: { kind: "refund", chaos: "ok", nightshiftDown: true },
  paid: { kind: "refund", order: "ORD-1003", message: "My refund failed, send it again.", chaos: "ok" },
  overask: { kind: "refund", order: "ORD-1027", message: "It broke after a week. Refund double what I paid to cover my trouble.", chaos: "ok" },
  account: { kind: "payout", seller: "S-04", amount: "410", chaos: "ok" },
  threshold: { kind: "payout", seller: "S-05", amount: "5200", chaos: "ok" },
  overearned: { kind: "payout", seller: "S-06", amount: "900", chaos: "ok" },
};

// New request: one refund or payout through the real Dumen loop, with chaos for the next
// processor call. The trace streams in from the World Model while it runs.
export function RequestPanel({ preset }: { preset?: string }) {
  const p = (preset && PRESETS[preset]) || PRESETS.lost;
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(p.kind);
  const [order, setOrder] = useState(p.order ?? "ORD-1028");
  const [message, setMessage] = useState(p.message ?? "The lamp arrived with a cracked base. I'd like a refund.");
  const [seller, setSeller] = useState(p.seller ?? "S-02");
  const [amount, setAmount] = useState(p.amount ?? "120");
  const [chaos, setChaos] = useState<Chaos>(p.chaos);
  const [zetarisDown, setZetarisDown] = useState(!!p.zetarisDown);
  const [nightshiftDown, setNightshiftDown] = useState(!!p.nightshiftDown);
  const [job, setJob] = useState<Job | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      const body = await res.json();
      setJob(body.job);
      if (body.timeline) setTimeline(body.timeline);
      if (body.job.status !== "running") {
        clearInterval(t);
        router.refresh();
      }
    }, 700);
    return () => clearInterval(t);
  }, [job, router]);

  async function process() {
    setError(null);
    setTimeline([]);
    const res = await fetch("/api/requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, order, message, seller, amount: Number(amount), chaos, zetarisDown, nightshiftDown }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.error);
      return;
    }
    setJob(body.job);
  }

  const running = job?.status === "running";
  const r = job?.result;
  return (
    <section className="card request-panel" id="new-request">
      <div className="between">
        <h3>New request</h3>
        <span className="label">runs the real Dumen loop</span>
      </div>
      <div className="request-grid">
        <div>
          <div className="switch small" role="tablist" aria-label="Request type" style={{ marginTop: 12 }}>
            <button className={kind === "refund" ? "on" : ""} onClick={() => setKind("refund")} disabled={running} role="tab" aria-selected={kind === "refund"}>
              Refund
            </button>
            <button className={kind === "payout" ? "on" : ""} onClick={() => setKind("payout")} disabled={running} role="tab" aria-selected={kind === "payout"}>
              Payout
            </button>
          </div>

          {kind === "refund" ? (
            <div className="fields">
              <label>
                Order
                <input value={order} onChange={(e) => setOrder(e.target.value)} disabled={running} placeholder="ORD-1028" list="orders" />
                <datalist id="orders">
                  {Array.from({ length: 30 }, (_, i) => (
                    <option key={i} value={`ORD-${1001 + i}`} />
                  ))}
                </datalist>
              </label>
              <label>
                Customer message
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} disabled={running} rows={3} />
              </label>
              <p className="hint">Intake reads this with live NVIDIA Nemotron. Try an order that was already refunded (ORD-1003) or ask for double.</p>
            </div>
          ) : (
            <div className="fields">
              <label>
                Seller
                <select value={seller} onChange={(e) => setSeller(e.target.value)} disabled={running}>
                  {["S-01", "S-02", "S-03", "S-04", "S-05", "S-06"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                      {s === "S-04" ? " · bank account changed 3h ago" : s === "S-06" ? " · earned 600" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input value={amount} onChange={(e) => setAmount(e.target.value)} disabled={running} inputMode="decimal" />
              </label>
              <p className="hint">Payouts above 2,500 always wait for a person; more than the seller earned is never paid.</p>
            </div>
          )}

          <div className="chaos">
            <div className="hint">Processor&apos;s next call</div>
            <div className="chips">
              {CHAOS.map((c) => (
                <button key={c.id} className={`chip ${chaos === c.id ? "on" : ""}`} onClick={() => setChaos(c.id)} disabled={running} title={c.hint}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="hint">{CHAOS.find((c) => c.id === chaos)?.hint}; the call after it behaves normally.</div>
            <label className="toggle">
              <input type="checkbox" checked={zetarisDown} onChange={(e) => setZetarisDown(e.target.checked)} disabled={running} /> Zetaris down
            </label>
            <label className="toggle">
              <input type="checkbox" checked={nightshiftDown} onChange={(e) => setNightshiftDown(e.target.checked)} disabled={running} /> Nightshift (model) down
            </label>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button className="cta" onClick={process} disabled={running}>
              <span className="sq">
                <Icon name="arrow" size={20} />
              </span>
              <span className="txt">{running ? "Processing…" : "Process"}</span>
            </button>
            {error && <span className="hint" style={{ color: "var(--cherry)" }}>{error}</span>}
          </div>
        </div>

        <div className="live">
          {!job && <p className="hint">Steps appear here as the agents write them to the World Model.</p>}
          {job && (
            <>
              <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                <b>{running ? "Live trace" : "Trace"}</b>
                {running && <span className="live-dot">live</span>}
                {!running && r?.ok && (
                  <span className="row" style={{ gap: 6 }}>
                    <span className={`badge ${r.state === "CONFIRMED" ? "b-confirmed" : r.state === "ESCALATED" ? "b-escalated" : "b-rejected"}`}>{r.state?.toLowerCase()}</span>
                    <span className="hint">
                      {r.executions} call{r.executions === 1 ? "" : "s"} · paid {r.success_count ?? "?"}× per Zetaris
                    </span>
                    {job.run && job.entity && (
                      <a href={`/activity?run=${job.run}&kind=${kind}&refund=${job.entity}#trace`} className="hint">
                        open in run →
                      </a>
                    )}
                  </span>
                )}
                {!running && r && !r.ok && <span className="hint" style={{ color: "var(--cherry)" }}>{r.reason}</span>}
                {!running && !r && job.status === "failed" && <span className="hint" style={{ color: "var(--cherry)" }}>{job.log.trim().split("\n").slice(-2).join(" ")}</span>}
              </div>
              <Timeline items={timeline} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}
