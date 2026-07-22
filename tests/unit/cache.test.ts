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

  it("uses upstream ttlMs when provided (overrides pattern TTL)", () => {
    vi.useFakeTimers();
    const cache = new ToolCache(makeConfig({ ttl: 30, enabled: true }));
    // ttlMs=5000 means 5 seconds, shorter than default 30s
    cache.set("read_foo", { id: 1 }, { content: [{ type: "text", text: "ok" }] }, 5000);

    // Should hit within 5 seconds
    vi.advanceTimersByTime(4000);
    expect(cache.get("read_foo", { id: 1 })).not.toBeNull();

    // Should miss after 5 seconds
    vi.advanceTimersByTime(2000);
    expect(cache.get("read_foo", { id: 1 })).toBeNull();

    vi.useRealTimers();
  });

  it("falls back to pattern TTL when ttlMs is not provided", () => {
    vi.useFakeTimers();
    const cache = new ToolCache(makeConfig({ ttl: 30, enabled: true }));
    // No ttlMs arg — should use search-like TTL (15s) for "search_foo"
    cache.set("search_foo", { q: "test" }, { content: [{ type: "text", text: "ok" }] });

    // Should hit within 15 seconds
    vi.advanceTimersByTime(14000);
    expect(cache.get("search_foo", { q: "test" })).not.toBeNull();

    // Should miss after 15 seconds
    vi.advanceTimersByTime(2000);
    expect(cache.get("search_foo", { q: "test" })).toBeNull();

    vi.useRealTimers();
  });

describe("ToolCache TTL expiry", () => {
  it("expires entry after TTL seconds", () => {
    vi.useFakeTimers();
    const cache = new ToolCache(makeConfig({ ttl: 1 }));
    cache.set("test_write", { query: "x" }, echoResult);
    expect(cache.get("test_write", { query: "x" })).toEqual(echoResult);
    vi.advanceTimersByTime(1500);
    expect(cache.get("test_write", { query: "x" })).toBeNull();
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
    expect(cache.stats()).toEqual({
      size: 1,
      hits: 1,
      misses: 2,
      byTool: {
        a_read: { hits: 1, misses: 1 },
        b_read: { hits: 0, misses: 1 },
      },
    });
  });

  it("tracks per-tool stats across multiple tools", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("github_search", { q: "mcp" }, echoResult);
    cache.set("slack_read", { channel: "C01" }, echoResult);

    cache.get("github_search", { q: "mcp" }); // hit
    cache.get("github_search", { q: "mcp" }); // hit
    cache.get("github_search", { q: "other" }); // miss
    cache.get("slack_read", { channel: "C01" }); // hit
    cache.get("slack_read", { channel: "C02" }); // miss

    const stats = cache.stats();
    expect(stats.byTool["github_search"]).toEqual({ hits: 2, misses: 1 });
    expect(stats.byTool["slack_read"]).toEqual({ hits: 1, misses: 1 });
  });

  it("byTool excludes tools that were never accessed via get()", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("a_read", { x: 1 }, echoResult); // set() doesn't increment stats
    expect(cache.stats().byTool).toEqual({});
  });
});

describe("ToolCache.clear", () => {
  it("clears all entries and resets stats", () => {
    const cache = new ToolCache(makeConfig());
    cache.set("a_read", { x: 1 }, echoResult);
    cache.get("a_read", { x: 1 });
    cache.clear();
    expect(cache.stats()).toEqual({ size: 0, hits: 0, misses: 0, byTool: {} });
    expect(cache.get("a_read", { x: 1 })).toBeNull();
  });
});