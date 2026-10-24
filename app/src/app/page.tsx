import Link from "next/link";
import { Crew } from "@/components/Agent";
import { BeeMark } from "@/components/BeeMark";
import { CountUp } from "@/components/CountUp";
import { Icon, IconBox } from "@/components/Icon";
import { TopBar } from "@/components/TopBar";
import type { Run } from "@/lib/runs";
import { getView, money, type SearchParams, type View } from "@/lib/view";

export const dynamic = "force-dynamic";

const lostOf = (r: Run) => r.summary.money_lost + (r.summary.payouts?.money_lost ?? 0);
const twiceOf = (r: Run) => r.summary.double_refunds + (r.summary.payouts?.duplicate_payouts ?? 0);
const riskyOf = (r: Run) => {
  const p = r.summary.payouts;
  return (r.summary.overpaid_orders?.length ?? 0) + (p ? p.changed_account_paid.length + p.high_value_paid.length + p.overpaid.length : 0);
};

// One agent as a "vehicle" card: visual tile, spec grid, code line, footer with a CTA slab.
function AgentCard({ v, run, agent }: { v: View; run: Run | null; agent: "baseline" | "dumen" }) {
  const name = agent === "dumen" ? "Dumen" : "Baseline agent";
  if (!run) {
    return (
      <div className="card agentcard">
        <div className="visual">
          <span className="hint">No {agent} run for this seed yet</span>
        </div>
        <div className="body" style={{ paddingBottom: 20 }}>
          <h2>{name}</h2>
          <p className="hint" style={{ margin: 0 }}>Use “Run comparison” to create one.</p>
        </div>
      </div>
    );
  }
  const s = run.summary;
  const lost = lostOf(run);
  const twice = twiceOf(run);
  const risky = riskyOf(run);
  const escalations = (s.escalations ?? 0) + (s.payouts?.escalations ?? 0);
  return (
    <div className="card agentcard">
      <div className="visual">
        <span className="label cap">paid beyond what was owed</span>
        <div className={`amount ${lost > 0 ? "bad" : "good"}`}>
          <CountUp value={lost} />
        </div>
        <span className={`stamp ${lost > 0 ? "bad" : "good"}`}>{lost > 0 ? (twice ? `PAID ×2 · ${twice}` : "OVERPAID") : "VERIFIED ✓"}</span>
      </div>
      <div className="body">
        <h2>{name}</h2>
        <div className="specs">
          <div className={`spec ${s.double_refunds ? "bad" : "good"}`}>
            <IconBox name="double" />
            <div>
              <b>{s.double_refunds}</b>
              <span>Double refunds</span>
            </div>
          </div>
          <div className={`spec ${s.payouts?.duplicate_payouts ? "bad" : "good"}`}>
            <IconBox name="payouts" />
            <div>
              <b>{s.payouts?.duplicate_payouts ?? "–"}</b>
              <span>Duplicate payouts</span>
            </div>
          </div>
          <div className={`spec ${risky ? "bad" : "good"}`}>
            <IconBox name="risk" />
            <div>
              <b>{risky}</b>
              <span>Overpaid or unchecked</span>
            </div>
          </div>
          <div className="spec">
            <IconBox name="calls" />
            <div>
              <b>
                {s.processor_calls}
                {s.payouts ? ` + ${s.payouts.bank_calls}` : ""}
              </b>
              <span>Processor + bank calls</span>
            </div>
          </div>
        </div>
        <div className="meta">
          <span className="code">({agent === "dumen" ? "DMN" : "BSL"})</span>
          <p>
            {agent === "dumen"
              ? "Treats “I don't know if it was paid” as its own state, and checks Zetaris before any retry or any amount above what's owed."
              : "Retries from memory: no answer means “didn't happen”, so it pays again. Pays whatever amount it decides."}
          </p>
          <span className="label">
            seed {s.seed} // {s.rates.lost}
          </span>
          <span className="label" style={{ textAlign: "right" }}>
            {s.tickets_processed} tickets / {s.payouts?.payouts ?? 0} payouts
          </span>
        </div>
      </div>
      <div className="foot">
        <div className="price">
          <b>{escalations}</b>
          <small>
            CASES FOR
            <br />A PERSON
          </small>
        </div>
        <span className="plus">
          <Icon name="plus" size={14} />
        </span>
        <Link href={`/activity?run=${run.info.id}`}>View trace</Link>
      </div>
    </div>
  );
}

export default async function Overview({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const v = getView(await searchParams);
  if (!v) {
    return (
      <div className="card empty">
        <BeeMark size={56} />
        <h1 style={{ margin: "10px 0 6px" }}>No runs yet.</h1>
        <p className="hint">Create one from the repo folder:</p>
        <pre>{`docker compose up -d --wait
npm run compare`}</pre>
        <p className="hint">
          or process a single request in <Link href="/requests">New request</Link>.
        </p>
      </div>
    );
  }
  const { baseline, dumen, chart } = v;
  const maxLost = Math.max(1, ...chart.map((c) => c.baseline));
  const dumenTwice = dumen ? twiceOf(dumen) : 0;
  const baseTwice = baseline ? twiceOf(baseline) : 0;
  const PRESETS: Array<[string, string]> = [
    ["lost", "Lost reply"],
    ["slow", "Slow confirm"],
    ["fail", "Processor fail"],
    ["down", "Processor down"],
    ["zetaris", "Zetaris down"],
    ["nightshift", "Nightshift down"],
    ["paid", "Already paid"],
    ["overask", "Asks for double"],
    ["account", "Bank account changed"],
    ["threshold", "Above 2,500"],
    ["overearned", "More than earned"],
  ];

  return (
    <>
      <TopBar v={v} section="Overview" title="Paid once. Only what’s owed." base="/" />

      <div className="bento">
        <AgentCard v={v} run={baseline} agent="baseline" />
        <AgentCard v={v} run={dumen} agent="dumen" />

        <div className="card dark route">
          <svg className="map" viewBox="0 0 300 520" preserveAspectRatio="xMidYMid slice" aria-hidden>
            {[
              [20, 40, 60, 90], [100, 20, 50, 70], [190, 50, 80, 60], [30, 160, 70, 60], [200, 140, 70, 90],
              [20, 260, 60, 80], [210, 270, 70, 60], [40, 380, 60, 50], [200, 360, 80, 70], [110, 110, 40, 40],
            ].map(([x, y, w, h], i) => (
              <rect key={i} x={x} y={y} width={w} height={h} rx="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.10)" />
            ))}
            <path d="M150 520 L150 400 Q150 360 175 330 L180 250 Q185 200 165 160 L160 0" fill="none" stroke="#ff6a1a" strokeWidth="10" strokeLinecap="round" opacity="0.9" />
          </svg>
          <div className="pin">
            <Icon name="shield" size={18} />
          </div>
          <div className="big">{dumenTwice}</div>
          <div className="sub">times Dumen paid twice in this run</div>
          <Link className="tile" href={`/activity?run=${baseline?.info.id ?? v.run.info.id}`}>
            <div className="label">Same chaos, baseline</div>
            <div className="between">
              <span>
                Paid twice {baseTwice}× · lost {money(baseline ? lostOf(baseline) : 0)}
              </span>
              <Icon name="arrow" />
            </div>
          </Link>
          {v.openCases.length > 0 && (
            <Link className="tile" href={`/escalations${v.qs()}`}>
              <div className="label">Needs your decision</div>
              <div className="between">
                <span>
                  {v.openCases.length} escalated case{v.openCases.length === 1 ? "" : "s"}
                </span>
                <Icon name="arrow" />
              </div>
            </Link>
          )}
        </div>

        <div className="card">
          <div className="between">
            <h3>
              Money lost by seed <span className="label">(per run)</span>
            </h3>
            <div className="legend">
              <span>
                <i style={{ border: "1px solid var(--ink)" }} />
                baseline
              </span>
              <span>
                <i style={{ background: "var(--orange)" }} />
                Dumen
              </span>
            </div>
          </div>
          <span className="hint">Refunds + payouts paid beyond what was owed</span>
          <div className="chart">
            {chart.flatMap((c) => [
              <div key={`b${c.seed}${c.lost}`} className="col">
                <div className="bar" style={{ height: `${Math.max(14, (c.baseline / maxLost) * 100)}%` }}>
                  {Math.round(c.baseline)}
                </div>
              </div>,
              <div key={`d${c.seed}${c.lost}`} className="col">
                <div className={`bar ${c.dumen ? "" : "zero"}`} style={c.dumen ? { height: `${(c.dumen / maxLost) * 100}%` } : undefined}>
                  {Math.round(c.dumen)}
                </div>
              </div>,
            ])}
          </div>
          <div className="chart-axis">
            {chart.flatMap((c) => [
              <span key={`ab${c.seed}${c.lost}`}>s{c.seed}</span>,
              <span key={`ad${c.seed}${c.lost}`}>{c.lost === 0 ? "ctrl" : `·${String(c.lost).replace("0.", ".")}`}</span>,
            ])}
          </div>
        </div>

        <div className="card">
          <h3>Failure modes</h3>
          <span className="hint">Try one: it opens New request with the scenario set up.</span>
          <div className="chips" style={{ marginTop: 14 }}>
            {PRESETS.map(([id, label], i) => (
              <Link key={id} className={`chip ${i === 0 ? "on" : ""}`} href={`/requests?preset=${id}`}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="between" style={{ marginBottom: 14 }}>
          <h3>The crew</h3>
          <span className="label">every step is a World Model event</span>
        </div>
        <Crew />
      </div>
    </>
  );
}
