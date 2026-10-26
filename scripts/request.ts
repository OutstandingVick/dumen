// One request through the real Dumen loop, run once from the command line (request:check uses
// this; the dashboard sends requests to the warm worker in scripts/request-worker.ts instead).
//   npx tsx scripts/request.ts --kind refund --order ORD-1028 --message "Arrived broken" [--chaos lost_response]
//   npx tsx scripts/request.ts --kind payout --seller S-02 --amount 120 [--chaos down] [--zetaris-down] [--nightshift-down]
// Prints @@RUN, @@ENTITY, @@RESULT and @@DONE lines (see request-core.ts).
import "dotenv/config";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pg from "pg";
import { runRequest, validate, type RequestParams } from "./request-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    kind: { type: "string" },
    order: { type: "string" },
    message: { type: "string" },
    seller: { type: "string" },
    amount: { type: "string" },
    chaos: { type: "string", default: "ok" },
    "zetaris-down": { type: "boolean", default: false },
    "nightshift-down": { type: "boolean", default: false },
    sample: { type: "boolean", default: false },
    "new-run": { type: "boolean", default: false },
    port: { type: "string", default: "4015" },
  },
});

const params = {
  kind: args.kind as RequestParams["kind"],
  order: args.order,
  message: args.message,
  seller: args.seller,
  amount: Number(args.amount),
  chaos: args.chaos!,
  zetarisDown: args["zetaris-down"],
  nightshiftDown: args["nightshift-down"],
  sample: args.sample,
  newRun: args["new-run"],
};
const invalid = validate(params);
if (invalid) {
  console.log(`@@DONE ${JSON.stringify({ ok: false, reason: invalid })}`);
  process.exit(1);
}

const processorUrl = `http://127.0.0.1:${args.port}`;
const processor = spawn("npx", ["tsx", "processor/server.ts", "--port", args.port!, "--mode", "naive", "--hang-ms", "5000", "--slow-ms", "1500"], { cwd: ROOT, stdio: "ignore" });
const stopProcessor = () => processor.exitCode === null && processor.kill("SIGTERM");
process.on("exit", stopProcessor);
const ordersDb = new pg.Pool({ connectionString: process.env.DATABASE_URL, statement_timeout: 10_000, max: 2 });

let ok = false;
try {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${processorUrl}/refunds/ping`, { signal: AbortSignal.timeout(300) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const setChaos = async (behaviour: string) => {
    await fetch(`${processorUrl}/_chaos/next`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ behaviour }) });
  };
  const { summaries } = await runRequest(params, { ordersDb, processorUrl, setChaos }, (line) => {
    if (line.startsWith("@@DONE ")) ok = JSON.parse(line.slice(7)).ok;
    console.log(line);
  });
  await summaries;
} finally {
  stopProcessor();
  await ordersDb.end();
}
process.exit(ok ? 0 : 1);
