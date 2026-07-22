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

/** Verbs for search-like tools — shorter TTL (15s), results change frequently */
const SEARCH_VERBS: ReadonlySet<string> = new Set(["search", "list", "find", "query"]);

/** Verbs for read-like tools — longer TTL (60s), results are stable */
const READ_VERBS: ReadonlySet<string> = new Set(["read", "get", "describe", "info", "check"]);

/** All cacheable verbs (union of SEARCH_VERBS + READ_VERBS) */
const CACHEABLE_VERBS = [...SEARCH_VERBS, ...READ_VERBS];

/** Build regex from a set of verb names: "search|list|find|query" */
function buildVerbRegex(verbs: ReadonlySet<string> | string[]): RegExp {
  return new RegExp([...verbs].join("|"), "i");
}

/** Pattern for search-like tools → shorter TTL */
const SEARCH_LIKE = buildVerbRegex(SEARCH_VERBS);
/** Pattern for read-like tools → longer TTL */
const READ_LIKE = buildVerbRegex(READ_VERBS);
/** Pattern for cacheable tools (canonical read verbs with optional server prefix) */
const CACHEABLE = new RegExp(`^(?:[^_]+_)?(${buildVerbRegex(CACHEABLE_VERBS).source})`, "i");

/** Default TTL for search-like tools (seconds) */
const SEARCH_TTL = 15;
/** Default TTL for read-like tools (seconds) */
const READ_TTL = 60;

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
  private toolHits = new Map<string, number>();
  private toolMisses = new Map<string, number>();

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
    if (SEARCH_LIKE.test(toolName)) return SEARCH_TTL;
    if (READ_LIKE.test(toolName)) return READ_TTL;
    return this.config.ttl;
  }

  get(toolName: string, args: Record<string, unknown>): ToolResult | null {
    if (!this.config.enabled) return null;
    const key = makeKey(toolName, args);
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      this.toolMisses.set(toolName, (this.toolMisses.get(toolName) ?? 0) + 1);
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.order = this.order.filter((k) => k !== key);
      this.misses++;
      this.toolMisses.set(toolName, (this.toolMisses.get(toolName) ?? 0) + 1);
      return null;
    }
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    this.hits++;
    this.toolHits.set(toolName, (this.toolHits.get(toolName) ?? 0) + 1);
    return entry.result;
  }

  set(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ttlMs?: number,
  ): void {
    if (!this.config.enabled) return;
    if (result.isError) return;
    const key = makeKey(toolName, args);
    // Use upstream ttlMs hint if provided (already in milliseconds),
    // otherwise fall back to pattern-inferred TTL (getTTL returns seconds, convert to ms)
    const ttl = ttlMs !== undefined
      ? ttlMs
      : this.getTTL(toolName) * 1000;
    this.map.set(key, { result, expiresAt: Date.now() + ttl });
    this.order = this.order.filter((k) => k !== key);
    this.order.push(key);
    while (this.order.length > this.config.max_entries) {
      const oldest = this.order.shift();
      if (oldest) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    this.order = [];
    this.hits = 0;
    this.misses = 0;
    this.toolHits.clear();
    this.toolMisses.clear();
  }

  stats(): { size: number; hits: number; misses: number; byTool: Record<string, { hits: number; misses: number }> } {
    const byTool: Record<string, { hits: number; misses: number }> = {};
    const allTools = new Set([...this.toolHits.keys(), ...this.toolMisses.keys()]);
    for (const tool of allTools) {
      byTool[tool] = {
        hits: this.toolHits.get(tool) ?? 0,
        misses: this.toolMisses.get(tool) ?? 0,
      };
    }
    return { size: this.map.size, hits: this.hits, misses: this.misses, byTool };
  }
}