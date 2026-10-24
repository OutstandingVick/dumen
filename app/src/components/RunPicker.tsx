"use client";

import { useRouter } from "next/navigation";

export function RunPicker({ runs, current, base = "/", kind }: { runs: Array<{ id: string; label: string }>; current: string; base?: string; kind?: string }) {
  const router = useRouter();
  return (
    <select value={current} onChange={(e) => router.push(`${base}?run=${encodeURIComponent(e.target.value)}${kind ? `&kind=${kind}` : ""}`)} aria-label="Run">
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
