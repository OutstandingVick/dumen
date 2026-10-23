// Quick check that the generator works: npm run gen:smoke
import "dotenv/config";
import { generator } from "../runtime/generator.js";

const out = await generator(
  "Ticket T-0: customer asks for a refund. amount requested: 19.99. Reply as JSON {decision, amount, reason}.",
  null,
  "You are a refund ops assistant. Reply with JSON only.",
  process.argv.includes("--stream") ? (chunk) => process.stdout.write(chunk) : null,
);
if (process.argv.includes("--stream")) console.log();
console.log(`SAMPLE_MODE=${process.env.SAMPLE_MODE}`);
console.log(out.text);
