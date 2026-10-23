// Baseline vs Dumen on the same seeds, side by side, and the Phase 3 gate.
//   npm run compare                      (seeds 42,1,7 at --lost 0.2, plus a lost 0 control)
//   npm run compare -- --seeds 42 --lost 0.3
// Reproducible: the baseline runs in sample mode, Dumen replays cached Nemotron intake
// decisions with --fresh-memory, so every run of this script prints the same table.
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    seeds: { type: "string", default: "42,1,7" },
    lost: { type: "string", default: "0.2" },
    control: { type: "boolean", default: true },
  },
});

interface Result {
  agent: string;
  seed: number;
  rates: { lost: number };
  duration_ms: number;
  processor_calls: number;
  double_refunds: number;
  money_lost: number;
  escalations: number;
  rejections: number;
  total_refunded: number;
  key_tickets?: Record<string, string | null>;
  run_id: string;
}

function runChaos(agent: "baseline" | "dumen", seed: string, lost: string): Promise<Result> {
  const extra = agent === "dumen" ? ["--cached-intake", "--fresh-memory"] : [];
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", "scripts/chaos.ts", "--agent", agent, "--seed", seed, "--lost", lost, "--quiet", ...extra], {
      cwd: ROOT,
      env: { ...process.env, SAMPLE_MODE: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), 10 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      const line = out.split("\n").find((l) => l.startsWith("@@RESULT "));
      if (code !== 0 || !line) return reject(new Error(`${agent} seed ${seed} failed (exit ${code}): ${err.slice(-500)}`));
      resolve(JSON.parse(line.slice("@@RESULT ".length)));
    });
  });
}

const runs: Array<[string, string]> = args.seeds!.split(",").map((s) => [s.trim(), args.lost!]);
if (args.control) runs.push([runs[0][0], "0"]);

const rows: Array<{ seed: string; lost: string; baseline: Result; dumen: Result }> = [];
for (const [seed, lost] of runs) {
  process.stdout.write(`seed ${seed} lost ${lost}: baseline…`);
  const baseline = await runChaos("baseline", seed, lost);
  process.stdout.write(` dumen…`);
  const dumen = await runChaos("dumen", seed, lost);
  console.log(` done (${((baseline.duration_ms + dumen.duration_ms) / 1000).toFixed(0)}s)`);
  rows.push({ seed, lost, baseline, dumen });
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const money = (n: number) => n.toFixed(2);
const header = "| Seed | Lost | Agent | Processor calls | Double refunds | Money lost | Escalations | Rejections |";
const sep = "|---|---|---|---|---|---|---|---|";
const md = [header, sep];
for (const r of rows) {
  for (const [name, x] of [["baseline", r.baseline], ["dumen", r.dumen]] as const) {
    md.push(`| ${r.seed} | ${r.lost} | ${name} | ${x.processor_calls} | ${x.double_refunds} | ${money(x.money_lost)} | ${x.escalations} | ${x.rejections} |`);
  }
}

console.log(`\n${"seed".padEnd(5)}${"lost".padEnd(6)}${"agent".padEnd(10)}${pad("calls", 6)}${pad("doubles", 9)}${pad("lost $", 10)}${pad("escal.", 8)}${pad("reject", 8)}`);
for (const r of rows) {
  for (const [name, x] of [["baseline", r.baseline], ["dumen", r.dumen]] as const) {
    console.log(`${r.seed.padEnd(5)}${r.lost.padEnd(6)}${name.padEnd(10)}${pad(x.processor_calls, 6)}${pad(x.double_refunds, 9)}${pad(money(x.money_lost), 10)}${pad(x.escalations, 8)}${pad(x.rejections, 8)}`);
  }
}

// The Phase 3 gate.
const gate = [
  { name: "Dumen: 0 double refunds on every run", ok: rows.every((r) => r.dumen.double_refunds === 0) },
  { name: "Baseline: double refunds on every lost>0 run", ok: rows.filter((r) => Number(r.lost) > 0).every((r) => r.baseline.double_refunds > 0) },
  { name: "T-020 (malicious re-send) rejected", ok: rows.every((r) => r.dumen.key_tickets?.["T-020"] === "REJECTED") },
  { name: "T-017/T-018 (paid behind pending) not repaid", ok: rows.every((r) => r.dumen.key_tickets?.["T-017"] === "REJECTED" && r.dumen.key_tickets?.["T-018"] === "REJECTED") },
  { name: "T-021 (ORD-1008 conflict) escalated", ok: rows.every((r) => r.dumen.key_tickets?.["T-021"] === "ESCALATED") },
];
console.log("\nGate:");
for (const g of gate) console.log(`  ${g.ok ? "PASS" : "FAIL"}  ${g.name}`);

const dir = join(ROOT, "logs", `compare-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "compare.json"), JSON.stringify({ rows, gate }, null, 2) + "\n");
writeFileSync(join(dir, "compare.md"), md.join("\n") + "\n\n" + gate.map((g) => `- ${g.ok ? "PASS" : "FAIL"} ${g.name}`).join("\n") + "\n");
console.log(`\nSaved: logs/${dir.split("/logs/")[1]}/compare.md`);
process.exit(gate.every((g) => g.ok) ? 0 : 1);
