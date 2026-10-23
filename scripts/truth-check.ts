// Checks the Zetaris refund_truth view against the seeded cases: npm run truth:check
import "dotenv/config";
import { getRefundTruth } from "../runtime/zetaris.js";

const expected: Record<string, string> = {
  "rf_hist_ORD-1001": "paid",
  "rf_hist_ORD-1004": "paid", // internal pending, processor succeeded
  "rf_hist_ORD-1005": "paid", // internal pending, processor succeeded
  "rf_hist_ORD-1006": "not_paid",
  "rf_hist_ORD-1007": "not_paid",
  "rf_hist_ORD-1008": "conflict",
  "rf_hist_ORD-1009": "paid",
};

let failed = 0;
for (const [key, want] of Object.entries(expected)) {
  const t = await getRefundTruth(key);
  const ok = t?.truth === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${key}  internal=${t?.internal_status} processor=${t?.processor_status} → ${t?.truth} (want ${want})`);
}
process.exit(failed ? 1 : 0);
