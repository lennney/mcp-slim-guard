/**
 * Benchmark: Schema retention measurement (offline, CI-friendly).
 *
 * Measures how many schema fields are preserved after compression.
 */
import { fetchAllTools, prepareWorkspace } from "./fixtures.mjs";
import { writeReport } from "./report.mjs";

const LEVELS = ["off", "light", "normal", "extreme", "maximum"];

/**
 * Count schema fields in a tool list.
 * Returns: { tools, total_fields, total_required }
 */
function countSchemaFields(tools) {
  let totalFields = 0;
  let totalRequired = 0;

  for (const tool of tools) {
    const props = tool.inputSchema?.properties ?? {};
    totalFields += Object.keys(props).length;
    const required = tool.inputSchema?.required ?? [];
    totalRequired += required.length;
  }

  return { tools: tools.length, total_fields: totalFields, total_required: totalRequired };
}

/**
 * Generate compressed tools for a given level.
 */
async function getCompressedTools(fullTools, level) {
  const { generateTools } = await import("../../dist/compressor.js");
  return generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
}

async function main() {
  console.log("📊 Benchmark: Schema Retention\n");

  await prepareWorkspace();

  console.log("Fetching tool schemas...");
  const fullTools = await fetchAllTools();

  if (fullTools.length === 0) {
    console.error("❌ No tools found.");
    process.exit(1);
  }

  const baseline = countSchemaFields(fullTools);
  console.log(`  Baseline: ${baseline.tools} tools, ${baseline.total_fields} fields, ${baseline.total_required} required\n`);

  const levelResults = {};

  for (const level of LEVELS) {
    const compressed = await getCompressedTools(fullTools, level);
    const stats = countSchemaFields(compressed);
    const retentionPct = baseline.total_fields > 0
      ? Math.round((stats.total_fields / baseline.total_fields) * 100)
      : 0;

    let note = "";
    if (level === "light" || level === "normal") {
      note = "wrapper mode — schemas on demand";
    } else if (level === "extreme" || level === "maximum") {
      note = "signature in description";
    }

    levelResults[level] = {
      visible_tools: stats.tools,
      fields_preserved: stats.total_fields,
      required_preserved: stats.total_required,
      retention_pct: retentionPct,
      note,
    };

    console.log(`  ${level.padEnd(10)} ${stats.tools} tools, ${stats.total_fields} fields (${retentionPct}%)${note ? " — " + note : ""}`);
  }

  const result = {
    module: "schema",
    timestamp: new Date().toISOString(),
    baseline,
    levels: levelResults,
  };

  writeReport({ schema: result });
  console.log("\n✅ Schema benchmark complete");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
