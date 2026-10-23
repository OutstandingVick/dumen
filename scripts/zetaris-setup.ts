// Creates Dumen's Zetaris objects from zetaris/refund_truth_create.sql. Object creation
// needs JDBC (the HTTP API only runs SELECT), so this calls zetaris/ZSql.java with the
// Zetaris driver JAR. Safe to re-run: existing objects are skipped, the view is replaced.
//   npm run zetaris:setup -- --dry-run     (list the statements, send nothing)
//   npm run zetaris:setup                  (needs ZETARIS_JDBC_JAR and Java 11+)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../runtime/zetaris.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const sql = readFileSync(join(ROOT, "zetaris", "refund_truth_create.sql"), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);

if (dryRun) {
  for (const [i, s] of statements.entries()) console.log(`${i + 1}. ${s.replace(/\s+/g, " ").slice(0, 100)}`);
  console.log(`${statements.length} statements (dry run, nothing sent)`);
  process.exit(0);
}

const jar = process.env.ZETARIS_JDBC_JAR;
if (!jar || !existsSync(jar)) {
  console.error("Set ZETARIS_JDBC_JAR in .env to the Zetaris driver JAR (it ships in the Zetaris bundle under jdbc/).");
  process.exit(1);
}
// macOS's /usr/bin/java is often a stub; prefer JAVA_HOME, then Homebrew's JDK 17.
const java = [process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", "java"), "/opt/homebrew/opt/openjdk@17/bin/java", "java"].find(
  (j) => j && (j === "java" || existsSync(j)),
)!;

const res = spawnSync(java, ["-cp", jar, join(ROOT, "zetaris", "ZSql.java"), ...statements], { encoding: "utf8", timeout: 300_000 });
process.stdout.write(res.stdout.split("\n").filter((l) => !/SLF4J|log4j/.test(l)).join("\n"));
if (res.status !== 0) {
  console.error(res.error?.message ?? res.stderr.split("\n").filter((l) => !/SLF4J|log4j/.test(l)).slice(-5).join("\n"));
  process.exit(1);
}

const rows = await query("SELECT truth, count(*) AS n FROM dumen.refund_truth GROUP BY truth ORDER BY truth");
console.log(`refund_truth reachable: ${rows.map((r) => `${r.truth}=${r.n}`).join(", ")}`);
