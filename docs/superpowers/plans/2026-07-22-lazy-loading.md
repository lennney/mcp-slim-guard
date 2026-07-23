# Lazy Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement lazy loading — tools/list returns slim tool stubs (name + description only), LLM fetches full schema on demand via `mcp__get_schema`, then calls real tool names directly.

**Architecture:** Pure-function pipeline `(tools: Tool[]) => Tool[]`. Four stages: whitelistFilter → levelToStage → applyLazyBudget → injectGetSchema. Lazy loading is orthogonal to compression level (independent boolean config). Budget preload exposes full schema for high-priority tools (search/list/read/get/find/describe/info) to reduce get_schema calls.

**Tech Stack:** TypeScript 5.7 strict, `@modelcontextprotocol/sdk` ^1.9.0, micromatch ^4.0, vitest

## Global Constraints

- TypeScript strict mode, zero `any`
- 5 production dependencies max (no new deps — micromatch already included)
- Backward compat: `lazy_loading` defaults false, existing 5-level behavior unchanged
- Security pipeline (SSRF/injection/whitelist/ratelimit) sees real tool names at all levels
- Baseline: 334 tests, 18 files — all must remain passing
- Commit format: `type: short description` (feat/fix/refactor/docs/test/chore)
- Run `npx tsc --noEmit && npx vitest run` after each task to verify

## Constant Naming Resolution

The existing code has `GET_SCHEMA = "mcp__get_tool_schema"` (wrapper mode). The spec introduces `mcp__get_schema` (lazy mode). To avoid conflict:

- **Rename** existing `GET_SCHEMA` → `GET_TOOL_SCHEMA` (value unchanged: `"mcp__get_tool_schema"`)
- **Add** new `GET_SCHEMA = "mcp__get_schema"` (for lazy mode discovery tool)
- `handleWrapperTool` switch handles both `GET_TOOL_SCHEMA` and `GET_SCHEMA` (same logic, fallthrough case)

---

## Task 1: Config types + schema + defaults

**Files:**

- Modify: `src/config-types.ts` (CompressorConfig interface, ~line 164)
- Modify: `src/config-schema.ts` (compressor schema, ~line 44-53)
- Modify: `src/config-loader.ts` (defaults, ~line 90)
- Test: `tests/unit/config-loader.test.ts` (add lazy_loading/lazy_budget tests)

**Interfaces:**

- Consumes: existing `CompressorConfig`, `CompressionLevel`
- Produces: `CompressorConfig` with `lazy_loading?: boolean` and `lazy_budget?: number`

- [ ] **Step 1: Write failing tests for config loading with lazy_loading**

Add to `tests/unit/config-loader.test.ts`:

```typescript
describe("compressor lazy_loading config", () => {
  it("applies defaults lazy_loading=false, lazy_budget=8 when omitted", () => {
    const config = ConfigLoader.loadGuardConfig("tests/fixtures/config-minimal.yaml");
    expect(config.compressor.lazy_loading).toBe(false);
    expect(config.compressor.lazy_budget).toBe(8);
  });

  it("loads lazy_loading=true and lazy_budget=4 from YAML", () => {
    // Write a temp fixture inline using ConfigLoader.parseConfig or similar
    const yaml = `
version: 1
tools: { allow: ["*"], deny: [] }
ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }
rate_limit: { default: "" }
injection_detection: { enabled: false }
compressor: { enabled: true, level: "off", lazy_loading: true, lazy_budget: 4 }
servers: {}
`;
    // Use fs.writeFileSync to temp file, load, then unlink
    const tmpPath = `/tmp/test-lazy-config-${Date.now()}.yaml`;
    fs.writeFileSync(tmpPath, yaml);
    try {
      const config = ConfigLoader.loadGuardConfig(tmpPath);
      expect(config.compressor.lazy_loading).toBe(true);
      expect(config.compressor.lazy_budget).toBe(4);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });

  it("schema validates lazy_budget range (0-100)", () => {
    const yaml = `
version: 1
tools: { allow: ["*"], deny: [] }
ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }
rate_limit: { default: "" }
injection_detection: { enabled: false }
compressor: { enabled: true, level: "off", lazy_budget: 200 }
servers: {}
`;
    const tmpPath = `/tmp/test-lazy-budget-${Date.now()}.yaml`;
    fs.writeFileSync(tmpPath, yaml);
    try {
      const errors = validateConfigSchema(yaml.load(fs.readFileSync(tmpPath, "utf-8")));
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e: string) => e.includes("lazy_budget"))).toBe(true);
    } finally {
      fs.unlinkSync(tmpPath);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/config-loader.test.ts -t "lazy_loading"`
Expected: FAIL — `lazy_loading` and `lazy_budget` not found on CompressorConfig

- [ ] **Step 3: Add lazy_loading and lazy_budget to CompressorConfig interface**

In `src/config-types.ts`, modify the `CompressorConfig` interface (after `level: CompressionLevel;`):

```typescript
  /**
   * 按需展开 schema：tools/list 不返回完整 schema，
   * 通过 mcp__get_schema 按需获取。
   * light/normal/tight 级别下退化为 off 行为。
   * 默认 false。
   */
  lazy_loading?: boolean;
  /**
   * lazy loading 模式下预暴露完整 schema 的工具数上限。
   * 高优先级工具（匹配 search/list/read/get/find/describe/info 模式）
   * 优先预加载。默认 8。
   */
  lazy_budget?: number;
```

- [ ] **Step 4: Add lazy_loading and lazy_budget to config schema**

In `src/config-schema.ts`, modify the compressor schema (inside `properties` of compressor, after `level`):

```typescript
        lazy_loading: {
          type: "boolean",
          default: false,
          description: "按需展开 schema，通过 mcp__get_schema 按需获取",
        },
        lazy_budget: {
          type: "number",
          minimum: 0,
          maximum: 100,
          default: 8,
          description: "lazy loading 预暴露完整 schema 的工具数上限",
        },
```

- [ ] **Step 5: Add defaults to config-loader**

In `src/config-loader.ts`, modify the defaults (around line 90):

```typescript
      compressor: {
        enabled: false,
        level: "light",
        lazy_loading: false,
        lazy_budget: 8,
      },
```

Also in the `loadGuardConfig` method, after the `normalizeCompressionLevel` call (~line 148), add:

```typescript
// Apply lazy_loading / lazy_budget defaults if not set
if (config.compressor.lazy_loading === undefined) {
  config.compressor.lazy_loading = false;
}
if (config.compressor.lazy_budget === undefined) {
  config.compressor.lazy_budget = 8;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/unit/config-loader.test.ts`
Expected: PASS

- [ ] **Step 7: Run full regression**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (334 tests, zero TS errors)

- [ ] **Step 8: Commit**

```bash
git add src/config-types.ts src/config-schema.ts src/config-loader.ts tests/unit/config-loader.test.ts
git commit -m "feat: add lazy_loading and lazy_budget config fields"
```

---

## Task 2: whitelistFilter stage + unit tests

**Files:**

- Modify: `src/compressor.ts` (add whitelistFilter, rename GET_SCHEMA → GET_TOOL_SCHEMA, add new GET_SCHEMA)
- Test: `tests/unit/compressor.test.ts` (add whitelistFilter tests)

**Interfaces:**

- Consumes: `Tool` type, `micromatch.isMatch`
- Produces: `whitelistFilter(allow, deny): ToolStage`, `ToolStage` type, `GET_TOOL_SCHEMA` constant, `GET_SCHEMA` constant (renamed)

- [ ] **Step 1: Write failing tests for whitelistFilter**

Add to `tests/unit/compressor.test.ts` (after existing imports, before existing describe blocks):

```typescript
import { whitelistFilter } from "../../src/compressor.js";

describe("whitelistFilter", () => {
  const tools: Tool[] = [
    { name: "github_search", description: "search", inputSchema: { type: "object", properties: {} } },
    { name: "github_create", description: "create", inputSchema: { type: "object", properties: {} } },
    { name: "slack_send", description: "send", inputSchema: { type: "object", properties: {} } },
  ];

  it("passes all tools when allow is empty and deny is empty", () => {
    const stage = whitelistFilter([], []);
    expect(stage(tools)).toHaveLength(3);
  });

  it("filters by allow pattern", () => {
    const stage = whitelistFilter(["github_*"], []);
    const result = stage(tools);
    expect(result.map((t) => t.name)).toEqual(["github_search", "github_create"]);
  });

  it("filters by deny pattern (deny takes priority)", () => {
    const stage = whitelistFilter(["*"], ["github_create"]);
    const result = stage(tools);
    expect(result.map((t) => t.name)).toEqual(["github_search", "slack_send"]);
  });

  it("combines allow + deny patterns", () => {
    const stage = whitelistFilter(["github_*"], ["github_create"]);
    const result = stage(tools);
    expect(result.map((t) => t.name)).toEqual(["github_search"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/compressor.test.ts -t "whitelistFilter"`
Expected: FAIL — `whitelistFilter` not exported

- [ ] **Step 3: Implement whitelistFilter + rename constants**

In `src/compressor.ts`:

First, rename the existing constant and add the new one (around line 24-26):

```typescript
/** Prefix for wrapper tools to avoid colliding with real tool names */
const PREFIX = "mcp__";
const LIST_TOOLS = `${PREFIX}list_tools`;
const GET_TOOL_SCHEMA = `${PREFIX}get_tool_schema`; // renamed from GET_SCHEMA (wrapper mode)
const GET_SCHEMA = `${PREFIX}get_schema`; // new: lazy mode discovery tool
const INVOKE = `${PREFIX}invoke_tool`;
```

Then add the `ToolStage` type and `whitelistFilter` function (after the constants, before `getCompressedTools`):

```typescript
/** A compression/lazy stage: input tools → output tools */
export type ToolStage = (tools: Tool[]) => Tool[];

/**
 * Whitelist filter stage — filters tools by allow/deny patterns.
 * deny match → blocked; allow non-empty → must match; otherwise allowed.
 * This replaces the isToolVisible logic previously embedded in handleWrapperTool.
 */
export const whitelistFilter = (allow: string[], deny: string[]): ToolStage => {
  return (tools: Tool[]) => {
    const isAllowed = (name: string): boolean => {
      if (deny.length > 0 && deny.some((p) => isMatch(name, p))) return false;
      if (allow.length > 0) return allow.some((p) => isMatch(name, p));
      return true;
    };
    return tools.filter((t) => isAllowed(t.name));
  };
};
```

Update the `case GET_SCHEMA:` in `handleWrapperTool` to `case GET_TOOL_SCHEMA:`:

```typescript
    case GET_TOOL_SCHEMA: {
```

Update the export at the bottom of the file:

```typescript
export { PREFIX, LIST_TOOLS, GET_TOOL_SCHEMA, GET_SCHEMA, INVOKE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/compressor.test.ts -t "whitelistFilter"`
Expected: PASS

- [ ] **Step 5: Run full regression (existing tests reference old GET_SCHEMA name)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: Some existing tests may fail if they import `GET_SCHEMA` by name. Fix any import references in test files to use `GET_TOOL_SCHEMA` instead. The integration tests use string literals (`"mcp__get_tool_schema"`) so they should be unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/compressor.ts tests/unit/compressor.test.ts
git commit -m "feat: add whitelistFilter pipeline stage + rename GET_SCHEMA to GET_TOOL_SCHEMA"
```

---

## Task 3: levelToStage stage + unit tests

**Files:**

- Modify: `src/compressor.ts` (add levelToStage, makeWrapperTools helper)
- Test: `tests/unit/compressor.test.ts` (add levelToStage tests)

**Interfaces:**

- Consumes: `CompressionLevel`, `Tool`, `ToolStage`, `buildSignature`, `stripPropertyDescriptions`
- Produces: `levelToStage(level, lazyLoading): ToolStage`

- [ ] **Step 1: Write failing tests for levelToStage**

Add to `tests/unit/compressor.test.ts`:

```typescript
import { levelToStage } from "../../src/compressor.js";

describe("levelToStage", () => {
  const tools: Tool[] = [
    {
      name: "mock_echo",
      description: "Echo back the input message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "The message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "mock_get_time",
      description: "Get the current server time",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  it("off level passes tools through unchanged", () => {
    const stage = levelToStage("off", false);
    expect(stage(tools)).toEqual(tools);
  });

  it("light level produces 3 wrapper tools (list + get_tool_schema + invoke)", () => {
    const stage = levelToStage("light", false);
    const result = stage(tools);
    expect(result.map((t) => t.name)).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("normal level produces 2 wrapper tools (get_tool_schema + invoke)", () => {
    const stage = levelToStage("normal", false);
    const result = stage(tools);
    expect(result.map((t) => t.name)).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("extreme level strips property descriptions but keeps type/required", () => {
    const stage = levelToStage("extreme", false);
    const result = stage(tools);
    const echo = result.find((t) => t.name === "mock_echo")!;
    const props = echo.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.message.type).toBe("string");
    expect(props.message.description).toBeUndefined();
    expect(echo.inputSchema.required).toEqual(["message"]);
  });

  it("maximum level embeds signature in description and empties schema", () => {
    const stage = levelToStage("maximum", false);
    const result = stage(tools);
    const echo = result.find((t) => t.name === "mock_echo")!;
    expect(echo.description).toContain("mock_echo(message: string)");
    expect(echo.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("lazy+light degrades to passthrough (no wrapper)", () => {
    const stage = levelToStage("light", true);
    expect(stage(tools)).toEqual(tools);
  });

  it("lazy+normal degrades to passthrough", () => {
    const stage = levelToStage("normal", true);
    expect(stage(tools)).toEqual(tools);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/compressor.test.ts -t "levelToStage"`
Expected: FAIL — `levelToStage` not exported

- [ ] **Step 3: Implement levelToStage + makeWrapperTools helper**

In `src/compressor.ts`, add after `whitelistFilter`:

```typescript
/**
 * Build wrapper tools for light/normal compression levels.
 * @param tools - Original full tool list
 * @param includeList - Whether to include mcp__list_tools (light only)
 */
function makeWrapperTools(tools: Tool[], includeList: boolean): Tool[] {
  const result: Tool[] = [];

  if (includeList) {
    result.push({
      name: LIST_TOOLS,
      description:
        "List all available tools (names and descriptions only, no schemas). Call get_tool_schema to get full input schema for a specific tool.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  result.push({
    name: GET_TOOL_SCHEMA,
    description:
      "Get the full input schema (parameters, types, constraints) for one tool. Use this before calling invoke_tool to construct correct arguments.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: `The full tool name (e.g. "mock_echo"). Available tools: ${tools
            .map((t) => t.name)
            .sort()
            .join(", ")}`,
        },
      },
      required: ["tool_name"],
    },
  });

  result.push({
    name: INVOKE,
    description: "Invoke a tool with the given arguments. Call get_tool_schema first to see required parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "The full tool name to invoke" },
        input: {
          type: "object",
          description: "Arguments to pass to the tool (use get_tool_schema to see expected fields)",
        },
      },
      required: ["tool_name", "input"],
    },
  });

  return result;
}

/**
 * Compression level → stage function.
 * When lazyLoading=true, light/normal/tight degrade to passthrough (no wrapper).
 * Note: config-loader's normalizeCompressionLevel already maps "tight" → "normal",
 * so the "tight" case is for type completeness only.
 */
export const levelToStage = (level: CompressionLevel, lazyLoading: boolean): ToolStage => {
  return (tools: Tool[]) => {
    if (lazyLoading && (level === "light" || level === "normal" || level === "tight")) {
      return tools; // passthrough — lazy mode doesn't use wrappers
    }

    switch (level) {
      case "off":
        return tools;

      case "light":
        return makeWrapperTools(tools, true);

      case "normal":
      case "tight":
        return makeWrapperTools(tools, false);

      case "extreme":
        return tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: stripPropertyDescriptions(t.inputSchema),
        }));

      case "maximum":
        return tools.map((t) => ({
          name: t.name,
          description: `${t.description ?? ""} ${buildSignature(t)}`.trim(),
          inputSchema: { type: "object" as const, properties: {} },
        }));
    }
  };
};
```

Add the import for `CompressionLevel` at the top:

```typescript
import type { CompressorConfig, CompressionLevel } from "./config-types.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/compressor.test.ts -t "levelToStage"`
Expected: PASS

- [ ] **Step 5: Run full regression**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (334 tests — old functions still exist alongside new ones)

- [ ] **Step 6: Commit**

```bash
git add src/compressor.ts tests/unit/compressor.test.ts
git commit -m "feat: add levelToStage pipeline stage (refactors existing level logic)"
```

---

## Task 4: applyLazyBudget + injectGetSchema stages + unit tests

**Files:**

- Modify: `src/compressor.ts` (add applyLazyBudget, injectGetSchema)
- Test: `tests/unit/compressor.test.ts` (add applyLazyBudget + injectGetSchema tests)

**Interfaces:**

- Consumes: `Tool`, `ToolStage`, `GET_SCHEMA` constant
- Produces: `applyLazyBudget(budget, originalTools): ToolStage`, `injectGetSchema: ToolStage`

- [ ] **Step 1: Write failing tests for applyLazyBudget**

Add to `tests/unit/compressor.test.ts`:

```typescript
import { applyLazyBudget, injectGetSchema } from "../../src/compressor.js";

describe("applyLazyBudget", () => {
  const tools: Tool[] = [
    {
      name: "github_search",
      description: "Search repos",
      inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    },
    {
      name: "github_get_user",
      description: "Get user",
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
    },
    {
      name: "github_create_issue",
      description: "Create issue",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
    { name: "github_delete_repo", description: "Delete repo", inputSchema: { type: "object", properties: {} } },
  ];
  const originalMap = new Map(tools.map((t) => [t.name, t]));

  it("preloads high-priority tools (search/get) with full schema, strips others", () => {
    const stage = applyLazyBudget(8, originalMap);
    const result = stage(tools);
    // github_search and github_get_user match HIGH_PRIORITY pattern
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");

    const create = result.find((t) => t.name === "github_create_issue")!;
    // Slim format: name + description only, no inputSchema field
    expect(create.inputSchema).toBeUndefined();
    expect(create.description).toBe("Create issue");
  });

  it("budget=0 strips all schemas (all slim)", () => {
    const stage = applyLazyBudget(0, originalMap);
    const result = stage(tools);
    for (const t of result) {
      expect(t.inputSchema).toBeUndefined();
    }
  });

  it("budget >= tool count keeps all full (all preloaded if high-priority)", () => {
    const stage = applyLazyBudget(100, originalMap);
    const result = stage(tools);
    // search and get_user are high priority → full schema
    // create_issue and delete_repo are NOT high priority → slim even with budget=100
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const del = result.find((t) => t.name === "github_delete_repo")!;
    expect(del.inputSchema).toBeUndefined();
  });

  it("mixed: some high-priority, some not", () => {
    const stage = applyLazyBudget(1, originalMap);
    const result = stage(tools);
    // Only first high-priority tool gets full schema (budget=1)
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const getUser = result.find((t) => t.name === "github_get_user")!;
    expect(getUser.inputSchema).toBeUndefined();
  });

  it("restores full schema from originalTools (not from level-compressed tools)", () => {
    // Simulate: levelToStage(extreme) already stripped descriptions
    const extremeTools: Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: { type: "object", properties: {} }, // stripped by extreme
    }));
    const stage = applyLazyBudget(8, originalMap);
    const result = stage(extremeTools);
    const search = result.find((t) => t.name === "github_search")!;
    // Should have original full schema, not the extreme-stripped one
    expect(search.inputSchema.properties).toHaveProperty("q");
    expect(search.inputSchema.required).toEqual(["q"]);
  });
});
```

- [ ] **Step 2: Write failing tests for injectGetSchema**

Add to `tests/unit/compressor.test.ts`:

```typescript
describe("injectGetSchema", () => {
  it("appends mcp__get_schema tool at end of list", () => {
    const tools: Tool[] = [{ name: "mock_echo", description: "Echo", inputSchema: { type: "object", properties: {} } }];
    const result = injectGetSchema(tools);
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe("mcp__get_schema");
  });

  it("get_schema description contains available tool names", () => {
    const tools: Tool[] = [
      { name: "mock_echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
      { name: "mock_add", description: "Add", inputSchema: { type: "object", properties: {} } },
    ];
    const result = injectGetSchema(tools);
    expect(result[2].description).toContain("mock_add");
    expect(result[2].description).toContain("mock_echo");
  });

  it("get_schema has inputSchema with required tool_name param", () => {
    const result = injectGetSchema([]);
    const schema = result[0].inputSchema;
    expect(schema.required).toEqual(["tool_name"]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/unit/compressor.test.ts -t "applyLazyBudget|injectGetSchema"`
Expected: FAIL — functions not exported

- [ ] **Step 4: Implement applyLazyBudget and injectGetSchema**

In `src/compressor.ts`, add after `levelToStage`:

```typescript
/** High-priority tool name pattern for lazy budget preload */
const HIGH_PRIORITY = /^(search|list|read|get|find|describe|info)/i;

/**
 * Lazy budget stage — preloads high-priority tools with full original schema,
 * strips schema from low-priority tools (slim format: name + description only).
 * @param budget - Max number of high-priority tools to preload
 * @param originalTools - Original full tool map (for restoring schema after level compression)
 */
export const applyLazyBudget = (budget: number, originalTools: Map<string, Tool>): ToolStage => {
  return (tools: Tool[]) => {
    // Select high-priority tools (up to budget)
    const fullSet = new Set<string>();
    for (const t of tools) {
      if (fullSet.size >= budget) break;
      if (HIGH_PRIORITY.test(t.name)) fullSet.add(t.name);
    }

    return tools.map((t) => {
      if (fullSet.has(t.name)) {
        // High-priority: restore full original schema
        return originalTools.get(t.name) ?? t;
      }
      // Low-priority: slim format (name + description, no inputSchema)
      return { name: t.name, description: t.description ?? "" };
    });
  };
};

/**
 * Inject mcp__get_schema discovery tool at end of list.
 * LLM calls this to fetch full schema for a slim tool before invoking it.
 */
export const injectGetSchema: ToolStage = (tools: Tool[]) => {
  const toolNames = tools
    .map((t) => t.name)
    .sort()
    .join(", ");
  return [
    ...tools,
    {
      name: GET_SCHEMA,
      description:
        "Get the full input schema (parameters, types, constraints) for a specific tool. Call this before invoking a tool whose schema is not included in the tools list. Returns the complete original schema.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool_name: {
            type: "string",
            description: `The tool name to get schema for. Available tools: ${toolNames}`,
          },
        },
        required: ["tool_name"],
      },
    },
  ];
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/compressor.test.ts -t "applyLazyBudget|injectGetSchema"`
Expected: PASS

- [ ] **Step 6: Run full regression**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (334 tests)

- [ ] **Step 7: Commit**

```bash
git add src/compressor.ts tests/unit/compressor.test.ts
git commit -m "feat: add applyLazyBudget and injectGetSchema pipeline stages"
```

---

## Task 5: generateTools + buildPipeline entry point + unit tests

**Files:**

- Modify: `src/compressor.ts` (add generateTools, buildPipeline)
- Test: `tests/unit/compressor.test.ts` (add buildPipeline/generateTools tests)

**Interfaces:**

- Consumes: `whitelistFilter`, `levelToStage`, `applyLazyBudget`, `injectGetSchema`, `CompressorConfig`
- Produces: `generateTools(fullTools, config, allow, deny): Tool[]`, `buildPipeline(config, allow, deny, originalTools): ToolStage[]`

- [ ] **Step 1: Write failing tests for generateTools + buildPipeline**

Add to `tests/unit/compressor.test.ts`:

```typescript
import { generateTools, buildPipeline } from "../../src/compressor.js";

describe("generateTools / buildPipeline", () => {
  const tools: Tool[] = [
    {
      name: "github_search",
      description: "Search",
      inputSchema: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] },
    },
    {
      name: "github_create",
      description: "Create",
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
    },
  ];

  it("lazy+off: returns preloaded + slim + get_schema", () => {
    const config = { enabled: true, level: "off" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    // github_search is high-priority → full schema
    // github_create is not → slim
    // + mcp__get_schema
    expect(result).toHaveLength(3);
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const create = result.find((t) => t.name === "github_create")!;
    expect(create.inputSchema).toBeUndefined();
    expect(result[2].name).toBe("mcp__get_schema");
  });

  it("lazy+extreme: level strips first, then lazy restores high-priority from original", () => {
    const config = { enabled: true, level: "extreme" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    const search = result.find((t) => t.name === "github_search")!;
    // Should have original full schema (restored from originalTools), not extreme-stripped
    expect(search.inputSchema.properties).toHaveProperty("q");
    const create = result.find((t) => t.name === "github_create")!;
    expect(create.inputSchema).toBeUndefined();
  });

  it("lazy+maximum: level embeds signature, then lazy restores high-priority", () => {
    const config = { enabled: true, level: "maximum" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
  });

  it("lazy+light: degrades to off behavior (no wrapper)", () => {
    const config = { enabled: true, level: "light" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    // No mcp__list_tools / mcp__get_tool_schema / mcp__invoke_tool
    expect(result.find((t) => t.name === "mcp__list_tools")).toBeUndefined();
    expect(result.find((t) => t.name === "mcp__invoke_tool")).toBeUndefined();
    // But mcp__get_schema IS present (lazy mode)
    expect(result.find((t) => t.name === "mcp__get_schema")).toBeDefined();
  });

  it("non-lazy+extreme: works without lazy (existing behavior)", () => {
    const config = { enabled: true, level: "extreme" as const };
    const result = generateTools(tools, config, [], []);
    expect(result).toHaveLength(2);
    const search = result.find((t) => t.name === "github_search")!;
    expect(search.inputSchema.properties).toBeDefined();
    // No mcp__get_schema
    expect(result.find((t) => t.name === "mcp__get_schema")).toBeUndefined();
  });

  it("non-lazy+off: passes through unchanged", () => {
    const config = { enabled: true, level: "off" as const };
    const result = generateTools(tools, config, [], []);
    expect(result).toEqual(tools);
  });

  it("disabled compressor returns full tools", () => {
    const config = { enabled: false, level: "off" as const, lazy_loading: true };
    const result = generateTools(tools, config, [], []);
    expect(result).toEqual(tools);
  });

  it("whitelist filters before lazy budget selection", () => {
    const config = { enabled: true, level: "off" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, ["github_*"], ["github_create"]);
    // Only github_search survives whitelist
    const names = result.map((t) => t.name);
    expect(names).toContain("github_search");
    expect(names).not.toContain("github_create");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/compressor.test.ts -t "generateTools"`
Expected: FAIL — functions not exported

- [ ] **Step 3: Implement generateTools + buildPipeline**

In `src/compressor.ts`, add after `injectGetSchema`:

````typescript
/**
 * Build the pipeline of stages from config.
 * Order: whitelistFilter → levelToStage → applyLazyBudget → injectGetSchema
 * @param originalTools - Original full tool map (for applyLazyBudget to restore schemas)
 */
export function buildPipeline(
  config: CompressorConfig,
  allow: string[],
  deny: string[],
  originalTools: Map<string, Tool>,
): ToolStage[] {
  const stages: ToolStage[] = [];

  // Stage 0: whitelist filter
  stages.push(whitelistFilter(allow, deny));

  // Stage 1: compression level
  stages.push(levelToStage(config.level, config.lazy_loading ?? false));

  // Stage 2 + 3: lazy loading (orthogonal to level)
  if (config.lazy_loading) {
    stages.push(applyLazyBudget(config.lazy_budget ?? 8, originalTools));
    stages.push(injectGetSchema);
  }

  return stages;
}

/**
 * Generate the tools/list response — pipeline serial execution.
 * Entry point for proxy.ts tools/list handler.
 */
export function generateTools(
  fullTools: Tool[],
  config: CompressorConfig,
  allow: string[] = [],
  deny: string[] = [],
): Tool[] {
```typescript
/**
 * Generate the tools/list response — pipeline serial execution.
 * Entry point for proxy.ts tools/list handler.
 *
 * When level=off and lazy_loading=false, passthrough (backward compat with
 * existing behavior where tools/list returns all tools unfiltered).
 * When level≠off or lazy_loading=true, pipeline runs (including whitelistFilter).
 */
export function generateTools(
  fullTools: Tool[],
  config: CompressorConfig,
  allow: string[] = [],
  deny: string[] = [],
): Tool[] {
  if (!config.enabled) return fullTools;
  if (config.level === "off" && !config.lazy_loading) return fullTools;

  const originalTools = new Map(fullTools.map(t => [t.name, t]));
  return buildPipeline(config, allow, deny, originalTools).reduce(
    (tools, stage) => stage(tools),
    fullTools,
  );
}
````

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/compressor.test.ts -t "generateTools"`
Expected: PASS

- [ ] **Step 5: Run full regression**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (334 tests — old functions still exist)

- [ ] **Step 6: Commit**

```bash
git add src/compressor.ts tests/unit/compressor.test.ts
git commit -m "feat: add generateTools + buildPipeline pipeline entry point"
```

---

## Task 6: Simplify handleWrapperTool + add GET_SCHEMA case

**Files:**

- Modify: `src/compressor.ts` (remove isToolVisible, remove allow/deny params, add GET_SCHEMA case)
- Test: `tests/unit/compressor.test.ts` (update handleWrapperTool tests if any)
- Test: `tests/integration/compressor-pipeline.test.ts` (update if handleWrapperTool signature changed)

**Interfaces:**

- Consumes: `GET_TOOL_SCHEMA`, `GET_SCHEMA`, `LIST_TOOLS`, `INVOKE`, `PREFIX`
- Produces: simplified `handleWrapperTool(toolName, args, fullTools, serverCall)` (no allow/deny params)

- [ ] **Step 1: Update handleWrapperTool to remove isToolVisible + add GET_SCHEMA case**

In `src/compressor.ts`, replace the `handleWrapperTool` function:

```typescript
/**
 * Handle a wrapper tool call. Returns the response if it's a wrapper tool,
 * or null if it's a regular tool call that should be handled normally.
 *
 * fullTools must already be whitelist-filtered (pipeline stage 0 handles this).
 */
export async function handleWrapperTool(
  toolName: string,
  args: Record<string, unknown>,
  fullTools: Tool[],
  serverCall: (
    resolvedToolName: string,
    resolvedArgs: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>,
): Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
} | null> {
  if (!toolName.startsWith(PREFIX)) return null;

  const nameToSchema: Record<string, Tool> = {};
  for (const t of fullTools) nameToSchema[t.name] = t;

  switch (toolName) {
    case LIST_TOOLS: {
      const entries = fullTools.map((t) => ({
        name: t.name,
        description: t.description || "(no description)",
      }));
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }

    case GET_TOOL_SCHEMA:
    case GET_SCHEMA: {
      const targetName = args.tool_name as string;
      if (!targetName || !nameToSchema[targetName]) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: "${targetName}". Available: ${Object.keys(nameToSchema).sort().join(", ")}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(nameToSchema[targetName], null, 2) }],
      };
    }

    case INVOKE: {
      const targetName = args.tool_name as string;
      const input = (args.input || {}) as Record<string, unknown>;
      if (!targetName) {
        return { content: [{ type: "text", text: "Missing required parameter: tool_name" }], isError: true };
      }
      return serverCall(targetName, input);
    }

    default:
      return null;
  }
}
```

- [ ] **Step 2: Update proxy.ts tools/call handler to match new signature**

In `src/proxy.ts`, update the `CallToolRequestSchema` handler — remove the `allow`/`deny` params from `handleWrapperTool` call and simplify the interception logic:

```typescript
this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const params = request.params;
  const prefixedName = params.name;
  const args: Record<string, unknown> = params.arguments ?? {};

  // mcp__* prefix → wrapper/discovery tools (handleWrapperTool)
  if (prefixedName.startsWith(PREFIX)) {
    const wrapperResult = await handleWrapperTool(prefixedName, args, this.fullTools, (targetName, targetArgs) =>
      forwardToolCall(targetName, targetArgs),
    );
    if (wrapperResult) {
      const reqId = ++this.requestCounter;
      this.audit.log(
        { toolName: prefixedName, arguments: args, serverName: "compressor" },
        { allowed: true },
        [],
        this.sessionId,
        reqId,
        0,
      );
      return wrapperResult;
    }
  }

  // Real tool → security pipeline
  return forwardToolCall(prefixedName, args);
});
```

This removes the `isWrapperLevel` check — we now intercept ANY `mcp__*` prefixed call, which is simpler and correct for both wrapper and lazy modes.

- [ ] **Step 3: Run full regression**

Run: `npm run build && npx tsc --noEmit && npx vitest run`
Expected: PASS (334 tests — existing integration tests use string literals for tool names, which still work)

If any integration tests fail because they pass `allow`/`deny` to `handleWrapperTool`, update them to match the new 4-arg signature.

- [ ] **Step 4: Commit**

```bash
git add src/compressor.ts src/proxy.ts
git commit -m "refactor: simplify handleWrapperTool (remove isToolVisible, add GET_SCHEMA case)"
```

---

## Task 7: Update proxy.ts tools/list + delete old functions + update existing tests

**Files:**

- Modify: `src/proxy.ts` (tools/list handler → generateTools)
- Modify: `src/compressor.ts` (delete getCompressedTools, getTransformTools)
- Modify: `tests/unit/compressor.test.ts` (update tests referencing deleted functions)
- Modify: `tests/integration/compressor-pipeline.test.ts` (update if referencing deleted functions)

**Interfaces:**

- Consumes: `generateTools` from compressor.ts
- Produces: simplified proxy.ts tools/list handler

- [ ] **Step 1: Update proxy.ts tools/list handler**

In `src/proxy.ts`, replace the entire `ListToolsRequestSchema` handler:

```typescript
this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allNames = this.fullTools.map((t) => t.name);
  this.audit.logDiscovery(this.sessionId, ++this.requestCounter, "all", this.fullTools.length, allNames);
  return {
    tools: generateTools(this.fullTools, this.config.compressor, this.config.tools.allow, this.config.tools.deny),
  };
});
```

Update the import:

```typescript
import { generateTools, handleWrapperTool, PREFIX } from "./compressor.js";
```

(Remove `getCompressedTools, getTransformTools` from imports.)

- [ ] **Step 2: Delete old functions from compressor.ts**

Delete `getCompressedTools` function (lines ~31-91) and `getTransformTools` function (lines ~242-265) from `src/compressor.ts`.

Keep: `buildSignature`, `stripPropertyDescriptions`, `handleWrapperTool`, `whitelistFilter`, `levelToStage`, `applyLazyBudget`, `injectGetSchema`, `generateTools`, `buildPipeline`, `makeWrapperTools`, all constants.

- [ ] **Step 3: Update existing tests that reference deleted functions**

In `tests/unit/compressor.test.ts`:

Replace the `describe("getTransformTools", ...)` block — change import and calls to use `levelToStage`:

```typescript
// Change import:
import { levelToStage, generateTools } from "../../src/compressor.js";

// Replace describe("getTransformTools") with:
describe("levelToStage (extreme/maximum via generateTools)", () => {
  // Keep the same test assertions but call through levelToStage:
  it("extreme returns tools with real identities", () => {
    const stage = levelToStage("extreme", false);
    const result = stage(sampleTools);
    expect(result.map((t) => t.name)).toEqual(["mock_echo", "mock_add", "mock_get_time", "mock_search"]);
  });
  // ... convert all getTransformTools(sampleTools, "extreme") → levelToStage("extreme", false)(sampleTools)
  // ... convert all getTransformTools(sampleTools, "maximum") → levelToStage("maximum", false)(sampleTools)
});

// Replace describe("getCompressedTools") with:
describe("generateTools (wrapper levels)", () => {
  it("light level returns 3 wrapper tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "light" });
    expect(result.map((t) => t.name)).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
  });
  it("normal level returns 2 wrapper tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "normal" });
    expect(result.map((t) => t.name)).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
  });
  it("off level returns full tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "off" });
    expect(result).toEqual(sampleTools);
  });
  it("disabled returns full tools", () => {
    const result = generateTools(sampleTools, { enabled: false, level: "light" });
    expect(result).toEqual(sampleTools);
  });
});
```

- [ ] **Step 4: Build and run full regression**

Run: `npm run build && npx tsc --noEmit && npx vitest run`
Expected: PASS (all tests — count may shift slightly as old tests are converted, but no new failures)

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts src/compressor.ts tests/unit/compressor.test.ts tests/integration/compressor-pipeline.test.ts
git commit -m "refactor: proxy uses generateTools, delete getCompressedTools/getTransformTools"
```

---

## Task 8: CLI updates

**Files:**

- Modify: `src/cli.ts` (help text, type assertion, status output)

**Interfaces:**

- Consumes: updated `CompressorConfig` with `lazy_loading`/`lazy_budget`

- [ ] **Step 1: Update --compressor option help text**

In `src/cli.ts`, find the `--compressor` option (~line 116) and update:

```typescript
    .option("--compressor [level]", "Enable schema compression. Levels: light, normal, extreme, maximum. Use --lazy to enable lazy loading (schema on demand)", "off")
    .option("--lazy", "Enable lazy loading: tools/list omits schemas, use mcp__get_schema on demand")
    .option("--lazy-budget <n>", "Max tools with full schema in lazy mode (default 8)", "8")
```

- [ ] **Step 2: Apply lazy settings in start action**

In the `start` action (~line 132), after applying compressor level:

```typescript
// Apply compressor setting
if (options.compressor && options.compressor !== "off") {
  const level = options.compressor as "light" | "normal" | "extreme" | "maximum";
  guardConfig.compressor = { enabled: true, level };
}

// Apply lazy loading
if (options.lazy) {
  guardConfig.compressor.lazy_loading = true;
  const budget = parseInt(options.lazyBudget, 10);
  if (!isNaN(budget)) guardConfig.compressor.lazy_budget = budget;
}
```

Note: need to update the options type to include `lazy` and `lazyBudget`.

- [ ] **Step 3: Update status output**

In the status display (~line 370), update:

```typescript
if (config.compressor?.enabled && config.compressor.level !== "off") {
  const lazyTag = config.compressor.lazy_loading ? " +lazy" : "";
  const mode =
    config.compressor.level === "extreme" || config.compressor.level === "maximum" ? "schema-transform" : "wrapper";
  console.log(`  📦 Schema compressor: ${config.compressor.level}${lazyTag} (${mode})`);
  if (config.compressor.lazy_loading) {
    console.log(`     Lazy loading: budget=${config.compressor.lazy_budget ?? 8}`);
  }
} else {
  console.log("  ℹ️  Schema compressor: off");
}
```

- [ ] **Step 4: Update buildPolicyList to show lazy**

In `buildPolicyList` (~line 50):

```typescript
if (config.compressor?.enabled) {
  const lazy = config.compressor.lazy_loading ? "+lazy" : "";
  list.push(`compressor:${config.compressor.level}${lazy}`);
}
```

- [ ] **Step 5: Build and run full regression**

Run: `npm run build && npx tsc --noEmit && npx vitest run`
Expected: PASS

- [ ] **Step 6: Verify CLI help text**

Run: `node dist/cli.js start --help`
Expected: `--compressor`, `--lazy`, `--lazy-budget` options visible

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add --lazy and --lazy-budget CLI options"
```

---

## Task 9: Integration tests for lazy loading

**Files:**

- Modify: `tests/integration/compressor-pipeline.test.ts` (add lazy mode integration tests)

**Interfaces:**

- Consumes: `GuardProxy`, `Client`, `makeConfig` helper

- [ ] **Step 1: Add lazy+off integration test**

Add to `tests/integration/compressor-pipeline.test.ts` (after existing tests, before the final `});`):

```typescript
// -----------------------------------------------------------------------
// 13. lazy+off: tools/list returns preloaded + slim + get_schema
// -----------------------------------------------------------------------
it("lazy+off: tools/list returns preloaded high-priority + slim + mcp__get_schema", async () => {
  const config = makeConfig({
    compressor: { enabled: true, level: "off", lazy_loading: true, lazy_budget: 8 },
  });
  const ctx = await buildProxy(config);
  try {
    const result = await ctx.client.listTools();
    const tools = result.tools as Tool[];
    const names = tools.map((t) => t.name);

    // mock_search and mock_get_time match HIGH_PRIORITY (search/get)
    // mock_echo and mock_add do not → slim
    expect(names).toContain("mock_search");
    expect(names).toContain("mock_get_time");
    expect(names).toContain("mock_echo");
    expect(names).toContain("mock_add");
    expect(names).toContain("mcp__get_schema");

    // High-priority tool has full schema
    const search = tools.find((t) => t.name === "mock_search")!;
    expect(search.inputSchema?.properties).toBeDefined();

    // Low-priority tool has no inputSchema (slim)
    const echo = tools.find((t) => t.name === "mock_echo")!;
    expect(echo.inputSchema).toBeUndefined();
  } finally {
    await destroyProxy(ctx);
  }
});

// -----------------------------------------------------------------------
// 14. lazy+off: mcp__get_schema returns full schema for slim tool
// -----------------------------------------------------------------------
it("lazy+off: mcp__get_schema returns full original schema", async () => {
  const config = makeConfig({
    compressor: { enabled: true, level: "off", lazy_loading: true, lazy_budget: 0 },
  });
  const ctx = await buildProxy(config);
  try {
    const result = await ctx.client.callTool({
      name: "mcp__get_schema",
      arguments: { tool_name: "mock_echo" },
    });
    const content = result.content[0] as { type: string; text?: string };
    const parsed = JSON.parse(content.text ?? "{}");
    expect(parsed.name).toBe("mock_echo");
    expect(parsed.inputSchema).toBeDefined();
    expect(parsed.inputSchema.properties).toHaveProperty("message");
  } finally {
    await destroyProxy(ctx);
  }
});

// -----------------------------------------------------------------------
// 15. lazy+extreme: level strips, lazy restores high-priority
// -----------------------------------------------------------------------
it("lazy+extreme: high-priority tools restored to full schema", async () => {
  const config = makeConfig({
    compressor: { enabled: true, level: "extreme", lazy_loading: true, lazy_budget: 8 },
  });
  const ctx = await buildProxy(config);
  try {
    const result = await ctx.client.listTools();
    const tools = result.tools as Tool[];

    // mock_search (high-priority) → full original schema (restored from original)
    const search = tools.find((t) => t.name === "mock_search")!;
    expect(search.inputSchema?.properties).toHaveProperty("query");

    // mock_echo (not high-priority) → slim (no inputSchema)
    const echo = tools.find((t) => t.name === "mock_echo")!;
    expect(echo.inputSchema).toBeUndefined();

    // mcp__get_schema present
    expect(tools.find((t) => t.name === "mcp__get_schema")).toBeDefined();
  } finally {
    await destroyProxy(ctx);
  }
});

// -----------------------------------------------------------------------
// 16. lazy+maximum: level embeds signatures, lazy restores high-priority
// -----------------------------------------------------------------------
it("lazy+maximum: high-priority tools restored to full schema", async () => {
  const config = makeConfig({
    compressor: { enabled: true, level: "maximum", lazy_loading: true, lazy_budget: 8 },
  });
  const ctx = await buildProxy(config);
  try {
    const result = await ctx.client.listTools();
    const tools = result.tools as Tool[];

    const search = tools.find((t) => t.name === "mock_search")!;
    expect(search.inputSchema?.properties).toHaveProperty("query");
  } finally {
    await destroyProxy(ctx);
  }
});

// -----------------------------------------------------------------------
// 17. lazy budget=0: all tools are slim
// -----------------------------------------------------------------------
it("lazy budget=0: all tools slim, only mcp__get_schema has schema", async () => {
  const config = makeConfig({
    compressor: { enabled: true, level: "off", lazy_loading: true, lazy_budget: 0 },
  });
  const ctx = await buildProxy(config);
  try {
    const result = await ctx.client.listTools();
    const tools = result.tools as Tool[];

    // All real tools should be slim (no inputSchema)
    for (const t of tools) {
      if (t.name !== "mcp__get_schema") {
        expect(t.inputSchema).toBeUndefined();
      }
    }
    // mcp__get_schema has inputSchema
    const getSchema = tools.find((t) => t.name === "mcp__get_schema")!;
    expect(getSchema.inputSchema).toBeDefined();
  } finally {
    await destroyProxy(ctx);
  }
});
```

- [ ] **Step 2: Build and run integration tests**

Run: `npm run build && npx vitest run tests/integration/compressor-pipeline.test.ts`
Expected: PASS (all existing + 5 new tests)

- [ ] **Step 3: Run full regression**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (334 + 5 = 339+ tests)

- [ ] **Step 4: Commit**

```bash
git add tests/integration/compressor-pipeline.test.ts
git commit -m "test: add integration tests for lazy loading modes"
```

---

## Task 10: Documentation update

**Files:**

- Modify: `docs/COMPRESSOR.md`

- [ ] **Step 1: Add lazy loading section to COMPRESSOR.md**

Read the current `docs/COMPRESSOR.md`, then add a new section after the 5-level documentation:

````markdown
## Lazy Loading

Lazy loading is an orthogonal feature that works with any compression level.
When enabled, `tools/list` returns slim tool stubs (name + description only)
instead of full schemas. The LLM fetches full schemas on demand via
`mcp__get_schema`.

### Configuration

```yaml
compressor:
  enabled: true
  level: "off" # any level works with lazy loading
  lazy_loading: true # enable lazy loading
  lazy_budget: 8 # max tools with full schema (default 8)
```
````

CLI:

```bash
mcp-slim-guard start --compressor off --lazy --lazy-budget 8
```

### How It Works

1. **tools/list** returns:
   - High-priority tools (matching `search|list|read|get|find|describe|info`) with **full schema** (up to `lazy_budget`)
   - Other tools as **slim stubs** (name + description, no inputSchema)
   - `mcp__get_schema` discovery tool at the end

2. **LLM calls high-priority tool** → direct call with full schema (no extra round-trip)

3. **LLM calls low-priority tool**:
   - First calls `mcp__get_schema({tool_name: "..."})` → gets full original schema
   - Then calls the real tool name directly → security pipeline enforces policies

### Budget Preload

High-priority tool name patterns: `search`, `list`, `read`, `get`, `find`, `describe`, `info`

These are read operations LLMs typically call first. Preloading their full schemas
avoids unnecessary `mcp__get_schema` round-trips.

`lazy_budget=0` → all tools are slim (maximum token savings, every tool needs get_schema first).

### Level × Lazy Combinations

| level   | lazy_loading | tools/list returns                                        | Call path                     |
| ------- | ------------ | --------------------------------------------------------- | ----------------------------- |
| off     | false        | Full tools (complete schema)                              | Direct real tool              |
| light   | false        | 3 wrappers                                                | mcp__invoke_tool              |
| normal  | false        | 2 wrappers                                                | mcp__invoke_tool              |
| extreme | false        | Real tools + stripped schema                              | Direct real tool              |
| maximum | false        | Real tools + signature + empty schema                     | Direct real tool              |
| any     | true         | Real tools (preloaded full + rest slim) + mcp__get_schema | get_schema → direct real tool |

When `lazy_loading=true` + `light`/`normal`: degrades to `off` behavior (lazy doesn't use wrappers).

### Security

Lazy mode calls real tool names directly (not through `mcp__invoke_tool`).
The security pipeline (SSRF/injection/whitelist/ratelimit) always sees real tool names.
Whelist filtering happens at pipeline stage 0 — denied tools never appear in tools/list.

````

- [ ] **Step 2: Commit**

```bash
git add docs/COMPRESSOR.md
git commit -m "docs: add lazy loading section to COMPRESSOR.md"
````

---

## Task 11: Final verification

- [ ] **Step 1: Full build + type check + tests**

Run: `npm run build && npx tsc --noEmit && npx vitest run`
Expected: All tests pass, zero TS errors

- [ ] **Step 2: Verify test count**

Run: `npx vitest run 2>&1 | tail -5`
Expected: ~363 tests (334 baseline + 24 new unit + 5 new integration, minus any converted tests)

- [ ] **Step 3: Verify CLI help**

Run: `node dist/cli.js start --help`
Expected: `--compressor`, `--lazy`, `--lazy-budget` visible

- [ ] **Step 4: Verify backward compat**

Run: `npx vitest run tests/integration/compressor-pipeline.test.ts -t "tools/list returns 3 wrapper tools"`
Expected: PASS (existing light level behavior unchanged)

- [ ] **Step 5: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: final verification for lazy loading feature"
```
