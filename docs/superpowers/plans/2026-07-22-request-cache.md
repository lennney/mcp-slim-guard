# Request Cache TTL+LRU — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-memory TTL+LRU caching for read-only MCP tool call results in GuardProxy.

**Architecture:** New `src/cache.ts` module with `ToolCache` class. Injected into `GuardProxy`. Intercepts in `forwardToolCall` after policy pipeline but before upstream call. Cache key = `toolName + sorted args JSON`. TTL auto-detected from tool name patterns with config overrides.

**Tech Stack:** TypeScript strict, Node ≥18, zero new deps, Map+Array LRU.

## Global Constraints

- 5 production deps — no new deps
- TS strict, zero `any`
- Default disabled (backward compat)
- `isError: true` never cached
- Hot reload rebuilds entire cache

---

### Task 1: Add CacheConfig type to GuardConfig

**Files:**
- Modify: `src/config-types.ts`

**Interfaces:**
- Consumes: (none — first task)
- Produces: `CacheConfig` interface, optional `cache` on `GuardConfig`

- [ ] **Step 1: Add CacheConfig interface after CompressorConfig (~line 190)**

```ts
/**
 * 请求缓存配置 — 只读工具调用结果内存缓存，TTL + LRU。
 */
export interface CacheConfig {
  /** 是否启用缓存。默认 false。 */
  enabled: boolean;
  /** 全局默认 TTL（秒）。默认 30。 */
  ttl: number;
  /** LRU 容量上限。默认 500。 */
  max_entries: number;
  /** 强制可缓存的工具名 glob（空 = 模式推断）。 */
  allow: string[];
  /** 强制不可缓存的工具名 glob。 */
  deny: string[];
  /** 按工具名精确覆盖 TTL（秒）。key 为带前缀的工具名。 */
  ttl_per_tool?: Record<string, number>;
}
```

- [ ] **Step 2: Add `cache?: CacheConfig` field to GuardConfig interface**

After the `compressor: CompressorConfig;` line, insert:
```ts
/** 请求缓存配置（可选，默认 disabled） */
cache?: CacheConfig;
```

- [ ] **Step 3: Verify types compile**

```bash
npx tsc --noEmit
```
Expected: Clean exit, no errors.

- [ ] **Step 4: Commit**

```bash
git add src/config-types.ts
git commit -m "feat: add CacheConfig type with optional cache field on GuardConfig"
```

---

### Task 2: Write failing cache unit tests (TDD RED)

**Files:**
- Create: `tests/unit/cache.test.ts`

**Interfaces:**
- Consumes: `CacheConfig` from Task 1
- Produces: (test file, expects `ToolCache` from `../../src/cache.js`)

- [ ] **Step 1: Create tests/unit/cache.test.ts**

```ts
/**
 * Unit tests for ToolCache — TTL+LRU, isCacheable, getTTL, key determinism.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolCache } from "../../src/cache.js";
import type { CacheConfig } from "../../src/config-types.js";

function makeConfig(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return {
    enabled: true,
    ttl: 30,
    max_entries: 500,
    allow: [],
    deny: [],
    ...overrides,
  };
}

const echoResult = { content: [{ type: "text" as const, text: "hello" }] };

describe("ToolCache.isCacheable", () => {
  it("returns false when disabled", () => {
    const cache = new ToolCache(makeConfig({ enabled: false }));
    expect(cache.isCacheable("github_search")).toBe(false);
  });

  it("returns true for search-like tools (pattern inference)", () => {
    const cache = new ToolCache(makeConfig());
    expect(cache.isCacheable("github_search_repositories")).toBe(true);
    expect(cache.isCacheable("slack_list_channels")).toBe(true);
    expect(cache.isCacheable("mock_find_items")).toBe(true);
    expect(cache.isCacheable("db_query_users")).toBe(true);
  });

  it("returns true for read-like tools (pattern inference)", () => {
    const cache = new ToolCache(makeConfig());
    expect(cache.isCacheable("github_read_file")).toBe(true);
    expect(cache.isCacheable("slack_get_history")).toBe(true);
    expect(cache.isCacheable("mock_describe_widget")).toBe(true);
    expect(cache.isCacheable("db_check_status")).toBe(true);
    expect(cache.isCacheable("system_info")).toBe(true);
  });

  it("returns false for write-like tools (pattern inference)", () => {
    const cache = new ToolCache(makeConfig());
    expect(cache.isCacheable("github_create_repo")).toBe(false);
    expect(cache.isCacheable("slack_send_message")).toBe(false);
    expect(cache.isCacheable("mock_delete_item")).toBe(false);
    expect(cache.isCacheable("db_insert_record")).toBe(false);
  });

  it("deny overrides pattern inference", () => {
    const cache = new ToolCache(makeConfig({ deny: ["github_search*"] }));
    expect(cache.isCacheable("github_search_repositories")).toBe(false);
    expect(cache.isCacheable("github_read_file")).toBe(true);
  });

  it("allow restricts to explicit list", () => {
    const cache = new ToolCache(makeConfig({ allow: ["github_read*"] }));
    expect(cache.isCacheable("github_read_file")).toBe(true);
    expect(cache.isCacheable("github_search_repositories")).toBe(false);
  });

  it("deny wins over allow", () => {
    const cache = new ToolCache(makeConfig({
      allow: ["github_*"],
      deny: ["github_search*"],
    }));
    expect(cache.isCacheable("github_read_file")).toBe(true);
    expect(cache.isCacheable("github_search_repositories")).toBe(false);
  });
});

describe("ToolCache.getTTL", () => {
  it("uses ttl_per_tool exact match first", () => {
    const cache = new ToolCache(makeConfig({ ttl_per_tool: { github_search: 5 } }));
    expect(cache.getTTL("github_search")).toBe(5);
  });

  it("uses 15s for search-like tools", () => {
    const cache = new ToolCache(makeConfig());
    expect(cache.getTTL("github_search_repositories")).toBe(15);
    expect(cache.getTTL("slack_list_channels")).toBe(15);
    expect(cache.getTTL("mock_find_items")).toBe(15);
    expect(cache.getTTL("db_query_users")).toBe(15);
  });

  it("uses 60s for read-like tools", () => {
    const cache = new ToolCache(makeConfig());
    expect(cache.getTTL("github_read_file")).toBe(60);
    expect(cache.getTTL("slack_get_history")).toBe(60);
    expect(cache.getTTL("mock_describe_widget")).toBe(60);
    expect(cache.getTTL("db_check_status")).toBe(60);
    expect(cache.getTTL("system_info")).toBe(60);
  });

  it("uses global TTL for non-matching tools", () => {
    const cache = new ToolCache(makeConfig({ ttl: 42 }));
    expect(cache.getTTL("github_create_repo")).toBe(42);
  });
});

describe("ToolCache key generation", () => {
  it("same args in different order produce same key (cache hit)", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("test_search", { a: 1, b: 2 }, echoResult);
    const result = cache.get("test_search", { b: 2, a: 1 });
    expect(result).toEqual(echoResult);
  });

  it("different args produce cache miss", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("test_search", { query: "react" }, echoResult);
    const result = cache.get("test_search", { query: "vue" });
    expect(result).toBeNull();
  });
});

describe("ToolCache.get/set", () => {
  let cache: ToolCache;

  beforeEach(() => {
    cache = new ToolCache(makeConfig());
  });

  it("returns result on cache hit", () => {
    cache.set("test_read", { query: "x" }, echoResult);
    const result = cache.get("test_read", { query: "x" });
    expect(result).toEqual(echoResult);
  });

  it("returns null on cache miss", () => {
    const result = cache.get("test_read", { query: "never" });
    expect(result).toBeNull();
  });

  it("returns null when disabled", () => {
    const disabled = new ToolCache(makeConfig({ enabled: false }));
    disabled.set("test_read", { query: "x" }, echoResult);
    expect(disabled.get("test_read", { query: "x" })).toBeNull();
  });

  it("does not cache isError results", () => {
    const err = { content: [{ type: "text" as const, text: "fail" }], isError: true };
    cache.set("test_read", { query: "x" }, err);
    expect(cache.get("test_read", { query: "x" })).toBeNull();
  });
});

describe("ToolCache TTL expiry", () => {
  it("expires entry after TTL seconds", () => {
    vi.useFakeTimers();
    const cache = new ToolCache(makeConfig({ ttl: 1 }));
    cache.set("test_read", { query: "x" }, echoResult);
    expect(cache.get("test_read", { query: "x" })).toEqual(echoResult);
    vi.advanceTimersByTime(1500);
    expect(cache.get("test_read", { query: "x" })).toBeNull();
    vi.useRealTimers();
  });

  it("uses tool-specific TTL (search=15s)", () => {
    vi.useFakeTimers();
    const cache = new ToolCache(makeConfig());
    cache.set("mock_search", { q: "x" }, echoResult);
    vi.advanceTimersByTime(14000);
    expect(cache.get("mock_search", { q: "x" })).toEqual(echoResult);
    vi.advanceTimersByTime(2000);
    expect(cache.get("mock_search", { q: "x" })).toBeNull();
    vi.useRealTimers();
  });
});

describe("ToolCache LRU eviction", () => {
  it("evicts oldest entry when max_entries reached", () => {
    const cache = new ToolCache(makeConfig({ max_entries: 2 }));
    cache.set("a_read", { x: 1 }, echoResult);
    cache.set("b_read", { x: 2 }, echoResult);
    cache.get("a_read", { x: 1 }); // promote a
    cache.set("c_read", { x: 3 }, echoResult); // evict b (oldest)
    expect(cache.get("a_read", { x: 1 })).toEqual(echoResult);
    expect(cache.get("b_read", { x: 2 })).toBeNull();
    expect(cache.get("c_read", { x: 3 })).toEqual(echoResult);
  });
});

describe("ToolCache.stats", () => {
  it("tracks hits and misses", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("a_read", { x: 1 }, echoResult);
    cache.get("a_read", { x: 1 });  // hit
    cache.get("a_read", { x: 2 });  // miss
    cache.get("b_read", { x: 1 });  // miss
    expect(cache.stats()).toEqual({ size: 1, hits: 1, misses: 2 });
  });
});

describe("ToolCache.clear", () => {
  it("clears all entries and resets stats", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("a_read", { x: 1 }, echoResult);
    cache.get("a_read", { x: 1 });
    cache.clear();
    expect(cache.get("a_read", { x: 1 })).toBeNull();
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0 });
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL (ToolCache module doesn't exist)**

```bash
npx vitest run tests/unit/cache.test.ts
```
Expected: FAIL — `Cannot find module '../../src/cache.js'`

- [ ] **Step 3: Commit**

```bash
git add tests/unit/cache.test.ts
git commit -m "test: add failing cache unit tests (TDD RED)"
```

---

### Task 3: Implement ToolCache to pass tests (TDD GREEN)

**Files:**
- Create: `src/cache.ts`

**Interfaces:**
- Consumes: `CacheConfig` from `config-types.js`, `isMatch` from `micromatch`
- Produces: `ToolCache` class, `ToolResult` type, `CacheEntry` type

- [ ] **Step 1: Create src/cache.ts**

```ts
/**
 * MCP Guard — Tool Call Cache
 *
 * In-memory TTL+LRU cache for read-only MCP tool call results.
 * Cache key: toolName + sorted-keys JSON of args.
 * TTL: config ttl_per_tool → pattern-inferred → global default.
 *
 * @module cache
 */

import micromatch from "micromatch";
import type { CacheConfig } from "./config-types.js";

const { isMatch } = micromatch;

/** Cached tool call result */
export interface CacheEntry {
  result: ToolResult;
  expiresAt: number;
}

/** Tool call result (same shape as serverManager.callTool return) */
export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Pattern for search-like tools → shorter TTL */
const SEARCH_LIKE = /search|list|find|query/i;
/** Pattern for read-like tools → longer TTL */
const READ_LIKE = /read|get|describe|info|check/i;
/** Pattern for cacheable tools (canonical read verbs with optional server prefix) */
const CACHEABLE = /^(?:[^_]+_)?(search|list|find|query|read|get|describe|info|check)/i;

/** Generate deterministic cache key from toolName + sorted args */
function makeKey(toolName: string, args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    sorted[key] = args[key];
  }
  return JSON.stringify([toolName, sorted]);
}

export class ToolCache {
  private map = new Map<string, CacheEntry>();
  private order: string[] = [];
  private config: CacheConfig;
  private hits = 0;
  private misses = 0;

  constructor(config: CacheConfig) {
    this.config = config;
  }

  isCacheable(toolName: string): boolean {
    if (!this.config.enabled) return false;
    if (this.config.deny.length > 0 && this.config.deny.some((p) => isMatch(toolName, p))) {
      return false;
    }
    if (this.config.allow.length > 0) {
      return this.config.allow.some((p) => isMatch(toolName, p));
    }
    return CACHEABLE.test(toolName);
  }

  getTTL(toolName: string): number {
    if (this.config.ttl_per_tool?.[toolName] !== undefined) {
      return this.config.ttl_per_tool[toolName];
    }
    if (SEARCH_LIKE.test(toolName)) return 15;
    if (READ_LIKE.test(toolName)) return 60;
    return this.config.ttl;
  }

  get(toolName: string, args: Record<string, unknown>): ToolResult | null {
    if (!this.config.enabled) return null;
    const key = makeKey(toolName, args);
    const entry = this.map.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.order = this.order.filter((k) => k !== key);
      this.misses++;
      return null;
    }
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    this.hits++;
    return entry.result;
  }

  set(toolName: string, args: Record<string, unknown>, result: ToolResult): void {
    if (!this.config.enabled) return;
    if (result.isError) return;
    const key = makeKey(toolName, args);
    while (this.order.length >= this.config.max_entries) {
      const oldest = this.order.shift();
      if (oldest) this.map.delete(oldest);
    }
    this.map.set(key, { result, expiresAt: Date.now() + this.getTTL(toolName) * 1000 });
    this.order.push(key);
  }

  clear(): void {
    this.map.clear();
    this.order = [];
    this.hits = 0;
    this.misses = 0;
  }

  stats(): { size: number; hits: number; misses: number } {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}
```

- [ ] **Step 2: Run unit tests — expect PASS**

```bash
npx vitest run tests/unit/cache.test.ts
```
Expected: All 18 tests pass.

- [ ] **Step 3: Verify types compile**

```bash
npx tsc --noEmit
```
Expected: Clean exit.

- [ ] **Step 4: Commit**

```bash
git add src/cache.ts
git commit -m "feat: implement ToolCache with TTL+LRU (18 tests pass)"
```

---

### Task 4: Add config defaults and schema validation

**Files:**
- Modify: `src/config-loader.ts`
- Modify: `src/config-schema.ts`

**Interfaces:**
- Consumes: `CacheConfig` from Task 1
- Produces: Default cache config in `generateGuardConfig`, schema validation optional

- [ ] **Step 1: Add cache defaults in ConfigLoader.generateGuardConfig (~line 96)**

After the `compressor:` block, add:
```ts
cache: {
  enabled: false,
  ttl: 30,
  max_entries: 500,
  allow: [],
  deny: [],
},
```

- [ ] **Step 2: Add cache default fill in ConfigLoader.loadGuardConfig (~line 157)**

After the compressor block, add:
```ts
if (!config.cache) {
  config.cache = {
    enabled: false,
    ttl: 30,
    max_entries: 500,
    allow: [],
    deny: [],
  };
}
```

- [ ] **Step 3: Add cache to JSON schema in GUARD_CONFIG_SCHEMA (~line 67, after compressor block)**

Add after the `compressor:` block's closing `}`:
```ts
cache: {
  type: "object",
  properties: {
    enabled: { type: "boolean" },
    ttl: { type: "number", minimum: 0 },
    max_entries: { type: "number", minimum: 1 },
    allow: { type: "array", items: { type: "string" } },
    deny: { type: "array", items: { type: "string" } },
    ttl_per_tool: {
      type: "object",
      additionalProperties: { type: "number" },
    },
  },
  additionalProperties: false,
  description: "请求缓存配置",
},
```

- [ ] **Step 4: Run related tests**

```bash
npx vitest run tests/unit/config-types.test.ts tests/unit/config-loader.test.ts tests/unit/config-schema.test.ts
```
Expected: All pass.

- [ ] **Step 5: Verify types compile**

```bash
npx tsc --noEmit
```
Expected: Clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/config-loader.ts src/config-schema.ts
git commit -m "feat: add cache defaults and JSON schema validation"
```

---

### Task 5: Integrate ToolCache into GuardProxy

**Files:**
- Modify: `src/proxy.ts`

**Interfaces:**
- Consumes: `ToolCache` from `cache.js`, `CacheConfig` from `config-types.js`
- Produces: `GuardProxy` now has optional `cache` field, integrates in `forwardToolCall`

- [ ] **Step 1: Import ToolCache in proxy.ts (after other imports, ~line 25)**

```ts
import { ToolCache } from "./cache.js";
```

- [ ] **Step 2: Add cache field to GuardProxy class (~line 39)**

After `private fullTools: Tool[] = [];`, add:
```ts
/** Optional request cache (null when cache.enabled=false) */
private cache: ToolCache | null = null;
```

- [ ] **Step 3: Initialize cache in start() method (~line 80)**

After `this.requestCounter = 0;`, add:
```ts
// Initialize cache if configured
this.cache = this.config.cache?.enabled
  ? new ToolCache(this.config.cache)
  : null;
```

- [ ] **Step 4: Add cache check in forwardToolCall (~line 131, after policy trail)**

After `this.audit.log(ctx, result, trail, ...)`, before `return await this.serverManager.callTool(...)`:
```ts
// Cache check: return cached result if available
if (this.cache && this.cache.isCacheable(prefixedName)) {
  const cached = this.cache.get(prefixedName, args);
  if (cached) {
    // Audit cache hit
    this.audit.log(
      ctx,
      { allowed: true },
      [{ policy: "cache", result: "pass" }],
      this.sessionId,
      reqId,
      durationMs,
    );
    return cached;
  }
}

// Call upstream
const callResult = await this.serverManager.callTool(
  serverName,
  originalToolName,
  args,
);

// Cache write
if (this.cache && this.cache.isCacheable(prefixedName)) {
  this.cache.set(prefixedName, args, callResult);
}

return callResult;
```

Wait — this changes the structure. Let me be more precise about where to insert. Looking at the existing code:

```ts
      if (!result.allowed) {
        return { ... };
      }

      return await this.serverManager.callTool(
        serverName,
        originalToolName,
        args,
      );
```

The cache goes between the policy check and the upstream call. Let me write the exact replacement:

Replace the last part of forwardToolCall (from `if (!result.allowed)` onwards):

```ts
      if (!result.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: (result as Extract<PolicyResult, { allowed: false }>).reason ?? "Blocked by policy",
            },
          ],
          isError: true,
        };
      }

      // --- Cache check ---
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        const cached = this.cache.get(prefixedName, args);
        if (cached) {
          this.audit.log(
            ctx,
            { allowed: true },
            [{ policy: "cache", result: "pass" }],
            this.sessionId,
            this.requestCounter, // use existing reqId? No — reqId was already used for the policy audit above. Use a new one.
            Date.now() - startTime,
          );
          return cached;
        }
      }

      // --- Upstream call ---
      const callResult = await this.serverManager.callTool(
        serverName,
        originalToolName,
        args,
      );

      // --- Cache write ---
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        this.cache.set(prefixedName, args, callResult);
      }

      return callResult;
```

Hmm, the audit logging for cache hit uses a separate reqId which complicates things. Let me keep it simpler — cache hit doesn't need a second audit log since the policy pipeline audit already happened. Or better: move the audit after the cache check for cache misses, and skip the second audit for cache hits.

Actually, the cleanest approach: the policy audit already happened before the cache check. For cache hits we just return the cached result (no second audit). For cache misses, we proceed to upstream call, then cache write, then return. No extra audit complexity.

Let me rewrite the step more carefully.

- [ ] **Step 4: Insert cache logic in forwardToolCall**

Find the block in proxy.ts (currently around line 138-155):

```ts
      if (!result.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: (result as Extract<PolicyResult, { allowed: false }>).reason ?? "Blocked by policy",
            },
          ],
          isError: true,
        };
      }

      return await this.serverManager.callTool(
        serverName,
        originalToolName,
        args,
      );
```

Replace with:

```ts
      if (!result.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: (result as Extract<PolicyResult, { allowed: false }>).reason ?? "Blocked by policy",
            },
          ],
          isError: true,
        };
      }

      // Cache check — return cached result if hit
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        const cached = this.cache.get(prefixedName, args);
        if (cached) return cached;
      }

      const callResult = await this.serverManager.callTool(
        serverName,
        originalToolName,
        args,
      );

      // Cache write — store result for future calls
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        this.cache.set(prefixedName, args, callResult);
      }

      return callResult;
```

- [ ] **Step 5: Rebuild cache on reload() (~line 229)**

In the `reload()` method, after `this.config = newConfig;`:
```ts
// Rebuild cache with new config (clears old entries)
if (newConfig.cache?.enabled) {
  this.cache = new ToolCache(newConfig.cache);
} else {
  this.cache = null;
}
```

- [ ] **Step 6: Verify types compile**

```bash
npx tsc --noEmit
```
Expected: Clean exit.

- [ ] **Step 7: Run full test suite to check for regressions**

```bash
npx vitest run
```
Expected: All 369 existing tests pass + 18 new cache tests = 387 total, all green.

- [ ] **Step 8: Commit**

```bash
git add src/proxy.ts
git commit -m "feat: integrate ToolCache into GuardProxy forwardToolCall"
```

---

### Task 6: Add proxy-level cache behavior tests

**Files:**
- Modify: `tests/unit/proxy.test.ts`

**Interfaces:**
- Consumes: `GuardProxy` with `ToolCache`
- Produces: (test additions)

- [ ] **Step 1: Add cache hit test in proxy.test.ts**

Add after the existing `tools/call handler should audit-log blocked requests` test:

```ts
  // -----------------------------------------------------------------------
  // Cache: hit returns cached result without calling upstream
  // -----------------------------------------------------------------------
  it("should return cached result on cache hit, skipping upstream call", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: true,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });

    const upstreamResult = {
      content: [{ type: "text" as const, text: "fresh from upstream" }],
    };
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    // First call: cache miss, calls upstream
    const result1 = await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    });
    expect(result1).toEqual(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);

    // Second call with same args: cache hit, no upstream call
    const result2 = await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    });
    expect(result2).toEqual(upstreamResult);
    // callTool should still be 1 (not called again)
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Cache: non-cacheable tools bypass cache
  // -----------------------------------------------------------------------
  it("should not cache results for non-cacheable tools", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: true,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    // "create_repo" is not cacheable (match pattern excludes it)
    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "create_repo",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text" as const, text: "created" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await callHandler!({
      method: "tools/call",
      params: { name: "github_create_repo", arguments: { name: "x" } },
    });
    await callHandler!({
      method: "tools/call",
      params: { name: "github_create_repo", arguments: { name: "x" } },
    });

    // Both calls should go to upstream (not cached)
    expect(serverManager.callTool).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Cache: disabled config bypasses cache entirely
  // -----------------------------------------------------------------------
  it("should skip cache when disabled", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: false,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text" as const, text: "result" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "a" } },
    });
    await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "a" } },
    });

    expect(serverManager.callTool).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 2: Run proxy tests**

```bash
npx vitest run tests/unit/proxy.test.ts
```
Expected: All existing + 3 new cache tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/proxy.test.ts
git commit -m "test: add proxy-level cache behavior tests"
```

---

### Task 7: Full test suite verification + tsc

**Files:**
- (none — verification only)

- [ ] **Step 1: Run all tests**

```bash
npx vitest run
```
Expected: All tests pass (369 + 18 cache + 3 proxy cache = ~390 tests).

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```
Expected: Clean exit.

- [ ] **Step 3: Build**

```bash
npm run build
```
Expected: Clean build, dist/ updated.

- [ ] **Step 4: Commit (if any build artifacts changed)**

```bash
git status
# Only commit if dist/ changed
git add -A && git commit -m "chore: rebuild after cache feature"
```

---

### Task 8: Update docs and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `HANDOVER.md`
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Add entry to CHANGELOG under [Unreleased]**

```markdown
## [Unreleased]

### Added
- **Request cache TTL+LRU** — 只读工具调用结果内存缓存。配置项 `cache.enabled`（默认 false）启用。按工具名模式自动推断 TTL（search 类 15s, read 类 60s），支持 `allow/deny` 精确控制和 `ttl_per_tool` 逐工具覆盖。LRU 淘汰，默认 500 条上限。`isError: true` 不缓存。
```

- [ ] **Step 2: Update HANDOVER.md**

Mark `请求缓存 TTL+LRU` as completed `[x]`.

- [ ] **Step 3: Update ROADMAP.md**

Mark `请求缓存 TTL+LRU` as `✅ 已完成`.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md HANDOVER.md docs/ROADMAP.md
git commit -m "docs: update CHANGELOG/HANDOVER/ROADMAP for cache feature"
```

---

## Self-Review

1. **Spec coverage:** Each spec requirement maps to a task:
   - CacheConfig type → Task 1
   - ToolCache class → Task 3
   - TTL inference logic → Task 3 (SEARCH_LIKE/READ_LIKE patterns)
   - isCacheable deny/allow/pattern → Task 2 tests, Task 3 impl
   - Cache key (sorted args) → Task 2 tests (key generation), Task 3 impl
   - LRU eviction → Task 2 tests (LRU eviction), Task 3 impl
   - TTL expiry → Task 2 tests (TTL expiry), Task 3 impl
   - isError not cached → Task 2 tests, Task 3 impl
   - Config defaults → Task 4
   - Proxy integration → Task 5
   - Proxy test coverage → Task 6
   - Hot reload → Task 5 Step 5
   - Disabled = zero overhead → Task 6 (cache disabled test)

2. **Placeholder scan:** No TBD/TODO. All code blocks are complete.

3. **Type consistency:** `ToolCache`, `CacheConfig`, `ToolResult`, `CacheEntry` used consistently across tasks. Import paths verified against existing project structure (`../../src/cache.js`, `../../src/config-types.js`).
