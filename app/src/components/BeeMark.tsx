// The Dumen bee, redrawn as SVG from the brand logo (docs/brand/dumen-logo.png).
export function BeeMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="226 146 388 404" role="img" aria-label="Dumen">
      <defs>
        <clipPath id="dumen-body">
          <path d="M360 284 H478 C548 284 606 345 606 415 C606 472 560 548 478 548 H362 C280 548 234 472 234 415 C234 345 290 284 360 284 Z" />
        </clipPath>
      </defs>
      {/* wings */}
      <circle cx="342" cy="266" r="78" fill="#c8cfe3" />
      <circle cx="498" cy="266" r="78" fill="#c8cfe3" />
      {/* antennae */}
      <path d="M372 290 L358 182 M458 290 L480 182" stroke="#2b3a6e" strokeWidth="20" />
      <circle cx="360" cy="176" r="21" fill="#f26b2c" />
      <circle cx="480" cy="176" r="21" fill="#f26b2c" />
      {/* body + stripes */}
      <path d="M360 284 H478 C548 284 606 345 606 415 C606 472 560 548 478 548 H362 C280 548 234 472 234 415 C234 345 290 284 360 284 Z" fill="#2b3a6e" />
      <g clipPath="url(#dumen-body)" fill="#f26b2c">
        <rect x="226" y="464" width="388" height="26" />
        <rect x="226" y="512" width="388" height="27" />
      </g>
      {/* eyes: flat-topped, like a raised brow */}
      <path d="M330.7 370 H401.3 A38 38 0 1 1 330.7 370 Z" fill="#fff" />
      <path d="M438.7 370 H509.3 A38 38 0 1 1 438.7 370 Z" fill="#fff" />
      <circle cx="375" cy="394" r="16" fill="#2b3a6e" />
      <circle cx="483" cy="394" r="16" fill="#2b3a6e" />
      {/* smile */}
      <path d="M398 430 Q420 446 442 430" fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" />
    </svg>
  );
}

// Mark + "dumen" wordmark, as in the brand logo.
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <span className="logo-lockup" style={{ gap: size * 0.3 }}>
      <BeeMark size={size} />
      <span className="wordmark" style={{ fontSize: size * 0.82 }}>
        dumen
      </span>
    </span>
  );
}
