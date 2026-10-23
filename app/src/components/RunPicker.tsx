"use client";

import { useRouter } from "next/navigation";

export function RunPicker({ runs, current }: { runs: Array<{ id: string; label: string }>; current: string }) {
  const router = useRouter();
  return (
    <select value={current} onChange={(e) => router.push(`/?run=${encodeURIComponent(e.target.value)}`)} aria-label="Run">
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
