"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Logo } from "./BeeMark";
import { Icon } from "./Icon";

const NAV = [
  { href: "/", label: "Overview", icon: "overview" },
  { href: "/activity", label: "Activity & traces", icon: "activity" },
  { href: "/requests", label: "New request", icon: "request" },
  { href: "/escalations", label: "Escalations", icon: "escalation" },
  { href: "/memory", label: "Memory", icon: "memory" },
];

// Navigation keeps the selected run and Refunds/Payouts choice across pages.
export function Sidebar({ waiting }: { waiting: number }) {
  const path = usePathname();
  const sp = useSearchParams();
  const keep = new URLSearchParams();
  for (const k of ["run", "kind"]) {
    const v = sp.get(k);
    if (v) keep.set(k, v);
  }
  const qs = keep.toString() ? `?${keep}` : "";
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo size={36} />
        <small>refund &amp; payout control room</small>
      </div>
      <nav className="nav">
        {NAV.map((n) => (
          <Link key={n.href} href={`${n.href}${qs}`} className={path === n.href ? "on" : ""}>
            <Icon name={n.icon} />
            {n.label}
            {n.href === "/escalations" && waiting > 0 && <span className="count">{waiting}</span>}
          </Link>
        ))}
      </nav>
      <div className="foot">
        Refund and payout agents remember what they did, not whether it worked. <b>Dumen checks before it pays.</b>
        <br />
        <br />
        Data: <b>Zetaris</b> · Reasoning: <b>Meterless</b> World Model + H-MEM · Model: <b>NVIDIA Nemotron</b> via Nightshift
      </div>
    </aside>
  );
}
