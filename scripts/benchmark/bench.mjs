/**
 * Benchmark entry point — runs all available modules based on environment.
 *
 * Without DEEPSEEK_API_KEY: runs tokens + schema + latency (3/4 modules).
 * With DEEPSEEK_API_KEY: runs all 4 modules.
 *
 * Usage: npm run bench
 */
import { writeReport } from "./report.mjs";

const HAS_API_KEY = !!process.env.DEEPSEEK_API_KEY;

console.log("🛡️  mcp-guard Benchmark Suite\n");
console.log(`  API key: ${HAS_API_KEY ? "✅ available (full suite)" : "❌ not set (offline modules only)"}\n`);

async function runModule(name, importPath) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 Running: ${name}`);
  console.log("=".repeat(60));
  try {
    await import(importPath);
  } catch (err) {
    console.error(`  ⚠️  ${name} failed: ${err.message}`);
    return null;
  }
}

async function main() {
  const results = {};

  // Always run offline modules
  await runModule("tokens", "./tokens.mjs");
  await runModule("schema", "./schema.mjs");
  await runModule("latency", "./latency.mjs");

  // Run accuracy only with API key
  if (HAS_API_KEY) {
    await runModule("accuracy", "./accuracy.mjs");
  } else {
    console.log("\n⏭️  Skipping accuracy benchmark (no DEEPSEEK_API_KEY)");
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ Benchmark suite complete");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
