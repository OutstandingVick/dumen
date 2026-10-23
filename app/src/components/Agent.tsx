// The crew: one look per agent, used in the crew strip and on every trace event.
export const AGENTS: Record<string, { emoji: string; name: string; role: string; color: string }> = {
  intake: { emoji: "🧾", name: "Intake", role: "reads the ticket · Nemotron", color: "var(--sky)" },
  executor: { emoji: "⚡", name: "Executor", role: "calls the processor · code", color: "var(--tangerine)" },
  verifier: { emoji: "🔍", name: "Verifier", role: "checks Zetaris · code, no LLM", color: "var(--mint)" },
  escalation: { emoji: "🙋", name: "Escalation", role: "hands it to a human · Nemotron", color: "var(--grape)" },
  human: { emoji: "👤", name: "You", role: "approve or reject", color: "var(--ink)" },
  dumen: { emoji: "📥", name: "Dumen", role: "receives the ticket", color: "var(--muted)" },
  baseline: { emoji: "🤖", name: "Baseline", role: "retries from memory", color: "var(--cherry)" },
};

export function AgentAvatar({ id, size = 28 }: { id: string; size?: number }) {
  const a = AGENTS[id] ?? { emoji: "•", name: id, color: "var(--muted)" };
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.52, borderColor: a.color, background: `color-mix(in srgb, ${a.color} 14%, white)` }} title={a.name} aria-hidden>
      {a.emoji}
    </span>
  );
}

export function Crew() {
  return (
    <div className="crew">
      {["intake", "executor", "verifier", "escalation", "human"].map((id) => (
        <div key={id} className="crew-member">
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
