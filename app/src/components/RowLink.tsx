"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

// A table row that opens its trace: click anywhere on it, or Enter/Space when focused.
// The first cell still holds a real link, so middle-click and copy-link work.
export function RowLink({ href, selected, children }: { href: string; selected: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const go = () => router.push(href, { scroll: false });
  return (
    <tr
      className={`rowlink ${selected ? "sel" : ""}`}
      tabIndex={0}
      aria-selected={selected}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) return;
        go();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      {children}
    </tr>
  );
}

// Brings the trace panel to its top whenever the selected entry changes.
export function TraceTop({ id }: { id: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const card = ref.current?.closest(".card");
    if (!card) return;
    card.scrollTop = 0;
    if (first.current) {
      first.current = false;
      return;
    }
    if (card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [id]);
  return <span ref={ref} hidden />;
}
