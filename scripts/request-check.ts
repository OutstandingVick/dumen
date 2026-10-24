// The dashboard's "New request" path, driven exactly as the dashboard drives it (one
// scripts/request.ts process per request). Sample-mode intake, fresh data. npm run request:check
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

function request(flags: string[]): any {
  const r = spawnSync("npx", ["tsx", "scripts/request.ts", "--sample", "--port", "4016", ...flags], { cwd: ROOT, encoding: "utf8", timeout: 180_000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith("@@DONE "));
  if (!line) throw new Error(`request ${flags.join(" ")} printed no result: ${r.stderr.slice(-300)}`);
  return JSON.parse(line.slice("@@DONE ".length));
}

spawnSync("npx", ["tsx", "scripts/seed.ts"], { cwd: ROOT, timeout: 60_000 });

const lost = request(["--new-run", "--kind", "refund", "--order", "ORD-1028", "--message", "Arrived broken", "--chaos", "lost_response"]);
check("refund, lost confirmation: verified, not re-sent, paid exactly once", lost.state === "CONFIRMED" && lost.executions === 1 && lost.success_count === 1, `${lost.state}, ${lost.executions} call, paid ${lost.success_count}×`);

const again = request(["--kind", "refund", "--order", "ORD-1028", "--message", "My refund failed, send it again", "--chaos", "ok"]);
check("same order asked again: rejected as already paid, nothing new sent", again.state === "REJECTED" && again.executions === 0, `${again.state}, ${again.executions} calls`);

const pLost = request(["--kind", "payout", "--seller", "S-02", "--amount", "120", "--chaos", "lost_response"]);
check("payout, lost confirmation: paid exactly once", pLost.state === "CONFIRMED" && pLost.success_count === 1, `${pLost.state}, ${pLost.executions} call(s), paid ${pLost.success_count}×`);

const pDown = request(["--kind", "payout", "--seller", "S-03", "--amount", "80", "--chaos", "down"]);
check("payout, bank down on first call: verified not paid, retried same key, paid once", pDown.state === "CONFIRMED" && pDown.executions === 2 && pDown.success_count === 1, `${pDown.state}, ${pDown.executions} calls, paid ${pDown.success_count}×`);

const zDown = request(["--kind", "refund", "--order", "ORD-1029", "--message", "Wrong colour", "--chaos", "lost_response", "--zetaris-down"]);
check("Zetaris down: escalated before any payment", zDown.state === "ESCALATED" && zDown.executions === 0 && zDown.success_count === 0, `${zDown.state}, paid ${zDown.success_count}×`);

const nDown = request(["--kind", "refund", "--order", "ORD-1030", "--message", "Never arrived", "--nightshift-down"]);
check("Nightshift down: no model decision, escalated, nothing paid", nDown.state === "ESCALATED" && nDown.success_count === 0, `${nDown.state}, paid ${nDown.success_count}×`);

const runIds = new Set([lost, again, pLost, pDown, zDown, nDown].map((r) => r.run));
check("all requests landed in one interactive run", runIds.size === 1, [...runIds].join(", "));

console.log(`\n${pass} passed, ${fail} failed · logs/${lost.run}/`);
process.exit(fail ? 1 : 0);
