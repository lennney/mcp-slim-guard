/**
 * Benchmark: Token savings measurement (offline, CI-friendly).
 *
 * Measures token count of compressed tool schemas at each level.
 * Uses tiktoken (gpt-4o encoding) for counting.
 */
import { fetchAllTools, prepareWorkspace } from "./fixtures.mjs";
import { writeReport } from "./report.mjs";

const LEVELS = ["off", "light", "normal", "extreme", "maximum"];

/**
 * Count tokens in a tool list using tiktoken.
 * Serializes tools as the LLM would see them: [{ name, description, inputSchema }] as JSON.
 */
function countTokens(tools, encoding) {
  const serialized = JSON.stringify(
    tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    })),
  );
  return encoding.encode(serialized).length;
}

/**
 * Generate compressed tools for a given level using mcp-guard's compressor.
 *
 * Note: `await import()` requires this to be `async`; caller must `await` it.
 */
async function getCompressedTools(fullTools, level) {
  // Dynamic import from dist/ (compiled TS)
  const { generateTools } = await import("../../dist/compressor.js");
  return generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
}

async function main() {
  console.log("📊 Benchmark: Token Savings\n");

  // Prepare workspace for filesystem server
  await prepareWorkspace();

  // Fetch real tool schemas
  console.log("Fetching tool schemas...");
  const fullTools = await fetchAllTools();

  if (fullTools.length === 0) {
    console.error("❌ No tools found. Is npx available?");
    process.exit(1);
  }

  console.log(`  Total tools: ${fullTools.length}\n`);

  // Initialize tiktoken. gpt-4o uses the o200k_base encoding; `encoding_for_model`
  // resolves the model name to its encoding (NOTE: `get_encoding("gpt-4o")` is
  // invalid — it takes an encoding name like "o200k_base", not a model name).
  const { encoding_for_model } = await import("tiktoken");
  const encoding = encoding_for_model("gpt-4o");

  // Measure tokens per level
  const levelResults = {};
  let baselineTokens = 0;

  for (const level of LEVELS) {
    const compressed = await getCompressedTools(fullTools, level);
    const tokens = countTokens(compressed, encoding);
    levelResults[level] = { tokens, reduction_pct: 0 };
    if (level === "off") baselineTokens = tokens;
    console.log(`  ${level.padEnd(10)} ${tokens} tokens`);
  }

  // Calculate reduction percentages
  for (const level of LEVELS) {
    if (level === "off") continue;
    levelResults[level].reduction_pct = Math.round(
      ((baselineTokens - levelResults[level].tokens) / baselineTokens) * 100,
    );
  }

  // Lazy loading measurement
  const { generateTools } = await import("../../dist/compressor.js");
  const lazyTools = generateTools(fullTools, {
    enabled: true,
    level: "light",
    lazy_loading: true,
    lazy_budget: 8,
  });
  const lazyTokens = countTokens(lazyTools, encoding);
  const lazyResult = {
    tokens: lazyTokens,
    reduction_pct: Math.round(((baselineTokens - lazyTokens) / baselineTokens) * 100),
  };

  encoding.free();

  const result = {
    module: "tokens",
    timestamp: new Date().toISOString(),
    tool_count: fullTools.length,
    levels: levelResults,
    lazy: lazyResult,
  };

  console.log(`\n  Lazy loading: ${lazyTokens} tokens (${lazyResult.reduction_pct}% reduction)`);

  writeReport({ tokens: result });
  console.log("\n✅ Token benchmark complete");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
