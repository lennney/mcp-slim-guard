/**
 * 速率限制策略（Token Bucket 算法）
 *
 * 纯内存令牌桶，按 agentId/serverName 分桶，支持三种配置格式：
 * - 数字：每秒请求数
 * - 对象：{ window_ms, max_requests }
 * - 字符串：如 "60/min"、"10/second"、"100/hour"
 * - 空字符串：无限制
 *
 * @module policies/ratelimit
 */

import type { Policy, PolicyContext, PolicyResult } from "../types.js";
import type { RateLimitConfig } from "../config-types.js";

/** 解析后的速率限制参数 */
interface ParsedRateLimit {
  windowMs: number;
  maxRequests: number;
}

/** 令牌桶状态 */
interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const DEFAULT_KEY = "default";

/**
 * 速率限制策略。
 *
 * 使用 Token Bucket 算法进行速率限制：
 * 1. 每个 key（agentId / serverName）独立桶
 * 2. 基于时间差自动补充令牌
 * 3. 每次允许消耗 1 个令牌
 */
export class RateLimitPolicy implements Policy {
  readonly name = "ratelimit";
  readonly phase = "tool_call" as const;

  private buckets = new Map<string, TokenBucket>();
  private defaultLimit: ParsedRateLimit;
  private perAgentLimits: Map<string, ParsedRateLimit>;

  constructor(private config: RateLimitConfig) {
    this.defaultLimit = parseRateLimitConfig(config.default);
    this.perAgentLimits = new Map();
    if (config.per_agent) {
      for (const [agentId, limit] of Object.entries(config.per_agent)) {
        this.perAgentLimits.set(agentId, parseRateLimitConfig(limit));
      }
    }
  }

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    // 确定使用的速率限制配置
    const limit = this.getLimitForContext(ctx);

    // 无限制配置直接放行
    if (limit.maxRequests === Infinity || limit.windowMs <= 0) {
      return { allowed: true };
    }

    // 确定桶 key：优先 agentId，其次 serverName，最后 "default"
    const key = ctx.agentId ?? ctx.serverName ?? DEFAULT_KEY;

    // 获取或创建令牌桶
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: limit.maxRequests, lastRefill: Date.now() };
      this.buckets.set(key, bucket);
    }

    // 基于时间差补充令牌
    this.refillBucket(bucket, limit);

    // 检查是否有足够令牌
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Rate limit exceeded for key "${key}" (${limit.maxRequests} per ${limit.windowMs}ms)`,
      policy: "ratelimit",
    };
  }

  /**
   * 根据上下文获取适用的速率限制。
   * 优先使用 per_agent 配置，无匹配时回退到 default。
   */
  private getLimitForContext(ctx: PolicyContext): ParsedRateLimit {
    if (ctx.agentId && this.perAgentLimits.has(ctx.agentId)) {
      return this.perAgentLimits.get(ctx.agentId)!;
    }
    return this.defaultLimit;
  }

  /**
   * 基于时间差补充令牌。
   * tokens += elapsed * (maxRequests / windowMs)，上限为 maxRequests。
   */
  private refillBucket(bucket: TokenBucket, limit: ParsedRateLimit): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed <= 0) return;

    const ratePerMs = limit.maxRequests / limit.windowMs;
    const newTokens = elapsed * ratePerMs;
    bucket.tokens = Math.min(limit.maxRequests, bucket.tokens + newTokens);
    bucket.lastRefill = now;
  }

  /** 重置所有桶（测试用） */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * 解析速率限制配置为统一格式。
 *
 * 支持三种格式：
 * - 数字：每秒请求数
 * - 对象：{ window_ms, max_requests }
 * - 字符串：如 "60/min"、"10/second"、"100/hour"
 * - 空字符串：无限制
 */
export function parseRateLimitConfig(
  config: number | { window_ms: number; max_requests: number } | string,
): ParsedRateLimit {
  if (typeof config === "number") {
    return { windowMs: 1000, maxRequests: config };
  }

  if (typeof config === "object" && config !== null) {
    return { windowMs: config.window_ms, maxRequests: config.max_requests };
  }

  if (typeof config === "string") {
    if (config.trim() === "") {
      return { windowMs: 0, maxRequests: Infinity };
    }
    return parseRateLimitString(config);
  }

  throw new Error(`Invalid rate limit config type: ${typeof config}`);
}

/**
 * 解析速率限制字符串。
 *
 * 支持的格式：
 * - "N/min" 或 "N/m": N 次每分钟
 * - "N/second" 或 "N/s": N 次每秒
 * - "N/hour" 或 "N/h": N 次每小时
 */
export function parseRateLimitString(str: string): ParsedRateLimit {
  const match = str.match(/^(\d+)\s*\/\s*(min|second|hour|s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid rate limit string: "${str}"`);
  }

  const count = parseInt(match[1], 10);
  const unit = match[2];

  let windowMs: number;
  switch (unit) {
    case "s":
    case "second":
      windowMs = 1000;
      break;
    case "m":
    case "min":
      windowMs = 60000;
      break;
    case "h":
    case "hour":
      windowMs = 3600000;
      break;
    default:
      throw new Error(`Unknown rate limit unit: "${unit}"`);
  }

  return { windowMs, maxRequests: count };
}
