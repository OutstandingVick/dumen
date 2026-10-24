import { IconBox } from "./Icon";

// The crew: one look per agent, used in the crew strip and on every trace event.
export const AGENTS: Record<string, { name: string; role: string }> = {
  intake: { name: "Intake", role: "Reads the ticket · Nemotron" },
  executor: { name: "Executor", role: "Calls the processor · code" },
  verifier: { name: "Verifier", role: "Checks Zetaris · code, no LLM" },
  escalation: { name: "Escalation", role: "Hands it to a person · Nemotron" },
  human: { name: "You", role: "Approve or reject" },
  dumen: { name: "Dumen", role: "Receives the ticket" },
  payouts: { name: "Payouts", role: "Schedules seller payouts" },
  baseline: { name: "Baseline", role: "Retries from memory" },
};

export function AgentAvatar({ id, size = 30 }: { id: string; size?: number }) {
  return <IconBox name={AGENTS[id] ? id : "dumen"} size={size} tone={id === "human" ? "dark" : id === "baseline" ? "orange" : undefined} />;
}

export function Crew() {
  return (
    <div className="crew">
      {["intake", "executor", "verifier", "escalation", "human"].map((id) => (
        <div key={id} className="spec">
          <AgentAvatar id={id} size={34} />
          <div>
            <b>{AGENTS[id].name}</b>
            <span>{AGENTS[id].role}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
