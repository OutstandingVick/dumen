// Nemotron's escalation summaries for a finished run, written after the run so they never hold
// up the payment phase. chaos.ts starts this detached; each case shows its template summary
// until the model's replaces it.
//   npx tsx scripts/summaries.ts --run <runId>
import "dotenv/config";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fillSummaries, type PendingSummary } from "../agents/escalation.js";
import { Trace } from "../runtime/trace.js";

const { values: args } = parseArgs({ options: { run: { type: "string" } } });
if (!args.run || !/^[\w-]+$/.test(args.run)) throw new Error("--run <runId> is required");
const trace = new Trace(args.run);
const file = join(dirname(trace.path), "pending-summaries.json");
if (existsSync(file)) {
  const jobs: PendingSummary[] = JSON.parse(readFileSync(file, "utf8"));
  const t0 = Date.now();
  const r = await fillSummaries(trace, jobs, 6);
  rmSync(file);
  console.log(`summaries: ${r.model} from the model, ${r.template} template (${Date.now() - t0}ms)`);
}
