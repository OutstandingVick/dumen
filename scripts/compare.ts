// Baseline vs Dumen on the same seeds, side by side, and the Phase 3 gate.
//   npm run compare                      (seeds 42,1,7 at --lost 0.2, plus a lost 0 control)
//   npm run compare -- --seeds 42 --lost 0.3
// Reproducible by default: both agents replay the cached Nemotron intake decisions, Dumen with
// --fresh-memory, so every run of this script prints the same table.
// --live: Nemotron decides every ticket first, in parallel (scripts/decide-all.ts), then both
// agents pay on those same decisions, one after the other, against the same seeded chaos.
// Not reproducible across runs (the model can change its mind), but fair within one.
// "@@PROGRESS {...}" lines are for the dashboard.
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  allowNegative: true, // --no-control
  options: {
    seeds: { type: "string", default: "42,1,7" },
    lost: { type: "string", default: "0.2" },
    control: { type: "boolean", default: true },
    live: { type: "boolean", default: false }, // Dumen intake on live Nemotron instead of the cached decisions
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
  overpaid_orders?: Array<{ order_id: string }>;
  payouts?: {
    bank_calls: number;
    duplicate_payouts: number;
    money_lost: number;
    escalations: number;
    rejections: number;
    overpaid: string[];
    changed_account_paid: string[];
    high_value_paid: string[];
    key_payouts: Record<string, string | null>;
  };
  run_id: string;
}

const OUT = join(ROOT, "logs", `compare-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(OUT, { recursive: true });
const progress = (p: Record<string, unknown>) => console.log(`@@PROGRESS ${JSON.stringify(p)}`);

// Run a repo script; its @@PROGRESS lines are passed on, tagged with `tag`.
function runScript(script: string, argv: string[], env: Record<string, string>, tag: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["tsx", script, ...argv], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let pending = "";
    p.stdout.on("data", (d) => {
      out += d;
      pending += d;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) if (l.startsWith("@@PROGRESS ")) progress({ ...tag, ...JSON.parse(l.slice(11)) });
    });
    p.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => p.kill("SIGTERM"), 10 * 60_000);
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${script} failed (exit ${code}): ${(err || out).slice(-500)}`));
      resolve(out);
    });
  });
}

// Live: all intake decisions first, in parallel; both agents then pay on the same ones.
async function decideAll(): Promise<string> {
  const file = join(OUT, "intake.json");
  const out = await runScript("scripts/decide-all.ts", ["--out", file, "--concurrency", "6"], { SAMPLE_MODE: "false" }, { agent: "nemotron" });
  console.log(out.split("\n").filter((l) => l && !l.startsWith("@@")).map((l) => `  ${l}`).join("\n"));
  return file;
}

async function runChaos(agent: "baseline" | "dumen", seed: string, lost: string, intakeFile: string | null): Promise<Result> {
  const intake = intakeFile ? ["--intake-file", intakeFile] : ["--cached-intake"];
  const extra = [...intake, ...(agent === "dumen" ? ["--fresh-memory", "--concurrency", "1"] : [])];
  // Live: Nemotron writes the escalation summaries (and decides any ticket it failed on up front).
  const out = await runScript("scripts/chaos.ts", ["--agent", agent, "--seed", seed, "--lost", lost, "--quiet", ...extra], { SAMPLE_MODE: intakeFile ? "false" : "true" }, { agent });
  const line = out.split("\n").find((l) => l.startsWith("@@RESULT "));
  if (!line) throw new Error(`${agent} seed ${seed}: no result line`);
  return JSON.parse(line.slice("@@RESULT ".length));
}

const runs: Array<[string, string]> = args.seeds!.split(",").map((s) => [s.trim(), args.lost!]);
if (args.control) runs.push([runs[0][0], "0"]);

const t0 = Date.now();
let intakeFile: string | null = null;
if (args.live) {
  console.log("Nemotron deciding every ticket (concurrency 6)…");
  const d0 = Date.now();
  intakeFile = await decideAll();
  console.log(`  decisions ready in ${((Date.now() - d0) / 1000).toFixed(1)}s`);
}
const rows: Array<{ seed: string; lost: string; baseline: Result; dumen: Result }> = [];
for (const [seed, lost] of runs) {
  console.log(`seed ${seed} lost ${lost}: baseline…`);
  const baseline = await runChaos("baseline", seed, lost, intakeFile);
  console.log(`  baseline ${(baseline.duration_ms / 1000).toFixed(1)}s · dumen…`);
  const dumen = await runChaos("dumen", seed, lost, intakeFile);
  console.log(`  dumen ${(dumen.duration_ms / 1000).toFixed(1)}s`);
  rows.push({ seed, lost, baseline, dumen });
}
console.log(`\nTotal run time: ${((Date.now() - t0) / 1000).toFixed(1)}s (${args.live ? "live" : "cached"})`);

const pad = (s: string | number, n: number) => String(s).padStart(n);
const money = (n: number) => n.toFixed(2);
const header = "| Seed | Lost | Agent | Refund calls | Double refunds | Overpaid | Refund $ lost | Bank calls | Duplicate payouts | Risky payouts sent | Payout $ lost | Escalations | Rejections |";
const sep = "|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const md = [header, sep];
const risky = (x: Result) => (x.payouts ? x.payouts.changed_account_paid.length + x.payouts.high_value_paid.length : 0);
const esc = (x: Result) => x.escalations + (x.payouts?.escalations ?? 0);
const rej = (x: Result) => x.rejections + (x.payouts?.rejections ?? 0);
for (const r of rows) {
  for (const [name, x] of [["baseline", r.baseline], ["dumen", r.dumen]] as const) {
    md.push(
      `| ${r.seed} | ${r.lost} | ${name} | ${x.processor_calls} | ${x.double_refunds} | ${x.overpaid_orders?.length ?? 0} | ${money(x.money_lost)} | ${x.payouts?.bank_calls ?? "-"} | ${x.payouts?.duplicate_payouts ?? "-"} | ${risky(x)} | ${money(x.payouts?.money_lost ?? 0)} | ${esc(x)} | ${rej(x)} |`,
    );
  }
}

console.log(
  `\n${"".padEnd(21)}${"── refunds ──".padStart(30)}   ${"── payouts ──".padStart(34)}\n${"seed".padEnd(5)}${"lost".padEnd(6)}${"agent".padEnd(10)}${pad("calls", 6)}${pad("doubles", 9)}${pad("overpaid", 9)}${pad("lost $", 10)}   ${pad("calls", 6)}${pad("dupes", 7)}${pad("risky", 7)}${pad("lost $", 10)}${pad("escal.", 8)}${pad("reject", 8)}`,
);
for (const r of rows) {
  for (const [name, x] of [["baseline", r.baseline], ["dumen", r.dumen]] as const) {
    console.log(
      `${r.seed.padEnd(5)}${r.lost.padEnd(6)}${name.padEnd(10)}${pad(x.processor_calls, 6)}${pad(x.double_refunds, 9)}${pad(x.overpaid_orders?.length ?? 0, 9)}${pad(money(x.money_lost), 10)}   ${pad(x.payouts?.bank_calls ?? "-", 6)}${pad(x.payouts?.duplicate_payouts ?? "-", 7)}${pad(risky(x), 7)}${pad(money(x.payouts?.money_lost ?? 0), 10)}${pad(esc(x), 8)}${pad(rej(x), 8)}`,
    );
  }
}

// The Phase 3 gate.
const gate = [
  { name: "Dumen: 0 double refunds on every run", ok: rows.every((r) => r.dumen.double_refunds === 0) },
  { name: "Baseline: double refunds on every lost>0 run", ok: rows.filter((r) => Number(r.lost) > 0).every((r) => r.baseline.double_refunds > 0) },
  { name: "T-020 (malicious re-send) rejected", ok: rows.every((r) => r.dumen.key_tickets?.["T-020"] === "REJECTED") },
  { name: "T-017/T-018 (paid behind pending) not repaid", ok: rows.every((r) => r.dumen.key_tickets?.["T-017"] === "REJECTED" && r.dumen.key_tickets?.["T-018"] === "REJECTED") },
  { name: "T-021 (ORD-1008 conflict) escalated", ok: rows.every((r) => r.dumen.key_tickets?.["T-021"] === "ESCALATED") },
  { name: "T-022 (asks for 2× the order) never overpaid", ok: rows.every((r) => r.dumen.key_tickets?.["T-022"] === "ESCALATED" && (r.dumen.overpaid_orders?.length ?? 0) === 0) },
  { name: "Dumen: 0 duplicate payouts on every run", ok: rows.every((r) => r.dumen.payouts?.duplicate_payouts === 0) },
  { name: "PO-0004 (bank account changed <24h) escalated, not paid", ok: rows.every((r) => r.dumen.payouts?.key_payouts["PO-0004"] === "ESCALATED" && !r.dumen.payouts.changed_account_paid.length) },
  { name: "PO-0007 (above threshold) waits for a human, not paid", ok: rows.every((r) => r.dumen.payouts?.key_payouts["PO-0007"] === "ESCALATED" && !r.dumen.payouts.high_value_paid.length) },
  { name: "PO-0006 (more than earned) never overpaid", ok: rows.every((r) => r.dumen.payouts?.key_payouts["PO-0006"] === "ESCALATED" && !r.dumen.payouts.overpaid.length) },
];
console.log("\nGate:");
for (const g of gate) console.log(`  ${g.ok ? "PASS" : "FAIL"}  ${g.name}`);

const dir = OUT;
writeFileSync(join(dir, "compare.json"), JSON.stringify({ rows, gate }, null, 2) + "\n");
writeFileSync(join(dir, "compare.md"), md.join("\n") + "\n\n" + gate.map((g) => `- ${g.ok ? "PASS" : "FAIL"} ${g.name}`).join("\n") + "\n");
console.log(`\nSaved: logs/${dir.split("/logs/")[1]}/compare.md`);
process.exit(gate.every((g) => g.ok) ? 0 : 1);
