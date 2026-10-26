import Link from "next/link";
import { Crew } from "@/components/Agent";
import { Logo } from "@/components/BeeMark";
import { CountUp } from "@/components/CountUp";
import { Icon, IconBox } from "@/components/Icon";
import { TopBar } from "@/components/TopBar";
import type { Run } from "@/lib/runs";
import { getView, money, type SearchParams, type View } from "@/lib/view";

export const dynamic = "force-dynamic";

const money0 = (n: number) => Math.round(n).toLocaleString("en-US");
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
        <Logo size={64} />
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
          {/* The map lives in its own band; the route ends at the pin, above the text. */}
          <div className="routemap" aria-hidden>
            <svg className="map" viewBox="0 0 300 240" preserveAspectRatio="xMidYMid slice">
              {[
                [18, 20, 64, 70], [96, 8, 52, 56], [190, 24, 80, 58], [28, 120, 66, 60], [200, 110, 74, 70], [104, 96, 40, 40], [226, 196, 56, 40], [20, 200, 60, 36],
              ].map(([x, y, w, h], i) => (
                <rect key={i} x={x} y={y} width={w} height={h} rx="4" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.10)" />
              ))}
              <path d="M160 0 Q172 50 168 90 Q162 140 176 170 Q186 196 150 222" fill="none" stroke="#ff6a1a" strokeWidth="9" strokeLinecap="round" />
            </svg>
            <div className="pin">
              <Icon name="shield" size={18} />
            </div>
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
                <i className="sw-base" />
                Baseline
              </span>
              <span>
                <i className="sw-dumen" />
                Dumen
              </span>
            </div>
          </div>
          <span className="hint">Refunds + payouts paid beyond what was owed</span>
          <div className="groups">
            {chart.map((c) => (
              <div key={`${c.seed}-${c.lost}`} className="group">
                <div className="pair">
                  <div className="col">
                    <span className="val">{money0(c.baseline)}</span>
                    <div className="bar base" style={{ height: `max(3px, calc((100% - 22px) * ${c.baseline / maxLost}))` }} />
                  </div>
                  <div className="col">
                    <span className="val dumen">{money0(c.dumen)}</span>
                    <div className="bar dumen" style={{ height: `max(3px, calc((100% - 22px) * ${c.dumen / maxLost}))` }} />
                  </div>
                </div>
                <span className="glabel">{c.lost === 0 ? "No loss" : `Seed ${c.seed}`}</span>
              </div>
            ))}
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
