// Thin line icons (24×24, 1.5px stroke), drawn for Dumen.
const PATHS: Record<string, string> = {
  overview: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  request: "M12 5v14M5 12h14",
  escalation: "M5 21V4M5 4h11l-2 4 2 4H5",
  memory: "M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 3 3 3 0 0 0 2 3v1a3 3 0 0 0 3 3h1V4zM15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 3 3 3 0 0 1-2 3v1a3 3 0 0 1-3 3h-1V4z",
  intake: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  executor: "M13 3 5 14h6l-1 7 8-11h-6z",
  verifier: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  human: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  dumen: "M4 13l3-8h10l3 8v6H4zM4 13h5l1 2h4l1-2h5",
  payouts: "M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  baseline: "M7 8h10v10H7zM10 4v4M14 4v4M10 18v2M14 18v2M4 11h3M4 15h3M17 11h3M17 15h3",
  double: "M8 8h11v11H8zM5 16V5h11",
  risk: "M12 4 2 20h20zM12 10v4M12 17v.5",
  calls: "M4 12h3l2-5 3 10 2-5h6",
  reject: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
  coin: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v8M9.5 10.5c0-1 1-1.5 2.5-1.5s2.5.5 2.5 1.5-1 1.5-2.5 1.5-2.5.5-2.5 1.5 1 1.5 2.5 1.5 2.5-.5 2.5-1.5",
  shield: "M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6zM9 12l2 2 4-4",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? PATHS.dumen} />
    </svg>
  );
}

// An icon in a small square box, like the spec tiles in the reference.
export function IconBox({ name, size = 34, tone }: { name: string; size?: number; tone?: "orange" | "dark" }) {
  return (
    <span className={`iconbox${tone ? ` ${tone}` : ""}`} style={{ width: size, height: size }}>
      <Icon name={name} size={Math.round(size * 0.52)} />
    </span>
  );
}
