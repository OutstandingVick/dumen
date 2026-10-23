// Quick check that the generator works: npm run gen:smoke
import "dotenv/config";
import { generate } from "../runtime/generator.js";

const out = await generate(
  "Ticket T-0: customer asks for a refund. amount requested: 19.99. Reply as JSON {decision, amount, reason}.",
  "You are a refund ops assistant. Reply with JSON only.",
);
console.log(`SAMPLE_MODE=${process.env.SAMPLE_MODE}`);
console.log(out.text);
