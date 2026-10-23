// Does refund_truth in Zetaris see processor_log changes immediately? npm run freshness:check
// Inserts one test row, reads the view, deletes the row, reads again.
import "dotenv/config";
import pg from "pg";
import { getRefundTruth } from "../runtime/zetaris.js";

const KEY = "rf_hist_ORD-1001"; // seeded: paid once
const c = new pg.Client({ connectionString: process.env.PROCESSOR_DATABASE_URL, statement_timeout: 10_000 });
await c.connect();

async function read(label: string) {
  const t0 = Date.now();
  const t = await getRefundTruth(KEY);
  console.log(`${label.padEnd(16)} success_count=${t?.success_count} truth=${t?.truth}  (${Date.now() - t0}ms)`);
  return t;
}

try {
  const before = await read("before");
  const { rows } = await c.query(
    "INSERT INTO processor_log (refund_key, processor_status, amount, processed_at) VALUES ($1, 'succeeded', 1.00, now()) RETURNING id",
    [KEY],
  );
  const testId = rows[0].id;
  const afterInsert = await read("after insert");
  await c.query("DELETE FROM processor_log WHERE id = $1", [testId]);
  const afterDelete = await read("after delete");

  const insertSeen = afterInsert?.success_count === (before?.success_count ?? 0) + 1;
  const deleteSeen = afterDelete?.success_count === before?.success_count;
  console.log(`\ninsert visible immediately: ${insertSeen ? "YES" : "NO"}`);
  console.log(`delete visible immediately: ${deleteSeen ? "YES" : "NO"}`);
  process.exitCode = insertSeen && deleteSeen ? 0 : 1;
} finally {
  await c.end();
}
