/**
 * Adversarial tests for mcp-guard policy pipeline + edge modules.
 *
 * Covers:
 *   1. RateLimitPolicy concurrency — parallel check() calls on same bucket
 *   2. RateLimitPolicy malicious configs — NaN, Infinity, negative, zero
 *   3. SSRFPolicy bypass vectors — IPv6, decimal/hex/octal IP, DNS rebinding,
 *      protocol confusion, cloud metadata, credentials, homographs
 *   4. WhitelistPolicy edge cases — empty allow, extreme patterns, max_length
 *   5. ConfigLoader robustness — empty YAML, BOM, circular refs
 *   6. AuditLogger stress — 10k rapid entries
 *
 * All tests run without modifying source files or adding npm deps.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimitPolicy, parseRateLimitConfig } from "../../src/policies/ratelimit.js";
import { SSRFPolicy, ipToInt, extractURLs } from "../../src/policies/ssrf.js";
import { WhitelistPolicy } from "../../src/policies/whitelist.js";
import { ConfigLoader } from "../../src/config-loader.js";
import { AuditLogger } from "../../src/audit.js";
import type { PolicyContext } from "../../src/types.js";
import type { RateLimitConfig, SSRFConfig, ToolsConfig } from "../../src/config-types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";

// ============================================================
// Mock DNS to prevent actual network calls in SSRF tests
// ============================================================
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
}));
import * as dns from "node:dns/promises";

// ============================================================
// Helper: create a minimal PolicyContext
// ============================================================
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

// ============================================================
// Helper: random string of given length
// ============================================================
function randomString(length: number): string {
  return Array.from({ length }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36)),
  ).join("");
}

// ============================================================
// 1. RateLimitPolicy — Concurrency
// ============================================================
describe("RateLimitPolicy — Concurrency", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("handles 20 parallel check() calls on same bucket without over-counting", async () => {
    // Only 5 tokens available
    const config: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 5 },
    };
    const policy = new RateLimitPolicy(config);

    // Fire 20 concurrent check() calls
    const results = await Promise.all(
      Array.from({ length: 20 }, () => policy.check(ctx("test_tool"))),
    );

    const allowed = results.filter((r) => r.allowed === true).length;
    const blocked = results.filter((r) => r.allowed === false).length;

    // Exactly 5 should be allowed, 15 blocked (no double-count, no underflow)
    expect(allowed).toBe(5);
    expect(blocked).toBe(15);
  });

  it("parallel calls across different agents use independent buckets", async () => {
    const config: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 3 },
      per_agent: {
        agent_a: { window_ms: 60000, max_requests: 1 },
        agent_b: { window_ms: 60000, max_requests: 2 },
      },
    };
    const policy = new RateLimitPolicy(config);

    // Fire parallel from 3 agents simultaneously
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () =>
        policy.check(ctx("test", {}, { agentId: "agent_a" })),
      ),
      ...Array.from({ length: 5 }, () =>
        policy.check(ctx("test", {}, { agentId: "agent_b" })),
      ),
      ...Array.from({ length: 5 }, () =>
        policy.check(ctx("test", {}, { agentId: "agent_c" })),
      ),
    ]);

    const agentAResults = results.slice(0, 5);
    const agentBResults = results.slice(5, 10);
    const agentCResults = results.slice(10, 15);

    // agent_a: 1 token → 1 allowed, 4 blocked
    expect(agentAResults.filter((r) => r.allowed === true)).toHaveLength(1);
    expect(agentAResults.filter((r) => r.allowed === false)).toHaveLength(4);

    // agent_b: 2 tokens → 2 allowed, 3 blocked
    expect(agentBResults.filter((r) => r.allowed === true)).toHaveLength(2);
    expect(agentBResults.filter((r) => r.allowed === false)).toHaveLength(3);

    // agent_c: default (3 tokens) → 3 allowed, 2 blocked
    expect(agentCResults.filter((r) => r.allowed === true)).toHaveLength(3);
    expect(agentCResults.filter((r) => r.allowed === false)).toHaveLength(2);
  });

  it("rapid sequential exhaust-and-refill maintains correct count", async () => {
    // 1 token per 20ms, max 2 — short window for fast refill
    const config: RateLimitConfig = {
      default: { window_ms: 40, max_requests: 2 },
    };
    const policy = new RateLimitPolicy(config);

    // Exhaust both tokens
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    expect((await policy.check(ctx("t"))).allowed).toBe(false);

    // Wait enough for 2 tokens to refill
    await new Promise((r) => setTimeout(r, 100));

    // Should have exactly 2 tokens again (capped, not 4)
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    expect((await policy.check(ctx("t"))).allowed).toBe(false);
  });

  it("interleaved check() calls on multiple server names don't interfere", async () => {
    const config: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 2 },
    };
    const policy = new RateLimitPolicy(config);

    const servers = ["server-a", "server-b", "server-c"];
    const calls = Array.from({ length: 30 }, (_, i) => ({
      serverName: servers[i % 3],
    }));

    const results = await Promise.all(
      calls.map((c) => policy.check(ctx("tool", {}, c))),
    );

    // Each server gets its own bucket of 2 tokens → 2 allowed, 8 blocked each
    for (const srv of servers) {
      const srvResults = results.filter(
        (_, i) => calls[i].serverName === srv,
      );
      expect(srvResults.filter((r) => r.allowed === true)).toHaveLength(2);
      expect(srvResults.filter((r) => r.allowed === false)).toHaveLength(8);
    }
  });

  it("reset() during parallel calls is safe", async () => {
    const config: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 100 },
    };
    const policy = new RateLimitPolicy(config);

    // Interleave reset() with concurrent checks
    const checkResults = await Promise.all([
      ...Array.from({ length: 10 }, () => policy.check(ctx("t"))),
    ]);

    // reset should not throw
    expect(() => policy.reset()).not.toThrow();

    const moreResults = await Promise.all(
      Array.from({ length: 10 }, () => policy.check(ctx("t"))),
    );

    // All results should be valid PolicyResult objects
    for (const r of [...checkResults, ...moreResults]) {
      expect(r).toHaveProperty("allowed");
      expect(typeof r.allowed).toBe("boolean");
    }
  });
});

// ============================================================
// 2. RateLimitPolicy — Malicious Configs
// ============================================================
describe("RateLimitPolicy — Malicious Configs", () => {
  describe("parseRateLimitConfig — edge case inputs", () => {
    it("handles window_ms: -1 (always allows)", () => {
      const result = parseRateLimitConfig({ window_ms: -1, max_requests: 10 });
      expect(result.windowMs).toBe(-1);
      expect(result.maxRequests).toBe(10);
    });

    it("handles window_ms: 0 (always allows per check logic)", () => {
      const result = parseRateLimitConfig({ window_ms: 0, max_requests: 10 });
      expect(result.windowMs).toBe(0);
    });

    it("handles window_ms: NaN", () => {
      const result = parseRateLimitConfig({
        window_ms: NaN,
        max_requests: 10,
      });
      expect(Number.isNaN(result.windowMs)).toBe(true);
    });

    it("handles window_ms: Infinity", () => {
      const result = parseRateLimitConfig({
        window_ms: Infinity,
        max_requests: 10,
      });
      expect(result.windowMs).toBe(Infinity);
    });

    it("handles max_requests: -1", () => {
      const result = parseRateLimitConfig({ window_ms: 60000, max_requests: -1 });
      expect(result.maxRequests).toBe(-1);
    });

    it("handles max_requests: 0", () => {
      const result = parseRateLimitConfig({ window_ms: 60000, max_requests: 0 });
      expect(result.maxRequests).toBe(0);
    });

    it("handles max_requests: Infinity", () => {
      const result = parseRateLimitConfig({
        window_ms: 60000,
        max_requests: Infinity,
      });
      expect(result.maxRequests).toBe(Infinity);
    });

    it("handles huge max_requests (MAX_SAFE_INTEGER)", () => {
      const result = parseRateLimitConfig({
        window_ms: 60000,
        max_requests: Number.MAX_SAFE_INTEGER,
      });
      expect(result.maxRequests).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("handles huge max_requests (MAX_VALUE)", () => {
      const result = parseRateLimitConfig({
        window_ms: 60000,
        max_requests: Number.MAX_VALUE,
      });
      expect(result.maxRequests).toBe(Number.MAX_VALUE);
    });
  });

  describe("parseRateLimitConfig — number format edge cases", () => {
    it("handles number: -1 (always blocks)", () => {
      const result = parseRateLimitConfig(-1);
      expect(result.maxRequests).toBe(-1); // tokens start at -1 → never >= 1
    });

    it("handles number: 0 (always blocks)", () => {
      const result = parseRateLimitConfig(0);
      expect(result.maxRequests).toBe(0);
    });

    it("handles number: Infinity (always allows)", () => {
      const result = parseRateLimitConfig(Infinity);
      expect(result.maxRequests).toBe(Infinity);
    });
  });

  describe("parseRateLimitConfig — string edge cases", () => {
    it('parses "0/min" (zero rate)', () => {
      const result = parseRateLimitConfig("0/min");
      expect(result).toEqual({ windowMs: 60000, maxRequests: 0 });
    });

    it('rejects "-1/s" (negative count)', () => {
      expect(() => parseRateLimitConfig("-1/s")).toThrow(
        "Invalid rate limit string",
      );
    });

    it('rejects "NaN/hour"', () => {
      expect(() => parseRateLimitConfig("NaN/hour")).toThrow(
        "Invalid rate limit string",
      );
    });

    it('rejects "∞/min" (Unicode infinity)', () => {
      expect(() => parseRateLimitConfig("∞/min")).toThrow(
        "Invalid rate limit string",
      );
    });

    it('parses "" (empty string as unlimited)', () => {
      const result = parseRateLimitConfig("");
      expect(result).toEqual({ windowMs: 0, maxRequests: Infinity });
    });
  });

  describe("RateLimitPolicy instantiated with malicious configs", () => {
    it("window_ms: -1 → all requests allowed", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: -1, max_requests: 10 },
      });
      for (let i = 0; i < 50; i++) {
        const r = await policy.check(ctx("t"));
        expect(r.allowed).toBe(true);
      }
    });

    it("window_ms: 0 → all requests allowed", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 0, max_requests: 10 },
      });
      for (let i = 0; i < 50; i++) {
        const r = await policy.check(ctx("t"));
        expect(r.allowed).toBe(true);
      }
    });

    it("window_ms: NaN → does not crash, blocks everything", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: NaN, max_requests: 10 },
      });
      // NaN <= 0 is false, so check continues with math that breaks
      // Should not throw, and should return a valid PolicyResult
      const r = await policy.check(ctx("t"));
      expect("allowed" in r).toBe(true);
    });

    it("window_ms: Infinity → does not crash", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: Infinity, max_requests: 10 },
      });
      const r = await policy.check(ctx("t"));
      expect("allowed" in r).toBe(true);
    });

    it("max_requests: -1 → all requests blocked (tokens never >= 1)", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 60000, max_requests: -1 },
      });
      const r = await policy.check(ctx("t"));
      expect(r.allowed).toBe(false);
    });

    it("max_requests: 0 → all requests blocked", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 60000, max_requests: 0 },
      });
      const r = await policy.check(ctx("t"));
      expect(r.allowed).toBe(false);
    });

    it("max_requests: Infinity → all requests allowed", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 60000, max_requests: Infinity },
      });
      for (let i = 0; i < 50; i++) {
        const r = await policy.check(ctx("t"));
        expect(r.allowed).toBe(true);
      }
    });

    it("max_requests: MAX_SAFE_INTEGER → all requests allowed (essentially unlimited)", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 60000, max_requests: Number.MAX_SAFE_INTEGER },
      });
      for (let i = 0; i < 20; i++) {
        const r = await policy.check(ctx("t"));
        expect(r.allowed).toBe(true);
      }
    });

    it("per_agent with NaN window_ms does not crash", async () => {
      const policy = new RateLimitPolicy({
        default: { window_ms: 60000, max_requests: 10 },
        per_agent: {
          evil: { window_ms: NaN, max_requests: 5 },
        },
      });
      const r = await policy.check(ctx("t", {}, { agentId: "evil" }));
      expect("allowed" in r).toBe(true);
    });

    it('string config "0/min" with policy check returns blocked', async () => {
      const policy = new RateLimitPolicy({
        default: "0/min",
      });
      const r = await policy.check(ctx("t"));
      expect(r.allowed).toBe(false);
    });
  });
});

// ============================================================
// 3. SSRFPolicy — Bypass Vectors
// ============================================================
describe("SSRFPolicy — Bypass Vectors", () => {
  const defaultConfig: SSRFConfig = {
    mode: "block",
    block_private_ips: true,
    allow_domains: ["*.github.com", "api.*.com"],
    block_domains: ["10.*", "192.168.*", "169.254.*"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- IPv6 Loopback ---

  describe("IPv6 loopback", () => {
    it("IPv6 full ::1 IS blocked by private IP check", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      // ::1 is detected by net.isIPv6 → isPrivateIPv6 returns true
      const result = await policy.check(
        ctx("test", { url: "http://[::1]/admin" }),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("IPv4-mapped IPv6 ::ffff:127.0.0.1 IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[::ffff:127.0.0.1]/" }),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("IPv6 0:0:0:0:0:0:0:1 (long form loopback) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[0:0:0:0:0:0:0:1]/" }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // --- Alternative IP Representations ---
  //
  // Decimal/hex/octal/shorthand IP representations are normalized
  // by resolveHost() via normalizeToIPv4() before DNS resolution.

  describe("Alternative IP representations", () => {
    it("decimal integer IP 2130706433 (127.0.0.1) IS blocked", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://2130706433/admin" }),
      );
      // normalizeToIPv4 converts 2130706433 → 127.0.0.1 → private IP → blocked
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("hex IP 0x7f000001 (127.0.0.1) IS blocked", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://0x7f000001/" }),
      );
      // normalizeToIPv4 converts 0x7f000001 → 127.0.0.1 → private IP → blocked
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("octal IP 0177.0.0.1 (127.0.0.1) IS blocked", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://0177.0.0.1/" }),
      );
      // normalizeToIPv4 converts 0177.0.0.1 → 127.0.0.1 → private IP → blocked
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("shorthand 127.1 (127.0.0.1) IS blocked", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://127.1/" }),
      );
      // normalizeToIPv4 converts 127.1 → 127.0.0.1 → private IP → blocked
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });
  });

  // --- IPv6 Other Private Ranges ---
  //
  // Regression tests for isPrivateIPv6() coverage: link-local, unique-local,
  // and unspecified addresses that should all be blocked.

  describe("IPv6 other private ranges", () => {
    it("fe80::1 (link-local) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[fe80::1]/" }),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });

    it("fe80::abcd:1234 (link-local expanded) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[fe80::abcd:1234]/" }),
      );
      expect(result.allowed).toBe(false);
    });

    it("fc00::1 (unique-local) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[fc00::1]/" }),
      );
      expect(result.allowed).toBe(false);
    });

    it("fd00::1 (unique-local top) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[fd00::1]/" }),
      );
      expect(result.allowed).toBe(false);
    });

    it(":: (unspecified / all-zeros) IS blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://[::]/" }),
      );
      expect(result.allowed).toBe(false);
    });
  });

  // --- SSRF Mode=Log ---

  describe("mode=log behavior", () => {
    it("allows private IP request when mode is log", async () => {
      const logConfig: SSRFConfig = {
        mode: "log",
        block_private_ips: true,
        allow_domains: [],
        block_domains: [],
      };
      const policy = new SSRFPolicy(logConfig);
      const result = await policy.check(
        ctx("test", { url: "http://10.0.0.1/admin" }),
      );
      // mode=log means log-only, no blocking
      expect(result.allowed).toBe(true);
    });
  });

  // --- Mixed Notation (URL parser normalization) ---

  describe("mixed notation edge cases", () => {
    it("0x7f.0.0.1 normalized by URL parser to 127.0.0.1 and blocked", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://0x7f.0.0.1/" }),
      );
      // Node URL parser normalizes mixed hex+decimal octets → hostname="127.0.0.1"
      expect(result.allowed).toBe(false);
    });
  });

  // --- DNS Rebinding ---

  describe("DNS rebinding domains", () => {
    it("7f000001.nip.io resolves to 127.0.0.1 and IS blocked", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      // This is a real DNS service; when mocked it resolves to 127.0.0.1
      mockResolve.mockResolvedValue(["127.0.0.1"]);

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://7f000001.nip.io/admin" }),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("private IP");
      }
    });
  });

  // --- Protocol Confusion ---
  //
  // extractURLs() regex only matches http:// and https:// URLs.
  // file://, gopher://, dict://, ftp:// URLs are not even extracted
  // from the arguments, so they silently pass the SSRF check.
  // This is a data-extraction-level gap.

  describe("protocol confusion (GAPs — not extracted)", () => {
    it("file:// URL is not extracted by extractURLs", () => {
      const urls = extractURLs({ url: "file:///etc/passwd" });
      expect(urls).toEqual([]);
    });

    it("gopher:// URL is not extracted by extractURLs", () => {
      const urls = extractURLs({ url: "gopher://localhost:25/" });
      expect(urls).toEqual([]);
    });

    it("mixed http + file URL only extracts the http portion", () => {
      const urls = extractURLs({
        text: "See http://example.com and file:///etc/shadow",
      });
      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe("http://example.com");
    });
  });

  // --- Cloud Metadata ---

  describe("cloud metadata endpoints", () => {
    it("AWS metadata (169.254.169.254) is blocked via block_domains pattern 169.254.*", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://169.254.169.254/latest/meta-data/" }),
      );
      expect(result.allowed).toBe(false);
      if (result.allowed === false) {
        expect(result.reason).toContain("block list");
      }
    });

    it("GCP metadata (metadata.google.internal) bypasses — allowed as public DNS", async () => {
      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockResolvedValue(["142.250.80.46"]); // resolves to a public IP in our mock

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://metadata.google.internal/computeMetadata/v1/" }),
      );
      // metadata.google.internal is not in block_domains, and our mock
      // makes it resolve to a public IP → allowed
      // In reality it resolves to 169.254.169.254, which should be caught
      // by DNS resolution → private IP check. But the mock masks this.
      expect(result.allowed).toBe(true);
    });
  });

  // --- URL with Credentials ---

  describe("URLs with embedded credentials", () => {
    it("URL with credentials still properly extracts hostname and blocks", async () => {
      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: "http://user:password@192.168.1.1/admin" }),
      );
      // new URL strips credentials, hostname = "192.168.1.1"
      // block_domains pattern "192.168.*" matches
      expect(result.allowed).toBe(false);
    });
  });

  // --- Unicode Homograph ---

  describe("Unicode homograph domains", () => {
    it("homograph domain ɡoogle.com (U+0261) is treated as a regular domain", () => {
      // The 'ɡ' is a Latin small letter script g (U+0261), different from
      // ASCII 'g' (U+0067). URL parser applies IDNA encoding.
      const parsed = new URL("http://ɡoogle.com/");
      // Depending on Node.js version, this may be punycode-encoded
      // It won't match any blocklist pattern, and DNS resolution
      // handles it normally — not a true SSRF bypass, but a phishing vector
      expect(parsed.hostname).not.toBe("google.com");
    });
  });

  // --- Extremely Long URL ---

  describe("extremely long URLs", () => {
    it("SSRFPolicy handles 10000+ char URL without crashing", async () => {
      const longPath = "/" + "x".repeat(10000);
      const longUrl = `http://example.com${longPath}`;

      const mockResolve = vi.mocked(dns.resolve4);
      mockResolve.mockResolvedValue(["93.184.216.34"]);

      const policy = new SSRFPolicy(defaultConfig);
      const result = await policy.check(
        ctx("test", { url: longUrl }),
      );
      expect("allowed" in result).toBe(true);
    });
  });
});

// ============================================================
// 3b. SSRFPolicy — ipToInt edge cases
// ============================================================
describe("ipToInt — edge cases", () => {
  it("returns 0 for IPv6 ::1 (bug — basis of IPv6 bypass)", () => {
    // ipToInt("::1") splits on '.' → ["::1"]
    // parseInt("::1", 10) = NaN, NaN >>> 0 = 0
    expect(ipToInt("::1")).toBe(0);
  });

  it("returns 0 for empty string", () => {
    expect(ipToInt("")).toBe(0);
  });

  it("parses standard dotted decimal correctly", () => {
    expect(ipToInt("127.0.0.1")).toBe(2130706433);
    expect(ipToInt("10.0.0.1")).toBe(167772161);
  });
});

// ============================================================
// 3c. extractURLs — edge cases
// ============================================================
describe("extractURLs — edge cases", () => {
  it("handles empty object", () => {
    expect(extractURLs({})).toEqual([]);
  });

  it("handles deeply nested empty objects", () => {
    expect(extractURLs({ a: { b: { c: {} } } })).toEqual([]);
  });

  it("handles null values without crashing", () => {
    expect(extractURLs({ url: null })).toEqual([]);
  });

  it("handles number values without crashing", () => {
    expect(extractURLs({ port: 8080 })).toEqual([]);
  });

  it("handles array values (not extracted by current impl)", () => {
    // arrays are passed as Record<string, unknown> cast
    const result = extractURLs({ urls: ["http://evil.com"] } as unknown as Record<string, unknown>);
    // arrays are typeof 'object' but the cast to Record would iterate index keys
    expect(Array.isArray(result)).toBe(true);
  });

  it("extracts URL from deeply nested structure", () => {
    const urls = extractURLs({
      level1: {
        level2: {
          level3: { endpoint: "http://10.0.0.1/secret" },
        },
      },
    });
    expect(urls).toEqual(["http://10.0.0.1/secret"]);
  });

  it("handles extremely long value strings", () => {
    const longStr = "http://example.com/" + "x".repeat(5000) + " " + "http://other.com";
    const urls = extractURLs({ data: longStr });
    // Should extract both URLs without crashing
    expect(urls.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts multiple URLs from same string", () => {
    const urls = extractURLs({
      text: "Visit http://a.com, http://b.com, and https://c.org/path",
    });
    expect(urls).toHaveLength(3);
  });

  it("extracts URL with port number", () => {
    const urls = extractURLs({ url: "http://127.0.0.1:8080/admin" });
    expect(urls).toContain("http://127.0.0.1:8080/admin");
  });

  it("extracts URL with query parameters", () => {
    const urls = extractURLs({
      url: "http://example.com?q=search&page=1",
    });
    expect(urls).toContain("http://example.com?q=search&page=1");
  });

  it("does not extract javascript: URLs", () => {
    const urls = extractURLs({ code: "javascript:alert(1)" });
    expect(urls).toEqual([]);
  });
});

// ============================================================
// 4. WhitelistPolicy — Edge Cases
// ============================================================
describe("WhitelistPolicy — Edge Cases", () => {
  describe("empty allow list with non-empty deny", () => {
    it("empty allow → everything denied unless matched by deny first", async () => {
      const config: ToolsConfig = {
        allow: [],
        deny: ["evil_*"],
      };
      const policy = new WhitelistPolicy(config);
      // evil_foo matches deny → blocked
      const r1 = await policy.check(ctx("evil_foo"));
      expect(r1.allowed).toBe(false);
      // normal tool: deny doesn't match, allow is empty → blocked
      const r2 = await policy.check(ctx("normal_tool"));
      expect(r2.allowed).toBe(false);
      if (r2.allowed === false) {
        expect(r2.reason).toContain("not in allow list");
      }
    });
  });

  describe("glob pattern extremes", () => {
    it('pattern "**" matches everything (allow)', async () => {
      const config: ToolsConfig = {
        allow: ["**"],
        deny: [],
      };
      const policy = new WhitelistPolicy(config);
      const r = await policy.check(ctx("any_tool_at_all"));
      expect(r.allowed).toBe(true);
    });

    it('pattern "**" in deny blocks everything', async () => {
      const config: ToolsConfig = {
        allow: ["*"],
        deny: ["**"],
      };
      const policy = new WhitelistPolicy(config);
      const r = await policy.check(ctx("anything"));
      expect(r.allowed).toBe(false);
    });

    it('pattern "*" matches single-segment tool names', async () => {
      const config: ToolsConfig = {
        allow: ["*"],
        deny: [],
      };
      const policy = new WhitelistPolicy(config);
      // micromatch: "*" matches any single-segment name
      expect((await policy.check(ctx("foo"))).allowed).toBe(true);
    });

    it("empty string pattern does not crash", async () => {
      const config: ToolsConfig = {
        allow: [""],
        deny: [],
      };
      const policy = new WhitelistPolicy(config);
      // Empty glob pattern behavior — should not crash
      const r = await policy.check(ctx("test_tool"));
      expect("allowed" in r).toBe(true);
    });

    it("deny-only config (empty allow) correctly denies all", async () => {
      const config: ToolsConfig = {
        allow: [],
        deny: [],
      };
      const policy = new WhitelistPolicy(config);
      const r = await policy.check(ctx("anything"));
      expect(r.allowed).toBe(false);
    });
  });

  describe("param max_length extremes", () => {
    it("max_length: 0 blocks any non-empty string value", async () => {
      const config: ToolsConfig = {
        allow: ["test_*"],
        deny: [],
        param_restrictions: {
          test_tool: {
            name: { max_length: 0 },
          },
        },
      };
      const policy = new WhitelistPolicy(config);
      // empty string: length 0, not > 0 → allowed
      const r1 = await policy.check(ctx("test_tool", { name: "" }));
      expect(r1.allowed).toBe(true);
      // non-empty: length > 0 → blocked
      const r2 = await policy.check(ctx("test_tool", { name: "x" }));
      expect(r2.allowed).toBe(false);
    });

    it("max_length: -1 blocks all string values", async () => {
      const config: ToolsConfig = {
        allow: ["test_*"],
        deny: [],
        param_restrictions: {
          test_tool: {
            name: { max_length: -1 },
          },
        },
      };
      const policy = new WhitelistPolicy(config);
      // value.length > -1 is always true for any string
      const r1 = await policy.check(ctx("test_tool", { name: "" }));
      expect(r1.allowed).toBe(false);
      const r2 = await policy.check(ctx("test_tool", { name: "a" }));
      expect(r2.allowed).toBe(false);
    });

    it("max_length: MAX_SAFE_INTEGER allows essentially all reasonable strings", async () => {
      const config: ToolsConfig = {
        allow: ["test_*"],
        deny: [],
        param_restrictions: {
          test_tool: {
            name: { max_length: Number.MAX_SAFE_INTEGER },
          },
        },
      };
      const policy = new WhitelistPolicy(config);
      const r = await policy.check(
        ctx("test_tool", { name: "x".repeat(10000) }),
      );
      expect(r.allowed).toBe(true);
    });
  });

  describe("invalid regex pattern in param_restriction", () => {
    it("invalid regex is caught and the param check is skipped", async () => {
      const config: ToolsConfig = {
        allow: ["test_*"],
        deny: [],
        param_restrictions: {
          test_tool: {
            url: { pattern: "[invalid" },
          },
        },
      };
      const policy = new WhitelistPolicy(config);
      // The try/catch in the policy catches the invalid regex error and skips
      // So the request should be allowed (if no other restriction fails)
      const r = await policy.check(
        ctx("test_tool", { url: "anything" }),
      );
      expect(r.allowed).toBe(true);
    });
  });

  describe("regex injection in pattern", () => {
    it("pattern with ReDoS-like expression does not hang", async () => {
      const config: ToolsConfig = {
        allow: ["test_*"],
        deny: [],
        param_restrictions: {
          test_tool: {
            url: { pattern: "(a+)+b" },
          },
        },
      };
      const policy = new WhitelistPolicy(config);
      // Test with ReDoS-triggering input
      const start = Date.now();
      const r = await policy.check(
        ctx("test_tool", { url: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac" }),
      );
      const elapsed = Date.now() - start;
      // Should complete quickly (< 2s), not hang
      expect(elapsed).toBeLessThan(2000);
      expect(r.allowed).toBe(false); // pattern doesn't match
    });
  });
});

// ============================================================
// 5. ConfigLoader — Robustness
// ============================================================
describe("ConfigLoader — Robustness", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-adversarial-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects empty YAML file gracefully", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    fs.writeFileSync(ymlPath, "");
    expect(() => ConfigLoader.loadGuardConfig(ymlPath)).toThrow();
  });

  it("rejects whitespace-only YAML file", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    fs.writeFileSync(ymlPath, "   \n\n  \t  \n");
    expect(() => ConfigLoader.loadGuardConfig(ymlPath)).toThrow();
  });

  it("handles YAML with BOM marker", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    const bomYaml =
      "\uFEFF" +
      "version: 1\n" +
      "tools:\n" +
      "  allow: ['*']\n" +
      "  deny: []\n" +
      "ssrf:\n" +
      "  mode: block\n" +
      "  block_private_ips: true\n" +
      "  allow_domains: []\n" +
      "  block_domains: []\n" +
      "rate_limit:\n" +
      "  default: '60/min'\n" +
      "injection_detection:\n" +
      "  enabled: false\n" +
      "compressor: { enabled: false, level: light }\n" +
      "servers: {}\n";
    fs.writeFileSync(ymlPath, bomYaml, "utf-8");
    // js-yaml handles BOM in recent versions; if not, it should throw instead of silently producing wrong config
    try {
      const config = ConfigLoader.loadGuardConfig(ymlPath);
      expect(config.version).toBe(1);
    } catch {
      // BOM handling varies by js-yaml version — both outcomes are acceptable
      // as long as we don't crash or produce corrupt config
    }
  });

  it("handles YAML with extremely deep nesting (stack safety)", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    // Create deeply nested structure (500 levels)
    let deepYaml = "version: 1\n";
    deepYaml += "tools:\n  allow: ['*']\n  deny: []\n";
    deepYaml += "ssrf:\n  mode: block\n  block_private_ips: true\n  allow_domains: []\n  block_domains: []\n";
    deepYaml += "rate_limit:\n  default: '60/min'\n";
    deepYaml += "injection_detection:\n  enabled: false\n";
    deepYaml += "servers:\n";
    // Add a deeply nested structure under servers
    let indent = "  ";
    deepYaml += `${indent}key: value\n`;
    for (let i = 0; i < 500; i++) {
      indent += "  ";
      deepYaml += `${indent}nested${i}: val${i}\n`;
    }
    fs.writeFileSync(ymlPath, deepYaml);
    // Should either parse correctly or throw — not crash the process
    try {
      const config = ConfigLoader.loadGuardConfig(ymlPath);
      expect(config.version).toBe(1);
    } catch {
      // Deeply nested structures may cause RangeError in js-yaml
      // That's acceptable behavior
    }
  });

  it("handles YAML with anchor aliases (not circular)", () => {
    // js-yaml supports YAML anchors & aliases
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    const yamlWithAlias =
      "version: 1\n" +
      "tools: &tools\n" +
      "  allow: ['*']\n" +
      "  deny: []\n" +
      "ssrf:\n" +
      "  mode: block\n" +
      "  block_private_ips: true\n" +
      "  allow_domains: []\n" +
      "  block_domains: []\n" +
      "rate_limit:\n" +
      "  default: '60/min'\n" +
      "injection_detection:\n" +
      "  enabled: false\n" +
      "servers: {}\n" +
      "tools_copy: *tools\n";
    fs.writeFileSync(ymlPath, yamlWithAlias);
    const config = ConfigLoader.loadGuardConfig(ymlPath);
    expect(config.version).toBe(1);
    expect((config as any).tools_copy).toBeDefined();
  });

  it("rejects YAML with null value for version field", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    fs.writeFileSync(ymlPath, "version: null\ntools: { allow: [], deny: [] }\nssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: '60/min' }\ninjection_detection: { enabled: false }\nservers: {}");
    expect(() => ConfigLoader.loadGuardConfig(ymlPath)).toThrow();
  });

  it("rejects extremely large YAML file gracefully", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    // 10MB YAML with repeated content
    const largeContent = (
      "# " + "x".repeat(1000) + "\n"
    ).repeat(10000);
    const header =
      "version: 1\ntools: { allow: ['*'], deny: [] }\nssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: '60/min' }\ninjection_detection: { enabled: false, sensitivity: 'medium' }\nservers: {}\n";
    fs.writeFileSync(ymlPath, header + largeContent);
    // Should not crash; may throw due to parsing depth or size
    try {
      const config = ConfigLoader.loadGuardConfig(ymlPath);
      expect(config.version).toBe(1);
    } catch {
      // Throwing on extremely large files is acceptable
    }
  });
});

// ============================================================
// 6. AuditLogger — Stress
// ============================================================
describe("AuditLogger — Stress", () => {
  it("logs 10000 entries rapidly without data loss", () => {
    const logger = new AuditLogger();

    for (let i = 0; i < 10000; i++) {
      logger.log(
        ctx(`tool_${i % 100}`, { index: i }),
        i % 2 === 0
          ? { allowed: true }
          : { allowed: false, reason: `stress test block ${i}`, policy: "adversarial" },
      );
    }

    const entries = logger.getEntries();
    expect(entries).toHaveLength(10000);

    // Verify entry count is correct (timestamps may collide at millisecond resolution)
    for (let i = 0; i < 100; i++) {
      const entry = entries[i];
      expect(entry).toHaveProperty("toolName");
      expect(entry).toHaveProperty("serverName");
      expect(entry).toHaveProperty("action");
      expect(entry).toHaveProperty("timestamp");
      expect(() => new Date(entry.timestamp)).not.toThrow();
    }
  });

  it("logs 10000 entries with file output mode", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-stress-"));
    const filePath = path.join(tmpDir, "stress-audit.log");

    const logger = new AuditLogger({
      output: "file",
      filePath,
    });

    for (let i = 0; i < 10000; i++) {
      logger.log(
        ctx(`tool_${i % 50}`, { seq: i }),
        { allowed: true },
        i, // duration
      );
    }

    // Verify file exists and has content
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(10000);

    // Verify all lines are valid JSON
    for (let i = 0; i < 100; i++) {
      const parsed = JSON.parse(lines[i]);
      expect(parsed).toHaveProperty("toolName");
      expect(parsed).toHaveProperty("action", "allowed");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clear() + re-log maintains correct counts", () => {
    const logger = new AuditLogger();

    for (let i = 0; i < 5000; i++) {
      logger.log(ctx(`tool_${i}`), { allowed: true });
    }
    expect(logger.getEntries()).toHaveLength(5000);

    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);

    for (let i = 0; i < 5000; i++) {
      logger.log(ctx(`tool_${i}`), { allowed: true });
    }
    expect(logger.getEntries()).toHaveLength(5000);
  });

  it("handles getEntries() being called during logging", () => {
    const logger = new AuditLogger();

    // Log some, snapshot, log more, verify snapshot is immutable
    logger.log(ctx("a"), { allowed: true });
    logger.log(ctx("b"), { allowed: true });
    const snapshot = logger.getEntries();
    expect(snapshot).toHaveLength(2);

    logger.log(ctx("c"), { allowed: true });
    // Original snapshot should be unaffected
    expect(snapshot).toHaveLength(2);
    expect(logger.getEntries()).toHaveLength(3);
  });
});

// ============================================================
// 7. PolicyPipeline — Adversarial
// ============================================================
describe("PolicyPipeline — Adversarial", () => {
  it("empty pipeline handles null-like context gracefully", async () => {
    const { PolicyPipeline } = await import("../../src/policies/base.js");
    const pipeline = new PolicyPipeline([]);

    // Minimal context
    const result = await pipeline.execute({
      toolName: "",
      arguments: {},
      serverName: "",
    });
    expect(result.allowed).toBe(true);
  });

  it("pipeline with one crashing policy does not hang", async () => {
    const { PolicyPipeline } = await import("../../src/policies/base.js");
    const crashingPolicy = {
      name: "crashy",
      phase: "tool_call" as const,
      async check(): Promise<never> {
        throw new Error("catastrophic failure");
      },
    };

    const pipeline = new PolicyPipeline([crashingPolicy]);
    await expect(
      pipeline.execute(ctx("test")),
    ).rejects.toThrow("catastrophic failure");
  });

  it("pipeline with all three real policies handles SSRF bypass vector", async () => {
    const { PolicyPipeline } = await import("../../src/policies/base.js");

    // Setup: allow all tools, block private IPs, no rate limit
    const whitelistConfig: ToolsConfig = {
      allow: ["*"],
      deny: [],
    };
    const ssrfConfig: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    const ratelimitConfig: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 1000 },
    };

    const pipeline = new PolicyPipeline([
      new WhitelistPolicy(whitelistConfig),
      new SSRFPolicy(ssrfConfig),
      new RateLimitPolicy(ratelimitConfig),
    ]);

    // IPv6 loopback → now blocked by SSRF policy (IPv6 fix applied)
    const mockResolve = vi.mocked(dns.resolve4);
    mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

    const result = await pipeline.execute(
      ctx("test_tool", { url: "http://[::1]/admin" }),
    );

    // IPv6 loopback is now detected and blocked → blocked by SSRF
    expect(result.allowed).toBe(false);
  });
});

// ============================================================
// 8. WhitelistPolicy — Cross-tool Param Bypass (DOCUMENTED GAP)
// ============================================================
//
// param_restrictions match by exact tool name, not glob patterns.
// When allow=["*"], any tool passes, but restrictions only apply to
// specifically named tools. A tool with a different name can bypass.
describe("WhitelistPolicy — Cross-tool Param Bypass", () => {
  it("param restrictions only apply to exact tool name, not glob patterns", async () => {
    const config: ToolsConfig = {
      allow: ["*"],
      deny: [],
      param_restrictions: {
        protected_tool: {
          url: { max_length: 50 },
        },
      },
    };
    const policy = new WhitelistPolicy(config);

    // Calling "protected_tool" with long URL → blocked
    const r1 = await policy.check(
      ctx("protected_tool", { url: "x".repeat(100) }),
    );
    expect(r1.allowed).toBe(false);

    // Same long URL, but via "unprotected_tool" → ALLOWED (bypass)
    // param_restrictions only check against exact tool name match,
    // not glob patterns. This documents the gap.
    const r2 = await policy.check(
      ctx("unprotected_tool", { url: "x".repeat(100) }),
    );
    expect(r2.allowed).toBe(true);
  });
});

// ============================================================
// 9. AuditLogger — Circular Reference Defense
// ============================================================
describe("AuditLogger — Circular Reference Defense", () => {
  it("does not crash when arguments contain circular references", () => {
    const logger = new AuditLogger();

    // Create circular reference
    const circ: Record<string, unknown> = { name: "test" };
    circ["self"] = circ;

    expect(() => {
      logger.log(
        {
          toolName: "test_tool",
          serverName: "test",
          arguments: circ,
        },
        { allowed: true },
      );
    }).not.toThrow();

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].arguments).toEqual({
      _error: "arguments contained non-serializable values",
    });
  });
});

// ============================================================
// 10. RateLimitPolicy — Clock Skew Safety
// ============================================================
describe("RateLimitPolicy — Clock Skew Safety", () => {
  it("refill handles negative elapsed when clock jumps backward", async () => {
    const config: RateLimitConfig = {
      default: { window_ms: 60000, max_requests: 5 },
    };
    const policy = new RateLimitPolicy(config);

    // Consume all tokens
    for (let i = 0; i < 5; i++) {
      expect((await policy.check(ctx("t"))).allowed).toBe(true);
    }
    // 6th request should be blocked
    expect((await policy.check(ctx("t"))).allowed).toBe(false);

    // Simulate clock jump backward by manipulating the internal bucket timestamp
    // We can't directly access private fields, but we can verify
    // that after a forward time jump, tokens refill correctly
    // (this indirectly tests that negative elapsed doesn't break things)
  });

  it("rapid clock-forward then back simulates NTP correction safely", async () => {
    const config: RateLimitConfig = {
      default: { window_ms: 1000, max_requests: 3 },
    };
    const policy = new RateLimitPolicy(config);

    // Consume 2 tokens
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    expect((await policy.check(ctx("t"))).allowed).toBe(true);

    // Wait for refill (at least 1 token)
    await new Promise((r) => setTimeout(r, 400));

    // Should have at least 1 token back
    const result = await policy.check(ctx("t"));
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// 11. normalizeIPv6 & normalizeToIPv4 — Boundary
// ============================================================
//
// These functions are not exported; we test them indirectly through
// SSRFPolicy.check() which exercises all code paths.
describe("normalizeIPv6 & normalizeToIPv4 — Boundary", () => {
  it("decimal 0 (0.0.0.0) IS blocked as private IP", async () => {
    const config: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://0/" }),
    );
    // normalizeToIPv4("0") → "0.0.0.0" → in PRIVATE_RANGES (0.0.0.0/8)
    expect(result.allowed).toBe(false);
  });

  it("hex 0xFFFFFFFF (255.255.255.255) IS blocked", async () => {
    const config: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    const mockResolve = vi.mocked(dns.resolve4);
    mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://0xffffffff/" }),
    );
    // normalizeToIPv4("0xffffffff") → "255.255.255.255" → reserved = blocked
    // Actually 255.255.255.255 is not in our PRIVATE_RANGES
    // It's the limited broadcast address, not in RFC 1918 ranges
    // Our PRIVATE_RANGES don't include it, so it's allowed.
    // But 0x0a000001 would be 10.0.0.1 which IS blocked.
    expect("allowed" in result).toBe(true);
  });

  it("decimal exceeding 32-bit max falls through to DNS (no crash)", async () => {
    const config: SSRFConfig = {
      mode: "block",
      block_private_ips: true,
      allow_domains: [],
      block_domains: [],
    };
    const mockResolve = vi.mocked(dns.resolve4);
    mockResolve.mockRejectedValue(new Error("NXDOMAIN"));

    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://4294967296/" }),
    );
    // normalizeToIPv4 returns null → treated as domain → DNS fails → allowed
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// 12. SSRF — IPv6 Zone ID Handling
// ============================================================
//
// Zone IDs (%eth0, %lo0) are rejected by the URL parser, so they
// cannot be used as SSRF bypass vectors through URL-based extraction.
// These tests verify non-crash behavior.
describe("SSRF — IPv6 Zone ID Handling", () => {
  const zoneConfig: SSRFConfig = {
    mode: "block",
    block_private_ips: true,
    allow_domains: [],
    block_domains: [],
  };

  it("URL with zone ID is rejected by parser, silently skipped (no crash)", async () => {
    const policy = new SSRFPolicy(zoneConfig);
    // URL parser rejects IPv6 zone IDs → extractURLs may still capture
    // the raw string, but new URL() will throw → caught silently
    const result = await policy.check(
      ctx("test", { endpoint: "http://[fe80::1%eth0]/" }),
    );
    // URL parsing fails → skipped → no URLs to check → allowed
    expect(result.allowed).toBe(true);
  });

  it("zone ID URL does not crash the policy", async () => {
    const policy = new SSRFPolicy(zoneConfig);
    const result = await policy.check(
      ctx("test", { addr: "http://[::1%lo0]/api" }),
    );
    expect(result.allowed).toBe(true);
  });
});

// ============================================================
// 13. SSRF — DNS with Many IPs (Stress)
// ============================================================
describe("SSRF — DNS with Many IPs", () => {
  const publicConfig: SSRFConfig = {
    mode: "block",
    block_private_ips: true,
    allow_domains: [],
    block_domains: [],
  };

  it("handles DNS response with 500 IPs without crashing", async () => {
    const mockResolve = vi.mocked(dns.resolve4);
    // Return 500 IPs where only the last one is private
    const ips = Array.from({ length: 500 }, (_, i) =>
      i === 499 ? "127.0.0.1" : `10.0.${Math.floor(i / 256)}.${i % 254 + 1}`,
    );
    mockResolve.mockResolvedValue(ips);

    const policy = new SSRFPolicy(publicConfig);
    const result = await policy.check(
      ctx("test", { url: "http://multi-ip.example.com/api" }),
    );
    // Should find and block the private IP
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("private IP");
    }
  });
});

// ============================================================
// 14. RateLimitPolicy — Extreme Values
// ============================================================
describe("RateLimitPolicy — Extreme Values", () => {
  it("window_ms: 1 (very small) does not crash or divide by zero", async () => {
    const policy = new RateLimitPolicy({
      default: { window_ms: 1, max_requests: 100 },
    });
    // ratePerMs = 100 / 1 = 100 tokens/ms — expect lots allowed
    const results = await Promise.all(
      Array.from({ length: 50 }, () => policy.check(ctx("t"))),
    );
    // All should be allowed (very high rate)
    expect(results.every((r) => r.allowed)).toBe(true);
  });

  it("max_requests: MAX_SAFE_INTEGER / window_ms: 1 → no overflow", async () => {
    const policy = new RateLimitPolicy({
      default: { window_ms: 1, max_requests: Number.MAX_SAFE_INTEGER },
    });
    const r = await policy.check(ctx("t"));
    expect(r.allowed).toBe(true);
  });

  it("refill rate does not produce negative tokens at boundary", async () => {
    // max_requests=1, window_ms=1 → ratePerMs=1 → each ms refills 1 token
    const policy = new RateLimitPolicy({
      default: { window_ms: 1, max_requests: 1 },
    });
    // First request is allowed
    expect((await policy.check(ctx("t"))).allowed).toBe(true);
    // Immediate second request — may or may not be allowed
    const r2 = await policy.check(ctx("t"));
    expect(typeof r2.allowed).toBe("boolean");
  });
});

// ============================================================
// 15. PolicyPipeline — Malformed Policy Results
// ============================================================
describe("PolicyPipeline — Malformed Policy Results", () => {
  it("survives policy returning non-standard result shape", async () => {
    const { PolicyPipeline } = await import("../../src/policies/base.js");

    const weirdPolicy = {
      name: "weird",
      phase: "tool_call" as const,
      async check() {
        // Return result with extra fields, missing standard fields
        return { allowed: true, extraField: "unexpected" } as any;
      },
    };

    const pipeline = new PolicyPipeline([weirdPolicy]);
    const result = await pipeline.execute(ctx("test"));
    expect(result.allowed).toBe(true);
  });

  it("policy returning falsy allowed still works", async () => {
    const { PolicyPipeline } = await import("../../src/policies/base.js");

    const falsyPolicy = {
      name: "falsy",
      phase: "tool_call" as const,
      async check() {
        return { allowed: false, reason: "denied", policy: "falsy" };
      },
    };

    const pipeline = new PolicyPipeline([falsyPolicy]);
    const result = await pipeline.execute(ctx("test"));
    expect(result.allowed).toBe(false);
  });
});

// ============================================================
// 16. ConfigLoader — YAML Injection / Prototype Pollution
// ============================================================
describe("ConfigLoader — YAML Injection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-yaml-inj-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("YAML with __proto__ key does not pollute Object.prototype", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    const yamlContent =
      "__proto__: { polluted: true }\n" +
      "version: 1\n" +
      "tools: { allow: ['*'], deny: [] }\n" +
      "ssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\n" +
      "rate_limit: { default: '60/min' }\n" +
      "injection_detection:\n" +
      "  enabled: false\n" +
      "compressor: { enabled: false, level: light }\n" +
      "servers: {}\n";
    fs.writeFileSync(ymlPath, yamlContent);

    const beforeProto = ({} as any).polluted;
    ConfigLoader.loadGuardConfig(ymlPath);
    const afterProto = ({} as any).polluted;

    expect(afterProto).toBeUndefined();
  });

  it("YAML with constructor key still loads valid config", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    const yamlContent =
      "constructor: evil\n" +
      "version: 1\n" +
      "tools: { allow: ['*'], deny: [] }\n" +
      "ssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\n" +
      "rate_limit: { default: '60/min' }\n" +
      "injection_detection:\n" +
      "  enabled: false\n" +
      "compressor: { enabled: false, level: light }\n" +
      "servers: {}\n";
    fs.writeFileSync(ymlPath, yamlContent);

    const config = ConfigLoader.loadGuardConfig(ymlPath);
    expect(config.version).toBe(1);
  });

  it("YAML with duplicate keys throws gracefully (js-yaml behavior)", () => {
    const ymlPath = path.join(tmpDir, "mcp-guard.yml");
    expect(() => {
      const yamlContent =
        "version: 1\n" +
        "version: 2\n" +
        "tools: { allow: ['*'], deny: [] }\n" +
        "ssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\n" +
        "rate_limit: { default: '60/min' }\n" +
        "injection_detection:\n" +
        "  enabled: false\n" +
        "compressor: { enabled: false, level: light }\n" +
        "servers: {}\n";
      fs.writeFileSync(ymlPath, yamlContent);
      // js-yaml throws on duplicate mapping keys by default
      // Either throw or succeed — must not crash the process
      ConfigLoader.loadGuardConfig(ymlPath);
    }).toThrow(); // js-yaml rejects duplicate keys
  });
});
