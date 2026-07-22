# Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 4 independent benchmark modules + 1 entry point for measuring token savings, schema retention, LLM accuracy, and latency of mcp-guard's compressor.

**Architecture:** `.mjs` ES module scripts in `scripts/benchmark/`. Shared fixtures and report modules. tiktoken as devDependency for token counting. DeepSeek V4 Flash via OpenAI-compatible API for accuracy tests. CI runs 3/4 modules without API key.

**Tech Stack:** Node ESM (.mjs), tiktoken (WASM), OpenAI-compatible API, MCP SDK Client for tool discovery.

## Global Constraints

- 5 production dependencies — no new production deps (tiktoken is devDependency only)
- Benchmark scripts are `.mjs` files, not TypeScript
- CI-friendly: 3/4 modules run without API key
- No hardcoded API keys — read from env vars
- Tests use vitest, mock MCP servers, no real subprocess in unit tests

---

### Task 1: Install tiktoken devDependency + npm scripts

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: (none — first task)
- Produces: tiktoken available, npm scripts defined

- [ ] **Step 1: Install tiktoken**

```bash
npm install --save-dev tiktoken
```

- [ ] **Step 2: Add benchmark npm scripts to package.json**

In the `"scripts"` section, after `"prepublishOnly": "npm run build"`, add:

```json
    "bench": "node scripts/benchmark/bench.mjs",
    "bench:tokens": "node scripts/benchmark/tokens.mjs",
    "bench:schema": "node scripts/benchmark/schema.mjs",
    "bench:accuracy": "node scripts/benchmark/accuracy.mjs",
    "bench:latency": "node scripts/benchmark/latency.mjs"
```

- [ ] **Step 3: Verify tiktoken loads**

```bash
node -e "const { Tiktoken } = require('tiktoken'); console.log('tiktoken OK');"
```
If the above fails (ESM), try:
```bash
node -e "import('tiktoken').then(m => console.log('tiktoken OK', typeof m.encoding_for_config || typeof m.Tiktoken))"
```
Expected: "tiktoken OK"

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tiktoken devDependency and benchmark npm scripts"
```

---

### Task 2: Create shared fixtures module

**Files:**
- Create: `scripts/benchmark/fixtures.mjs`

**Interfaces:**
- Consumes: `@modelcontextprotocol/sdk` Client + StdioClientTransport
- Produces: `fetchTools()`, `SCENARIOS`, `LEVELS`, `TOOL_SOURCES`

- [ ] **Step 1: Create scripts/benchmark/fixtures.mjs**

```js
/**
 * Benchmark shared fixtures — tool discovery, scenario definitions, constants.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Compression levels to test */
export const LEVELS = ["off", "light", "normal", "extreme", "maximum"];

/** Number of runs per scenario × level for accuracy test */
export const RUNS = 3;

/** MCP server sources for tool discovery */
export const TOOL_SOURCES = [
  {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/bench-workspace"],
    env: {},
    required: false, // skip if unavailable
  },
  {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {},
    required: false, // skip if no GITHUB_TOKEN
  },
];

/**
 * Test scenarios for accuracy benchmark.
 * 8 basic (single-tool) + 4 ambiguous (overlapping tool signatures).
 */
export const SCENARIOS = [
  // --- Basic single-tool scenarios (1-8) ---
  {
    id: 1,
    prompt: "Read the file at /tmp/bench-workspace/test.txt",
    expectedTool: "read_file",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/test.txt" },
    category: "basic",
  },
  {
    id: 2,
    prompt: "List the contents of /tmp/bench-workspace",
    expectedTool: "list_directory",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace" },
    category: "basic",
  },
  {
    id: 3,
    prompt: 'Search for files matching "config" in /tmp/bench-workspace',
    expectedTool: "search_files",
    expectedArgs: { path: "string", pattern: "string" },
    requiredArgs: ["path", "pattern"],
    expectedValues: { path: "/tmp/bench-workspace", pattern: "config" },
    category: "basic",
  },
  {
    id: 4,
    prompt: "Get file info/metadata for /tmp/bench-workspace/test.txt",
    expectedTool: "get_file_info",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/test.txt" },
    category: "basic",
  },
  {
    id: 5,
    prompt: "Show the directory tree of /tmp/bench-workspace/src",
    expectedTool: "directory_tree",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/src" },
    category: "basic",
  },
  {
    id: 6,
    prompt: 'Write "hello world" to /tmp/bench-workspace/output.txt',
    expectedTool: "write_file",
    expectedArgs: { path: "string", content: "string" },
    requiredArgs: ["path", "content"],
    expectedValues: { path: "/tmp/bench-workspace/output.txt", content: "hello world" },
    category: "basic",
  },
  {
    id: 7,
    prompt: "Create a new directory at /tmp/bench-workspace/newdir",
    expectedTool: "create_directory",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: { path: "/tmp/bench-workspace/newdir" },
    category: "basic",
  },
  {
    id: 8,
    prompt: "Move /tmp/bench-workspace/a.txt to /tmp/bench-workspace/b.txt",
    expectedTool: "move_file",
    expectedArgs: { source: "string", destination: "string" },
    requiredArgs: ["source", "destination"],
    expectedValues: { source: "/tmp/bench-workspace/a.txt", destination: "/tmp/bench-workspace/b.txt" },
    category: "basic",
  },
  // --- Ambiguous scenarios (9-12) ---
  {
    id: 9,
    prompt: 'Find files containing "log" in /tmp/bench-workspace',
    expectedTool: "search_files",
    expectedArgs: { path: "string", pattern: "string" },
    requiredArgs: ["path", "pattern"],
    expectedValues: { pattern: "log" },
    category: "ambiguous",
    note: "read_file vs search_files — prompt says 'find files containing', expect search",
  },
  {
    id: 10,
    prompt: "Show all files recursively in /tmp/bench-workspace",
    expectedTool: "directory_tree",
    expectedArgs: { path: "string" },
    requiredArgs: ["path"],
    expectedValues: {},
    category: "ambiguous",
    note: "list_directory vs directory_tree — 'recursively' implies tree",
  },
  {
    id: 11,
    prompt: 'Make a new file /tmp/bench-workspace/x.txt with content "hi"',
    expectedTool: "write_file",
    expectedArgs: { path: "string", content: "string" },
    requiredArgs: ["path", "content"],
    expectedValues: { path: "/tmp/bench-workspace/x.txt", content: "hi" },
    category: "ambiguous",
    note: "write_file vs create_directory — 'file with content' implies write",
  },
  {
    id: 12,
    prompt: 'Search GitHub repositories for "mcp"',
    expectedTool: "search_repositories",
    expectedArgs: { query: "string" },
    requiredArgs: ["query"],
    expectedValues: { query: "mcp" },
    category: "ambiguous",
    note: "GitHub-specific — tests cross-server tool selection",
  },
];

/**
 * Start an MCP server, list tools, and close it.
 * Returns array of Tool objects, or empty array if server unavailable.
 */
export async function fetchTools(source) {
  const { name, command, args, env } = source;

  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env, ...env },
    });
    const client = new Client(
      { name: "benchmark", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    await transport.close();

    // Prefix tool names with server name: read_file → filesystem_read_file
    return tools.map((t) => ({
      ...t,
      name: `${name}_${t.name}`,
    }));
  } catch (err) {
    console.warn(`  ⚠️  ${name} server unavailable: ${err.message}`);
    return [];
  }
}

/**
 * Fetch tools from all available sources.
 * Skips unavailable servers (filesystem without npx, github without token).
 */
export async function fetchAllTools() {
  const allTools = [];
  for (const source of TOOL_SOURCES) {
    // Skip GitHub if no token
    if (source.name === "github" && !process.env.GITHUB_TOKEN) {
      console.warn(`  ⚠️  Skipping github server (no GITHUB_TOKEN)`);
      continue;
    }
    const tools = await fetchTools(source);
    console.log(`  📦 ${source.name}: ${tools.length} tools`);
    allTools.push(...tools);
  }
  return allTools;
}

/**
 * Prepare workspace directory for filesystem server.
 */
export function prepareWorkspace() {
  const fs = await import("node:fs");
  const dir = "/tmp/bench-workspace";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/test.txt`, "benchmark test file");
  fs.mkdirSync(`${dir}/src`, { recursive: true });
  return dir;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/benchmark/fixtures.mjs
git commit -m "feat: add benchmark fixtures — tool discovery + 12 test scenarios"
```

---

### Task 3: Create shared report generator

**Files:**
- Create: `scripts/benchmark/report.mjs`

**Interfaces:**
- Consumes: benchmark result objects
- Produces: `writeReport(results)` → JSON + Markdown files

- [ ] **Step 1: Create scripts/benchmark/report.mjs**

```js
/**
 * Benchmark report generator — JSON + Markdown output.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RESULTS_DIR = path.join(import.meta.dirname, "results");

/**
 * Write benchmark results to JSON + Markdown files.
 * Returns the file paths.
 */
export function writeReport(results) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const baseName = `bench-${date}`;

  // JSON output
  const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Markdown output
  const mdPath = path.join(RESULTS_DIR, `${baseName}.md`);
  fs.writeFileSync(mdPath, generateMarkdown(results));

  console.log(`\n📄 Report: ${jsonPath}`);
  console.log(`📄 Report: ${mdPath}`);

  return { jsonPath, mdPath };
}

function generateMarkdown(results) {
  let md = `# Benchmark Report — ${new Date().toISOString().slice(0, 10)}\n\n`;

  if (results.tokens) {
    md += `## Token Savings\n\n`;
    md += `| Level | Tokens | Reduction |\n|-------|--------|-----------|\n`;
    for (const [level, data] of Object.entries(results.tokens.levels)) {
      const pct = data.reduction_pct > 0 ? `${data.reduction_pct}%` : "baseline";
      md += `| ${level} | ${data.tokens} | ${pct} |\n`;
    }
    if (results.tokens.lazy) {
      md += `\n**Lazy loading:** ${results.tokens.lazy.tokens} tokens (${results.tokens.lazy.reduction_pct}% reduction)\n`;
    }
    md += `\n`;
  }

  if (results.schema) {
    md += `## Schema Retention\n\n`;
    md += `| Level | Visible Tools | Fields Preserved | Retention % |\n|-------|--------------|-----------------|-------------|\n`;
    for (const [level, data] of Object.entries(results.schema.levels)) {
      md += `| ${level} | ${data.visible_tools} | ${data.fields_preserved} | ${data.retention_pct}% |\n`;
    }
    md += `\n`;
  }

  if (results.accuracy) {
    md += `## Accuracy (${results.accuracy.model}, ${results.accuracy.total_calls} calls)\n\n`;
    md += `| Level | Passed | Total | Accuracy % |\n|-------|--------|-------|------------|\n`;
    for (const [level, data] of Object.entries(results.accuracy.levels)) {
      md += `| ${level} | ${data.passed} | ${data.total} | ${data.accuracy_pct}% |\n`;
    }
    if (results.accuracy.failures.length > 0) {
      md += `\n### Failures\n\n`;
      for (const f of results.accuracy.failures) {
        md += `- Level \`${f.level}\`, Scenario ${f.scenario}, Run ${f.run}: expected \`${f.expected}\`, got \`${f.got}\` (${f.reason})\n`;
      }
    }
    md += `\n`;
  }

  if (results.latency) {
    md += `## Latency\n\n`;
    md += `| Level | Compress (ms) | Cache Hit (ms) | Cache Miss (ms) |\n|-------|--------------|----------------|-----------------|\n`;
    for (const [level, data] of Object.entries(results.latency.levels)) {
      md += `| ${level} | ${data.compress_ms.toFixed(2)} | ${data.cache_hit_ms.toFixed(2)} | ${data.cache_miss_ms.toFixed(2)} |\n`;
    }
    md += `\n`;
  }

  return md;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/benchmark/report.mjs
git commit -m "feat: add benchmark report generator — JSON + Markdown"
```

---

### Task 4: Implement bench:tokens module (offline)

**Files:**
- Create: `scripts/benchmark/tokens.mjs`

**Interfaces:**
- Consumes: `fetchAllTools` from fixtures, `generateTools` from compressor, tiktoken
- Produces: token count per level + reduction percentage

- [ ] **Step 1: Create scripts/benchmark/tokens.mjs**

```js
/**
 * Benchmark: Token savings measurement (offline, CI-friendly).
 *
 * Measures token count of compressed tool schemas at each level.
 * Uses tiktoken (gpt-4o encoding) for counting.
 */
import { encoding_for_config } from "tiktoken";
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
 */
function getCompressedTools(fullTools, level) {
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

  // Initialize tiktoken
  const { Tiktoken } = await import("tiktoken");
  const { get_encoding } = await import("tiktoken");
  const encoding = get_encoding("gpt-4o");

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
```

Note: The `getCompressedTools` function has `await import()` inside — this is a syntax error in a non-async function. Let me fix it by making it async and awaiting in the caller.

- [ ] **Step 2: Fix getCompressedTools to be async**

The function `getCompressedTools` must be `async function` and the call site must `await` it. Fix:

```js
async function getCompressedTools(fullTools, level) {
  const { generateTools } = await import("../../dist/compressor.js");
  return generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
}
```

And in the loop:
```js
    const compressed = await getCompressedTools(fullTools, level);
```

(This is already the case in the loop body.)

- [ ] **Step 3: Build and test**

```bash
npm run build && node scripts/benchmark/tokens.mjs
```
Expected: Prints token counts per level, writes JSON + Markdown report.

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/tokens.mjs
git commit -m "feat: add bench:tokens module — offline token savings measurement"
```

---

### Task 5: Implement bench:schema module (offline)

**Files:**
- Create: `scripts/benchmark/schema.mjs`

**Interfaces:**
- Consumes: `fetchAllTools` from fixtures, `generateTools` from compressor
- Produces: schema retention stats per level

- [ ] **Step 1: Create scripts/benchmark/schema.mjs**

```js
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
```

- [ ] **Step 2: Build and test**

```bash
npm run build && node scripts/benchmark/schema.mjs
```
Expected: Prints schema stats per level, writes report.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/schema.mjs
git commit -m "feat: add bench:schema module — offline schema retention measurement"
```

---

### Task 6: Implement bench:latency module (offline)

**Files:**
- Create: `scripts/benchmark/latency.mjs`

**Interfaces:**
- Consumes: `fetchAllTools` from fixtures, `generateTools` from compressor
- Produces: latency stats per level

- [ ] **Step 1: Create scripts/benchmark/latency.mjs**

```js
/**
 * Benchmark: Latency measurement (offline, CI-friendly).
 *
 * Measures compression execution time and cache hit/miss latency.
 */
import { fetchAllTools, prepareWorkspace } from "./fixtures.mjs";
import { writeReport } from "./report.mjs";

const LEVELS = ["off", "light", "normal", "extreme", "maximum"];
const ITERATIONS = 10;

async function getCompressedTools(fullTools, level) {
  const { generateTools } = await import("../../dist/compressor.js");
  return generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
}

async function measureCompressLatency(fullTools, level) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await getCompressedTools(fullTools, level);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ns → ms
  }
  return times.reduce((a, b) => a + b, 0) / times.length;
}

async function measureCacheLatency(fullTools) {
  const { ToolCache } = await import("../../dist/cache.js");
  const config = {
    enabled: true,
    ttl: 30,
    max_entries: 500,
    allow: [],
    deny: [],
  };
  const cache = new ToolCache(config);

  // Prepare a cached entry
  const mockResult = { content: [{ type: "text", text: "cached" }] };
  cache.set("test_read", { q: "x" }, mockResult);

  // Cache hit latency
  const hitTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    cache.get("test_read", { q: "x" });
    const t1 = process.hrtime.bigint();
    hitTimes.push(Number(t1 - t0) / 1e6);
  }
  const hitMs = hitTimes.reduce((a, b) => a + b, 0) / hitTimes.length;

  // Cache miss latency
  const missTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    cache.get("test_read", { q: "not-cached" });
    const t1 = process.hrtime.bigint();
    missTimes.push(Number(t1 - t0) / 1e6);
  }
  const missMs = missTimes.reduce((a, b) => a + b, 0) / missTimes.length;

  return { hit_ms: hitMs, miss_ms: missMs };
}

async function main() {
  console.log("📊 Benchmark: Latency\n");

  await prepareWorkspace();

  console.log("Fetching tool schemas...");
  const fullTools = await fetchAllTools();

  if (fullTools.length === 0) {
    console.error("❌ No tools found.");
    process.exit(1);
  }

  console.log(`  ${ITERATIONS} iterations per measurement\n`);

  const levelResults = {};

  for (const level of LEVELS) {
    const compressMs = await measureCompressLatency(fullTools, level);
    levelResults[level] = {
      compress_ms: compressMs,
      cache_hit_ms: 0,
      cache_miss_ms: 0,
    };
    console.log(`  ${level.padEnd(10)} compress: ${compressMs.toFixed(2)}ms`);
  }

  // Cache latency (same for all levels — it's the cache module itself)
  const cacheLatency = await measureCacheLatency(fullTools);
  for (const level of LEVELS) {
    levelResults[level].cache_hit_ms = cacheLatency.hit_ms;
    levelResults[level].cache_miss_ms = cacheLatency.miss_ms;
  }
  console.log(`  Cache: hit ${cacheLatency.hit_ms.toFixed(2)}ms, miss ${cacheLatency.miss_ms.toFixed(2)}ms`);

  const result = {
    module: "latency",
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    levels: levelResults,
  };

  writeReport({ latency: result });
  console.log("\n✅ Latency benchmark complete");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Build and test**

```bash
npm run build && node scripts/benchmark/latency.mjs
```
Expected: Prints latency per level, writes report.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/latency.mjs
git commit -m "feat: add bench:latency module — offline latency measurement"
```

---

### Task 7: Implement bench:accuracy module (needs API key)

**Files:**
- Create: `scripts/benchmark/accuracy.mjs`

**Interfaces:**
- Consumes: `fetchAllTools`, `SCENARIOS`, `LEVELS`, `RUNS` from fixtures; DeepSeek API
- Produces: accuracy % per level, failure details

- [ ] **Step 1: Create scripts/benchmark/accuracy.mjs**

```js
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
  return actual === expected || actual.endsWith("__" + expected) || actual.endsWith("_" + expected);
}

/**
 * Validate a single LLM response against a test scenario.
 * Returns { passed, reason }.
 */
function validateResponse(toolCall, scenario) {
  if (!toolCall) {
    return { passed: false, reason: "no tool call returned" };
  }

  // Tool name check (namespace tolerant)
  if (!matchesTool(toolCall.function?.name ?? toolCall.name ?? "", scenario.expectedTool)) {
    return { passed: false, reason: `wrong tool (got ${toolCall.function?.name ?? toolCall.name}, expected ${scenario.expectedTool})` };
  }

  // Parse args
  const actualArgs = typeof toolCall.function?.arguments === "string"
    ? JSON.parse(toolCall.function.arguments)
    : (toolCall.input ?? toolCall.function?.arguments ?? {});

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

  // Value check (new vs slim-mcp: verify arg values contain expected fragments)
  for (const [name, expectedValue] of Object.entries(scenario.expectedValues)) {
    if (name in actualArgs) {
      const actual = String(actualArgs[name]);
      // For path-type args, check the expected value is contained
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
```

- [ ] **Step 2: Test without API key**

```bash
node scripts/benchmark/accuracy.mjs
```
Expected: "⏭️ Skipping accuracy benchmark (no DEEPSEEK_API_KEY)" and exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/accuracy.mjs
git commit -m "feat: add bench:accuracy module — LLM accuracy test with DeepSeek V4 Flash"
```

---

### Task 8: Create bench.mjs entry point

**Files:**
- Create: `scripts/benchmark/bench.mjs`

**Interfaces:**
- Consumes: all 4 benchmark modules
- Produces: combined report

- [ ] **Step 1: Create scripts/benchmark/bench.mjs**

```js
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
  await runModule("schema", "./schemas.mjs");
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
```

Note: The bench.mjs uses `await import()` to run each module's `main()`. Since each module file calls `main()` at the bottom, importing them will execute them. This is the simplest approach — each module is self-contained.

- [ ] **Step 2: Fix schema import path**

In bench.mjs, change `"./schemas.mjs"` to `"./schema.mjs"` (correct filename).

- [ ] **Step 3: Test the full suite without API key**

```bash
npm run build && npm run bench
```
Expected: Runs tokens, schema, latency. Skips accuracy. Generates reports.

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/bench.mjs
git commit -m "feat: add bench.mjs entry point — runs available modules based on environment"
```

---

### Task 9: Fix fixtures.mjs prepareWorkspace to be async

**Files:**
- Modify: `scripts/benchmark/fixtures.mjs`

The `prepareWorkspace` function uses `await import("node:fs")` but is defined as a regular function. Fix it to be async.

- [ ] **Step 1: Fix prepareWorkspace**

Replace:
```js
export function prepareWorkspace() {
  const fs = await import("node:fs");
  ...
}
```

With:
```js
import * as fs from "node:fs";

export function prepareWorkspace() {
  const dir = "/tmp/bench-workspace";
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/test.txt`, "benchmark test file");
  fs.mkdirSync(`${dir}/src`, { recursive: true });
  return dir;
}
```

Move the `import * as fs from "node:fs";` to the top of fixtures.mjs.

- [ ] **Step 2: Commit**

```bash
git add scripts/benchmark/fixtures.mjs
git commit -m "fix: make prepareWorkspace sync with top-level fs import"
```

---

### Task 10: Full verification + docs update

**Files:**
- Modify: `CHANGELOG.md`, `AGENTS.md`, `docs/ROADMAP.md`

- [ ] **Step 1: Run full test suite**

```bash
npm run build && npx vitest run
```
Expected: All 395 tests pass.

- [ ] **Step 2: Run benchmark suite without API key**

```bash
npm run bench
```
Expected: tokens + schema + latency run; accuracy skipped.

- [ ] **Step 3: Update CHANGELOG.md**

Add under `## [Unreleased]`:

```markdown
### Added
- **基准测试套件** — 4 模块基准测试对标 slim-mcp。`bench:tokens`（离线 token 节省）、`bench:schema`（离线 schema 保留率）、`bench:latency`（离线延迟）、`bench:accuracy`（DeepSeek V4 Flash 准确率，12 场景含模糊测试）。`npm run bench` 按 API key 可用性自动运行。
```

- [ ] **Step 4: Update docs/ROADMAP.md**

Change `基准测试 | P0 | 无 → 对标 slim-mcp 的 120 API 准确率测试` to `基准测试 | P0 | ✅ 已完成（4 模块 + tiktoken + DeepSeek V4 Flash）`

- [ ] **Step 5: Update AGENTS.md**

Update test count and recent activity.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md docs/ROADMAP.md AGENTS.md
git commit -m "docs: update CHANGELOG/ROADMAP/AGENTS for benchmark feature"
```

---

## Self-Review

1. **Spec coverage:** Each spec requirement maps to a task:
   - Token measurement → Task 4 (tokens.mjs)
   - Schema retention → Task 5 (schema.mjs)
   - Accuracy test → Task 7 (accuracy.mjs)
   - Latency → Task 6 (latency.mjs)
   - Combined runner → Task 8 (bench.mjs)
   - Shared fixtures → Task 2 (fixtures.mjs)
   - Report generation → Task 3 (report.mjs)
   - tiktoken devDep → Task 1
   - npm scripts → Task 1

2. **Placeholder scan:** No TBD/TODO. All code blocks complete.

3. **Type consistency:** All modules use `.mjs` ES modules. Import paths use `.js` for compiled TS (from dist/). Consistent API key env var names.
