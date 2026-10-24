import Link from "next/link";
import { AgentAvatar, Crew } from "@/components/Agent";
import { CompareButton } from "@/components/CompareButton";
import { CountUp } from "@/components/CountUp";
import { DecisionForm } from "@/components/DecisionForm";
import { RunPicker } from "@/components/RunPicker";
import { Timeline } from "@/components/Timeline";
import { latestRunId, lessonsOf, listRuns, loadRun, pairFor, refundsOf, timelineOf, type Kind, type Refund, type Run, type RunInfo } from "@/lib/runs";

export const dynamic = "force-dynamic";

const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const runLabel = (r: RunInfo) => {
  const f = r.summary?.failures;
  const drill = f?.zetaris_down ? " · ⚠ Zetaris down" : f?.nightshift_down ? " · ⚠ Nightshift down" : "";
  return `${r.agent} · seed ${r.seed} · lost ${r.summary?.rates.lost ?? "?"}${drill} · ${new Date(r.startedAt).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
};

function Badge({ r }: { r: Refund }) {
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

// Risky = sent without the check it needed: changed bank account, unapproved high value, or above earned.
const riskyPayouts = (p: NonNullable<Run["summary"]["payouts"]>) => p.changed_account_paid.length + p.high_value_paid.length + p.overpaid.length;

function Side({ run, agent, kind }: { run: Run | null; agent: "baseline" | "dumen"; kind: Kind }) {
  if (!run) {
    return (
      <div className={`side ${agent}`}>
        <div className="who">{agent === "dumen" ? "Dumen" : "Baseline agent"}</div>
        <p className="hint">No {agent} run for this seed and lost rate yet. Use “Run comparison”.</p>
      </div>
    );
  }
  const s = run.summary;
  const p = s.payouts;
  if (kind === "payout" && !p) {
    return (
      <div className={`side ${agent}`}>
        <div className="who">{agent === "dumen" ? "Dumen" : "Baseline agent"}</div>
        <p className="hint">This run has no payouts (it predates them or ran with --no-payouts).</p>
      </div>
    );
  }
  const lost = kind === "payout" ? p!.money_lost : s.money_lost;
  const lostBad = lost > 0;
  const dupes = kind === "payout" ? p!.duplicate_payouts : s.double_refunds;
  const risky = kind === "payout" ? riskyPayouts(p!) : (s.overpaid_orders?.length ?? 0);
  return (
    <div className={`side ${agent}`}>
      <div className="who">
        <span className="tag">
          <AgentAvatar id={agent === "dumen" ? "verifier" : "baseline"} size={30} />
          {agent === "dumen" ? "Dumen" : "Baseline agent · retries from memory"}
        </span>
        <Link href={`/?run=${run.info.id}&kind=${kind}`} className="hint">
          open run →
        </Link>
      </div>
      <div className="receipt-line" />
      <div className="hint">money paid out that wasn't owed</div>
      <div className={`money ${lostBad ? "bad" : "good"}`}>
        <CountUp value={lost} />
      </div>
      <div className={`stamp ${lostBad ? "bad" : "good"}`}>{lostBad ? (dupes ? `PAID ×2 · ${dupes}` : "OVERPAID") : "VERIFIED ✓"}</div>
      <div className="stats">
        <div className={`stat ${dupes ? "bad" : "good"}`}>
          <b>{dupes}</b>
          <span>{kind === "payout" ? "duplicate payouts" : "double refunds"}</span>
        </div>
        <div className={`stat ${risky ? "bad" : "good"}`}>
          <b>{risky}</b>
          <span>{kind === "payout" ? "risky payouts sent" : "overpaid orders"}</span>
        </div>
        <div className="stat">
          <b>{kind === "payout" ? p!.escalations : (s.escalations ?? 0)}</b>
          <span>escalations</span>
        </div>
        <div className="stat">
          <b>{kind === "payout" ? p!.bank_calls : s.processor_calls}</b>
          <span>{kind === "payout" ? "bank calls" : "processor calls"}</span>
        </div>
      </div>
    </div>
  );
}

// Open the trace where the contrast is sharpest: a ticket the other agent paid twice
// that this agent handled with at least one processor call (a lost confirmation).
function pickDefault(refunds: Refund[], other: Refund[]): string | undefined {
  const twiceElsewhere = (r: Refund) => other.some((o) => o.ticketId === r.ticketId && o.paidTwice);
  return (
    refunds.find((r) => twiceElsewhere(r) && r.verified) ??
    refunds.find((r) => twiceElsewhere(r) && r.calls > 0) ??
    refunds.find((r) => r.paidTwice) ??
    refunds.find((r) => twiceElsewhere(r)) ??
    refunds.find((r) => r.retried) ??
    refunds[0]
  )?.key;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ run?: string; refund?: string; kind?: string }> }) {
  const sp = await searchParams;
  const runs = listRuns();
  if (!runs.length) {
    return (
      <main className="shell">
        <div className="empty">
          <div className="logo" aria-hidden>
            🧾
          </div>
          <h2 style={{ margin: "0 0 6px", fontSize: 26 }}>No runs yet.</h2>
          <p className="hint">Nothing to show until a run happens. Create one from the repo folder:</p>
          <pre>{`docker compose up -d --wait
npm run compare`}</pre>
          <p className="hint">or a single run: <code>npm run chaos -- --agent dumen --seed 42 --lost 0.2</code></p>
        </div>
      </main>
    );
  }

  // Open on the newest Dumen run that had lost confirmations: that's where the story is.
  // Outage drills are opened from the picker, not by default.
  const drill = (r: RunInfo) => !!(r.summary?.failures?.zetaris_down || r.summary?.failures?.nightshift_down);
  const defaultRun =
    runs.find((r) => r.agent === "dumen" && !drill(r) && (r.summary?.rates.lost ?? 0) > 0) ?? runs.find((r) => r.agent === "dumen") ?? runs[0];
  const run = loadRun(sp.run ?? defaultRun.id) ?? loadRun(defaultRun.id)!;
  const pair = pairFor(run.info);
  const baseline = pair.baseline ? loadRun(pair.baseline.id) : null;
  const dumen = pair.dumen ? loadRun(pair.dumen.id) : null;
  const other = run.info.agent === "dumen" ? baseline : dumen;

  const kind: Kind = sp.kind === "payout" ? "payout" : "refund";
  const refunds = refundsOf(run, kind);
  const otherRefunds = other ? refundsOf(other, kind) : [];
  const selectedKey = sp.refund && refunds.some((r) => r.key === sp.refund) ? sp.refund : pickDefault(refunds, otherRefunds);
  const selected = refunds.find((r) => r.key === selectedKey);
  const counterpart = selected ? otherRefunds.find((r) => r.ticketId === selected.ticketId) : undefined;
  const lessons = run.info.agent === "dumen" ? lessonsOf(run.info.id) : [];
  const s = run.summary;
  const latest = latestRunId();
  const openCases = run.escalations.filter((c) => !c.decision);


  return (
    <main className="shell">
      <div className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            🧾
          </span>
          <div>
            Dumen
            <small>refund control room</small>
          </div>
        </div>
        <RunPicker runs={runs.map((r) => ({ id: r.id, label: runLabel(r) }))} current={run.info.id} />
        <div className="spacer" />
        <CompareButton defaultSeed={s.seed} defaultLost={s.rates.lost} />
      </div>

      {s.failures?.zetaris_down && (
        <div className="banner bad">
          <b>Zetaris was unreachable in this run.</b> The Verifier could not check refund_truth, so every refund it couldn't verify was escalated and nothing was paid on an unverified retry.
        </div>
      )}
      {s.failures?.nightshift_down && (
        <div className="banner bad">
          <b>Nightshift (the model) was unreachable in this run.</b> Intake had no model decision, so those tickets were escalated instead of refunded.
        </div>
      )}
      {run.info.id !== latest && run.info.agent === "dumen" && openCases.length > 0 && (
        <div className="banner info">This is an older run. A later run has reset the databases, so its escalations can be read but not decided.</div>
      )}

      {baseline && dumen && (
        <div className="panel">
          <div className="hero">
            <div>
              {kind === "payout" && baseline.summary.payouts && dumen.summary.payouts ? (
                <>
                  <h1>
                    Paying {baseline.summary.payouts.payouts} sellers with {Math.round((s.rates.lost ?? 0) * 100)}% of confirmations lost, the baseline re-sent whole batches:{" "}
                    <em>
                      {baseline.summary.payouts.duplicate_payouts} payout{baseline.summary.payouts.duplicate_payouts === 1 ? "" : "s"} paid twice
                    </em>
                    , {riskyPayouts(baseline.summary.payouts)} risky payout{riskyPayouts(baseline.summary.payouts) === 1 ? "" : "s"} sent, {money(baseline.summary.payouts.money_lost)} lost. Dumen{" "}
                    <em>paid each seller once</em>.
                  </h1>
                  <p className="hint" style={{ margin: "8px 0 0" }}>
                    It verified every payout in payout_truth before any re-send, rejected {dumen.summary.payouts.rejections} already paid and held {dumen.summary.payouts.escalations} for a person
                    (changed bank account, above the approval threshold, or more than earned) · seed {s.seed}
                  </p>
                </>
              ) : (
                <>
                  <h1>
                    With {Math.round((s.rates.lost ?? 0) * 100)}% of confirmations lost, the baseline paid{" "}
                    <em>
                      {baseline.summary.double_refunds} order{baseline.summary.double_refunds === 1 ? "" : "s"} twice
                    </em>
                    {(baseline.summary.overpaid_orders?.length ?? 0) > 0 ? `, overpaid ${baseline.summary.overpaid_orders!.length}` : ""} and lost {money(baseline.summary.money_lost)}. Dumen paid{" "}
                    <em>nothing twice</em>.
                  </h1>
                  <p className="hint" style={{ margin: "8px 0 0" }}>
                    It rejected {dumen.summary.rejections ?? 0} already-paid request{dumen.summary.rejections === 1 ? "" : "s"} and escalated {dumen.summary.escalations ?? 0} case
                    {dumen.summary.escalations === 1 ? "" : "s"} for a person to decide · seed {s.seed}
                  </p>
                </>
              )}
              {openCases.length > 0 && run.info.agent === "dumen" && (
                <a href="#escalations" className="attention">
                  <span className="pulse">{openCases.length}</span>
                  waiting for your decision ↓
                </a>
              )}
            </div>
          </div>
          <div className="receipt-line" style={{ margin: "16px 0 12px" }} />
          <Crew />
        </div>
      )}

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>
            Same seed, same chaos · seed {s.seed} · {Math.round(s.rates.lost * 100)}% lost confirmations ·{" "}
            {kind === "payout" ? `${s.payouts?.payouts ?? 0} payouts in ${s.payouts?.batches ?? 0} batches` : `${s.tickets_processed} refund tickets`}
          </h2>
          <div className="switch" role="tablist" aria-label="Money movement">
            <Link href={`/?run=${run.info.id}&kind=refund`} className={kind === "refund" ? "on" : ""} role="tab" aria-selected={kind === "refund"}>
              🧾 Refunds
            </Link>
            <Link href={`/?run=${run.info.id}&kind=payout`} className={kind === "payout" ? "on" : ""} role="tab" aria-selected={kind === "payout"}>
              🏦 Payouts
            </Link>
          </div>
        </div>
        <div className="versus">
          <Side run={baseline} agent="baseline" kind={kind} />
          <Side run={dumen} agent="dumen" kind={kind} />
        </div>
      </section>

      <div className="split">
        <section className="panel">
          <h2>
            {kind === "payout" ? "Payouts" : "Refunds"} · {run.info.agent} run
          </h2>
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
                      <Link href={`/?run=${run.info.id}&kind=${kind}&refund=${r.key}#trace`} scroll={false}>
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
        </section>

        <section className="panel" id="trace">
          <h2>Trace · {selected ? `${selected.ticketId} (${selected.orderId})` : "pick a refund"}</h2>
          {selected && (
            <>
              <p className="hint" style={{ marginTop: -6 }}>
                {run.info.agent === "dumen" ? "Every World Model event with the agent, the state change and the evidence. Blue = handoff between agents." : "The baseline agent's steps from its trace."}
              </p>
              <Timeline items={timelineOf(run, selected.key)} />
              {other && counterpart && (
                <>
                  <div className="vs-label">
                    vs. same ticket, {other.info.agent} <Badge r={counterpart} />
                  </div>
                  <Timeline items={timelineOf(other, counterpart.key)} />
                </>
              )}
            </>
          )}
        </section>
      </div>

      {run.info.agent === "dumen" && (
        <div className="cols2">
          <section className="panel" id="escalations">
            <h2>Escalation queue · {run.escalations.length}</h2>
            {!run.escalations.length && <p className="hint">Nothing escalated in this run.</p>}
            {run.escalations.map((c) => {
              const ck: Kind = c.kind ?? "refund";
              const entity = (ck === kind ? refunds : refundsOf(run, ck)).find((r) => r.refundKey === c.refund_key);
              return (
                <div key={c.case_id} className="case">
                  <div className="row">
                    <span className={`badge ${ck === "payout" ? "b-retried" : "b-rejected"}`}>{ck === "payout" ? "🏦 payout" : "🧾 refund"}</span>
                    <b>
                      {c.ticket_id} · {ck === "payout" ? `seller ${c.order_id}` : c.order_id}
                    </b>
                    {c.amount !== null && <span className="hint">{money(Number(c.amount))}</span>}
                    <span className="badge b-escalated">{c.decision ? `decided: ${c.decision.outcome ?? c.decision.verdict}` : "needs decision"}</span>
                    {entity && (
                      <Link href={`/?run=${run.info.id}&kind=${ck}&refund=${entity.key}#trace`} className="hint">
                        trace →
                      </Link>
                    )}
                  </div>
                  <p className="summary">{c.summary}</p>
                  <p className="hint" style={{ margin: 0 }}>
                    Summary: {c.summary_source === "model" ? "NVIDIA Nemotron" : "template (model not used)"} · Why escalated: {c.reason}
                  </p>
                  {c.last_evidence && (
                    <details>
                      <summary>evidence</summary>
                      <pre className="ev">{JSON.stringify({ state_history: c.state_history, last_evidence: c.last_evidence }, null, 2)}</pre>
                    </details>
                  )}
                  {c.decision ? (
                    <p className="hint">
                      {c.decision.verdict === "approve" ? "Approved" : "Rejected"} by a person: “{c.decision.reason}” → {c.decision.outcome}
                    </p>
                  ) : (
                    entity && <DecisionForm run={run.info.id} entity={entity.key} disabledReason={run.info.id === latest ? null : "Decisions are only possible on the newest run."} />
                  )}
                </div>
              );
            })}
          </section>

          <section className="panel">
            <h2>Memory · H-MEM lessons</h2>
            {!lessons.length && <p className="hint">No lessons recorded in this run.</p>}
            {run.summary.fresh_memory && <p className="hint">Fresh-memory run: saved lessons were ignored; everything below was learned during this run.</p>}
            {lessons.map((l) => (
              <div key={l.id} className="lesson">
                <div>{l.content}</div>
                <div className="hint">
                  {l.origin === "loaded" ? "loaded from earlier runs" : "learned this run"}
                  {l.promoted ? " · promoted to long-term" : ""} · confidence
                  <span className="meter">
                    <i style={{ width: `${Math.round((l.confidence ?? 0) * 100)}%` }} />
                  </span>
                  {(l.confidence ?? 0).toFixed(2)} · used {l.uses.length}×{l.uses.length ? `, last by ${l.uses.at(-1)!.actor} at ${new Date(l.uses.at(-1)!.ts).toLocaleTimeString("en-GB")}` : ""}
                </div>
              </div>
            ))}
          </section>
        </div>
      )}

      <footer>
        Data: <b>Zetaris</b> refund_truth · Reasoning: <b>Meterless</b> World Model + H-MEM · Model: <b>NVIDIA Nemotron</b> via Meterless Nightshift
      </footer>
    </main>
  );
}
