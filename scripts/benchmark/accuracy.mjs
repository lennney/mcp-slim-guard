/**
 * Benchmark: LLM accuracy test (needs DEEPSEEK_API_KEY).
 *
 * Tests whether compressed tool schemas still let the LLM emit correct tool calls.
 * Uses DeepSeek V4 Flash via OpenAI-compatible API (HiModels).
 *
 * If no API key: prints skip message and exits 0.
 */
import { fetchAllTools, prepareWorkspace, SCENARIOS, LEVELS, RUNS } from "./fixtures.mjs";
import { writeReport } from "./report.mjs";

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_BASE = process.env.DEEPSEEK_API_BASE || "https://api.himodels.ai/v1";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

/**
 * Check if tool name matches expected, with namespace tolerance.
 * "filesystem_read_file" matches "read_file".
 */
function matchesTool(actual, expected) {
  return actual === expected || actual.endsWith("_" + expected);
}

/**
 * Validate a single LLM response against a test scenario.
 * Returns { passed, reason }.
 */
function validateResponse(toolCall, scenario) {
  if (!toolCall) {
    return { passed: false, reason: "no tool call returned" };
  }

  let actualToolName = toolCall.function?.name ?? toolCall.name ?? "";
  let actualArgs = typeof toolCall.function?.arguments === "string"
    ? JSON.parse(toolCall.function.arguments)
    : (toolCall.input ?? toolCall.function?.arguments ?? {});

  // Unwrap mcp__invoke_tool wrapper calls (light/normal compression mode)
  if (actualToolName === "mcp__invoke_tool" || actualToolName.endsWith("__invoke_tool")) {
    actualToolName = actualArgs.tool_name ?? "";
    actualArgs = actualArgs.args ?? {};
  }

  // Tool name check (namespace tolerant)
  if (!matchesTool(actualToolName, scenario.expectedTool)) {
    return { passed: false, reason: `wrong tool (got ${actualToolName}, expected ${scenario.expectedTool})` };
  }

  // Required args present
  for (const req of scenario.requiredArgs) {
    if (!(req in actualArgs)) {
      return { passed: false, reason: `missing required arg: ${req}` };
    }
  }

  // Arg type check
  for (const [name, expectedType] of Object.entries(scenario.expectedArgs)) {
    if (name in actualArgs && typeof actualArgs[name] !== expectedType) {
      return { passed: false, reason: `arg ${name} type mismatch: expected ${expectedType}, got ${typeof actualArgs[name]}` };
    }
  }

  // Value check
  for (const [name, expectedValue] of Object.entries(scenario.expectedValues)) {
    if (name in actualArgs) {
      const actual = String(actualArgs[name]);
      if (!actual.includes(String(expectedValue))) {
        return { passed: false, reason: `arg ${name} value mismatch: expected to contain "${expectedValue}", got "${actual}"` };
      }
    }
  }

  return { passed: true, reason: "" };
}

/**
 * Send a single test request to the API.
 */
async function runTestCase(apiTools, scenario) {
  const body = {
    model: MODEL,
    messages: [{ role: "user", content: scenario.prompt }],
    tools: apiTools,
    max_tokens: 512,
    temperature: 0,
  };

  const resp = await fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  return { toolCall, usage: data.usage };
}

/**
 * Convert MCP Tool to OpenAI tool format.
 */
function mcpToolToApiTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

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
  if (!API_KEY) {
    console.log("⏭️  Skipping accuracy benchmark (no DEEPSEEK_API_KEY)");
    process.exit(0);
  }

  console.log("📊 Benchmark: LLM Accuracy\n");
  console.log(`  Model: ${MODEL}`);
  console.log(`  Scenarios: ${SCENARIOS.length}`);
  console.log(`  Levels: ${LEVELS.length}`);
  console.log(`  Runs: ${RUNS}`);
  console.log(`  Total calls: ${SCENARIOS.length * LEVELS.length * RUNS}\n`);

  await prepareWorkspace();

  console.log("Fetching tool schemas...");
  const fullTools = await fetchAllTools();

  if (fullTools.length === 0) {
    console.error("❌ No tools found.");
    process.exit(1);
  }

  const levelResults = {};
  const failures = [];

  for (const level of LEVELS) {
    console.log(`\n── Level: ${level} ──`);
    const compressed = await getCompressedTools(fullTools, level);
    const apiTools = compressed.map(mcpToolToApiTool);

    let passed = 0;
    let total = 0;

    for (const scenario of SCENARIOS) {
      for (let run = 0; run < RUNS; run++) {
        total++;
        try {
          const { toolCall } = await runTestCase(apiTools, scenario);
          const result = validateResponse(toolCall, scenario);
          if (result.passed) {
            passed++;
            console.log(`  ✅ ${scenario.id}.${run} ${scenario.expectedTool}`);
          } else {
            console.log(`  ❌ ${scenario.id}.${run} ${scenario.expectedTool}: ${result.reason}`);
            failures.push({
              level,
              scenario: scenario.id,
              run,
              expected: scenario.expectedTool,
              got: toolCall?.function?.name ?? toolCall?.name ?? "none",
              reason: result.reason,
            });
          }
        } catch (err) {
          console.log(`  ❌ ${scenario.id}.${run} ${scenario.expectedTool}: API error — ${err.message}`);
          failures.push({
            level,
            scenario: scenario.id,
            run,
            expected: scenario.expectedTool,
            got: "error",
            reason: err.message,
          });
        }
      }
    }

    const accuracyPct = Math.round((passed / total) * 1000) / 10;
    levelResults[level] = { passed, total, accuracy_pct: accuracyPct };
    console.log(`  → ${passed}/${total} (${accuracyPct}%)`);
  }

  const totalCalls = SCENARIOS.length * LEVELS.length * RUNS;
  const result = {
    module: "accuracy",
    timestamp: new Date().toISOString(),
    model: MODEL,
    total_calls: totalCalls,
    levels: levelResults,
    failures,
  };

  writeReport({ accuracy: result });
  console.log("\n✅ Accuracy benchmark complete");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
