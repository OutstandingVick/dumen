import { runLabel, type View } from "@/lib/view";
import { CompareButton } from "./CompareButton";
import { RunPicker } from "./RunPicker";

// Page title, run picker and the comparison CTA, shared by every page.
export function TopBar({ v, section, title, base, notices = true }: { v: View; section: string; title: string; base: string; notices?: boolean }) {
  const s = v.run.summary;
  const f = s.failures;
  return (
    <>
      <div className="topbar">
        <div className="card title">
          <span className="label">{section}</span>
          <h1>{title}</h1>
          <div className="row">
            <RunPicker runs={v.runs.map((r) => ({ id: r.id, label: runLabel(r) }))} current={v.run.info.id} base={base} kind={v.kind} />
          </div>
        </div>
        <div className="card compare">
          <CompareButton key={v.run.info.id} defaultSeed={v.run.info.interactive ? 42 : s.seed} defaultLost={v.run.info.interactive ? 0.2 : s.rates.lost} />
        </div>
      </div>
      {f?.zetaris_down && (
        <div className="banner bad">
          <b>Zetaris was unreachable in this run.</b> The Verifier couldn&apos;t check refund_truth or payout_truth, so everything it couldn&apos;t verify was escalated and nothing was paid on a guess.
        </div>
      )}
      {f?.nightshift_down && (
        <div className="banner bad">
          <b>Nightshift (the model) was unreachable in this run.</b> Intake had no model decision, so those tickets were escalated instead of refunded.
        </div>
      )}
      {notices && v.run.info.id !== v.latest && v.openCases.length > 0 && !v.run.info.demo && (
        <div className="banner info">This is an older run. A later run has reset the databases, so its escalations can be read but not decided.</div>
      )}
    </>
  );
}
