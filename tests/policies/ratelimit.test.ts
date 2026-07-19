import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  RateLimitPolicy,
  parseRateLimitConfig,
} from "../../src/policies/ratelimit.js";
import type { RateLimitConfig } from "../../src/config-types.js";
import type { PolicyContext } from "../../src/types.js";

describe("parseRateLimitConfig", () => {
  it('parses "60/min" string format', () => {
    const result = parseRateLimitConfig("60/min");
    expect(result).toEqual({ windowMs: 60000, maxRequests: 60 });
  });

  it('parses "10/second" string format', () => {
    const result = parseRateLimitConfig("10/second");
    expect(result).toEqual({ windowMs: 1000, maxRequests: 10 });
  });

  it('parses "100/hour" string format', () => {
    const result = parseRateLimitConfig("100/hour");
    expect(result).toEqual({ windowMs: 3600000, maxRequests: 100 });
  });

  it('parses "5/s" shorthand string format', () => {
    const result = parseRateLimitConfig("5/s");
    expect(result).toEqual({ windowMs: 1000, maxRequests: 5 });
  });

  it('parses "30/m" shorthand string format', () => {
    const result = parseRateLimitConfig("30/m");
    expect(result).toEqual({ windowMs: 60000, maxRequests: 30 });
  });

  it('parses "2/h" shorthand string format', () => {
    const result = parseRateLimitConfig("2/h");
    expect(result).toEqual({ windowMs: 3600000, maxRequests: 2 });
  });

  it("parses number format as requests per second", () => {
    const result = parseRateLimitConfig(100);
    expect(result).toEqual({ windowMs: 1000, maxRequests: 100 });
  });

  it("parses zero number format", () => {
    const result = parseRateLimitConfig(0);
    expect(result).toEqual({ windowMs: 1000, maxRequests: 0 });
  });

  it("parses object format", () => {
    const result = parseRateLimitConfig({
      window_ms: 60000,
      max_requests: 100,
    });
    expect(result).toEqual({ windowMs: 60000, maxRequests: 100 });
  });

  it("parses object format with different values", () => {
    const result = parseRateLimitConfig({
      window_ms: 5000,
      max_requests: 10,
    });
    expect(result).toEqual({ windowMs: 5000, maxRequests: 10 });
  });

  it("parses empty string as unlimited", () => {
    const result = parseRateLimitConfig("");
    expect(result).toEqual({ windowMs: 0, maxRequests: Infinity });
  });

  it("parses whitespace-only string as unlimited", () => {
    const result = parseRateLimitConfig("  ");
    expect(result).toEqual({ windowMs: 0, maxRequests: Infinity });
  });

  it("throws on invalid string format", () => {
    expect(() => parseRateLimitConfig("invalid")).toThrow(
      "Invalid rate limit string",
    );
  });

  it("throws on unknown unit in string", () => {
    expect(() => parseRateLimitConfig("10/day")).toThrow(
      "Invalid rate limit string",
    );
  });
});

describe("RateLimitPolicy", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function ctx(
    toolName: string,
    args: Record<string, unknown> = {},
    overrides: Partial<PolicyContext> = {},
  ): PolicyContext {
    return {
      toolName,
      arguments: args,
      serverName: "test-server",
      ...overrides,
    };
  }

  describe("basic allow/block", () => {
    it("allows first request within limit", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 100 },
      };
      const policy = new RateLimitPolicy(config);
      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(true);
    });

    it("blocks when rate limit exceeded", async () => {
      // 1 request per minute — exhaust it immediately
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 1 },
      };
      const policy = new RateLimitPolicy(config);

      // First request should pass
      const first = await policy.check(ctx("test_tool"));
      expect(first.allowed).toBe(true);

      // Second request should be blocked
      const second = await policy.check(ctx("test_tool"));
      expect(second.allowed).toBe(false);
      expect(second).toHaveProperty("reason");
      expect(second).toHaveProperty("policy", "ratelimit");
    });

    it("allows at exactly the limit boundary", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 3 },
      };
      const policy = new RateLimitPolicy(config);

      // Exhaust 3 tokens
      for (let i = 0; i < 3; i++) {
        const result = await policy.check(ctx("test_tool"));
        expect(result.allowed).toBe(true);
      }

      // 4th should be blocked
      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(false);
    });
  });

  describe("config parsing integration", () => {
    it("works with number format (rps)", async () => {
      const config: RateLimitConfig = {
        default: 1000, // 1000 requests per second — very high, should allow
      };
      const policy = new RateLimitPolicy(config);
      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(true);
    });

    it("works with string format", async () => {
      const config: RateLimitConfig = {
        default: "1000/min", // 1000 per minute — very high, should allow
      };
      const policy = new RateLimitPolicy(config);
      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(true);
    });

    it("works with object format", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 100 },
      };
      const policy = new RateLimitPolicy(config);
      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(true);
    });
  });

  describe("per-agent rate limits", () => {
    it("different agents have independent buckets", async () => {
      // agent1: 1 req/min, agent2: 1000 req/sec (effectively unlimited)
      const config: RateLimitConfig = {
        default: 1000,
        per_agent: {
          agent1: { window_ms: 60000, max_requests: 1 },
        },
      };
      const policy = new RateLimitPolicy(config);

      // agent1 uses first token
      const r1 = await policy.check(ctx("test", {}, { agentId: "agent1" }));
      expect(r1.allowed).toBe(true);

      // agent1 exceeds limit
      const r2 = await policy.check(ctx("test", {}, { agentId: "agent1" }));
      expect(r2.allowed).toBe(false);

      // agent2 still has its own bucket (via default, unlimited)
      const r3 = await policy.check(ctx("test", {}, { agentId: "agent2" }));
      expect(r3.allowed).toBe(true);
    });

    it("uses per_agent when agentId matches", async () => {
      const config: RateLimitConfig = {
        default: 1000,
        per_agent: {
          restricted_agent: { window_ms: 60000, max_requests: 1 },
        },
      };
      const policy = new RateLimitPolicy(config);
      // First call should pass
      const r1 = await policy.check(
        ctx("test", {}, { agentId: "restricted_agent" }),
      );
      expect(r1.allowed).toBe(true);

      // Second call should fail
      const r2 = await policy.check(
        ctx("test", {}, { agentId: "restricted_agent" }),
      );
      expect(r2.allowed).toBe(false);
    });

    it("falls back to default for agentId without per_agent entry", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 2 },
        per_agent: {
          special: { window_ms: 60000, max_requests: 1 },
        },
      };
      const policy = new RateLimitPolicy(config);

      // agent "other" should use default (2 req/min)
      const r1 = await policy.check(ctx("test", {}, { agentId: "other" }));
      expect(r1.allowed).toBe(true);

      const r2 = await policy.check(ctx("test", {}, { agentId: "other" }));
      expect(r2.allowed).toBe(true);

      // Third call should fail (exhausted default)
      const r3 = await policy.check(ctx("test", {}, { agentId: "other" }));
      expect(r3.allowed).toBe(false);
    });
  });

  describe("token refill", () => {
    it("refills tokens over time", async () => {
      // 1 token per 100ms
      const config: RateLimitConfig = {
        default: { window_ms: 100, max_requests: 1 },
      };
      const policy = new RateLimitPolicy(config);

      // First call passes
      const r1 = await policy.check(ctx("test"));
      expect(r1.allowed).toBe(true);

      // Second call immediately blocked
      const r2 = await policy.check(ctx("test"));
      expect(r2.allowed).toBe(false);

      // Wait 150ms for token refill
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Token should have refilled
      const r3 = await policy.check(ctx("test"));
      expect(r3.allowed).toBe(true);
    });

    it("multiple refills accumulate over time", async () => {
      // 1 token per 50ms, max 3 tokens
      const config: RateLimitConfig = {
        default: { window_ms: 150, max_requests: 3 },
      };
      const policy = new RateLimitPolicy(config);

      // Exhaust all 3 tokens
      for (let i = 0; i < 3; i++) {
        const r = await policy.check(ctx("test"));
        expect(r.allowed).toBe(true);
      }

      const exhausted = await policy.check(ctx("test"));
      expect(exhausted.allowed).toBe(false);

      // Wait 200ms — should refill ~4 tokens, but capped at 3
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should have 3 tokens again (capped at max)
      for (let i = 0; i < 3; i++) {
        const r = await policy.check(ctx("test"));
        expect(r.allowed).toBe(true);
      }

      // 4th should be blocked
      const blocked = await policy.check(ctx("test"));
      expect(blocked.allowed).toBe(false);
    });

    it("tokens are capped at max_requests", async () => {
      // High rate, but we wait long enough that tokens would overflow if not capped
      const config: RateLimitConfig = {
        default: { window_ms: 1000, max_requests: 5 },
      };
      const policy = new RateLimitPolicy(config);

      // Wait 2000ms = should refill 10 tokens, but capped at 5
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Use 5 times, all should pass
      for (let i = 0; i < 5; i++) {
        const r = await policy.check(ctx("test"));
        expect(r.allowed).toBe(true);
      }

      // 6th should be blocked
      const r = await policy.check(ctx("test"));
      expect(r.allowed).toBe(false);
    });
  });

  describe("config edge cases", () => {
    it("config with only default rate works", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 5 },
      };
      const policy = new RateLimitPolicy(config);

      // All requests should count against default
      for (let i = 0; i < 5; i++) {
        const r = await policy.check(ctx("test"));
        expect(r.allowed).toBe(true);
      }

      const blocked = await policy.check(ctx("test"));
      expect(blocked.allowed).toBe(false);
    });

    it("empty string defaults to unlimited (allow all)", async () => {
      const config: RateLimitConfig = {
        default: "",
      };
      const policy = new RateLimitPolicy(config);

      // Many requests should all be allowed
      for (let i = 0; i < 100; i++) {
        const r = await policy.check(ctx("test"));
        expect(r.allowed).toBe(true);
      }
    });

    it("per_agent with empty string is unlimited", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 1 },
        per_agent: {
          privileged: "",
        },
      };
      const policy = new RateLimitPolicy(config);

      // Default agent gets blocked after 1
      const r1 = await policy.check(ctx("test", {}, { agentId: "default" }));
      expect(r1.allowed).toBe(true);

      const r2 = await policy.check(ctx("test", {}, { agentId: "default" }));
      expect(r2.allowed).toBe(false);

      // Privileged agent is unlimited
      for (let i = 0; i < 100; i++) {
        const r = await policy.check(
          ctx("test", {}, { agentId: "privileged" }),
        );
        expect(r.allowed).toBe(true);
      }
    });

    it("server name as fallback key", async () => {
      // Different server names should have independent buckets
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 1 },
      };
      const policy = new RateLimitPolicy(config);

      // server-a uses its bucket
      const r1 = await policy.check(
        ctx("test", {}, { serverName: "server-a" }),
      );
      expect(r1.allowed).toBe(true);

      const r2 = await policy.check(
        ctx("test", {}, { serverName: "server-a" }),
      );
      expect(r2.allowed).toBe(false);

      // server-b has its own bucket
      const r3 = await policy.check(
        ctx("test", {}, { serverName: "server-b" }),
      );
      expect(r3.allowed).toBe(true);
    });
  });

  describe("policy interface compliance", () => {
    it("has correct name and phase", () => {
      const config: RateLimitConfig = {
        default: 100,
      };
      const policy = new RateLimitPolicy(config);
      expect(policy.name).toBe("ratelimit");
      expect(policy.phase).toBe("tool_call");
    });

    it("returns proper deny format", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 0 },
      };
      const policy = new RateLimitPolicy(config);

      const result = await policy.check(ctx("test_tool"));
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty("reason");
      expect(result).toHaveProperty("policy", "ratelimit");
    });

    it("reset clears all buckets", async () => {
      const config: RateLimitConfig = {
        default: { window_ms: 60000, max_requests: 1 },
      };
      const policy = new RateLimitPolicy(config);

      const r1 = await policy.check(ctx("test"));
      expect(r1.allowed).toBe(true);

      const r2 = await policy.check(ctx("test"));
      expect(r2.allowed).toBe(false);

      policy.reset();

      const r3 = await policy.check(ctx("test"));
      expect(r3.allowed).toBe(true);
    });
  });
});
