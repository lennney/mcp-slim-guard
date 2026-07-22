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