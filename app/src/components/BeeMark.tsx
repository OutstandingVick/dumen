// Placeholder bee mark. Swap this component's SVG for the final logo; nothing else changes.
export function BeeMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label="Dumen bee">
      {/* wings */}
      <ellipse cx="17" cy="15" rx="8" ry="6" fill="#e5efff" stroke="#1b1a2e" strokeWidth="2" transform="rotate(-25 17 15)" />
      <ellipse cx="31" cy="15" rx="8" ry="6" fill="#e5efff" stroke="#1b1a2e" strokeWidth="2" transform="rotate(25 31 15)" />
      {/* body */}
      <ellipse cx="24" cy="29" rx="11" ry="13" fill="#ffd23f" stroke="#1b1a2e" strokeWidth="2.5" />
      {/* stripes */}
      <path d="M14 26 Q24 23 34 26" fill="none" stroke="#1b1a2e" strokeWidth="3.5" strokeLinecap="round" />
      <path d="M14.5 33 Q24 30 33.5 33" fill="none" stroke="#1b1a2e" strokeWidth="3.5" strokeLinecap="round" />
      {/* stinger */}
      <path d="M22 41.5 L24 46 L26 41.5" fill="#1b1a2e" />
      {/* antennae */}
      <path d="M21 17 Q18 10 15 9" fill="none" stroke="#1b1a2e" strokeWidth="2" strokeLinecap="round" />
      <path d="M27 17 Q30 10 33 9" fill="none" stroke="#1b1a2e" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
