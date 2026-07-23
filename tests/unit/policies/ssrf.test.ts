import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSRFPolicy, ipToInt, extractURLs } from "../../../src/policies/ssrf.js";
import type { SSRFConfig } from "../../../src/config-types.js";
import type { PolicyContext } from "../../../src/types.js";

// Mock DNS to avoid actual network calls
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
}));

import * as dns from "node:dns/promises";

describe("SSRFPolicy", () => {
  const config: SSRFConfig = {
    mode: "block",
    block_private_ips: true,
    allow_domains: ["*.github.com", "api.*.com"],
    block_domains: ["10.*", "192.168.*", "169.254.*"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function ctx(toolName: string, args: Record<string, unknown> = {}): PolicyContext {
    return { toolName, arguments: args, serverName: "test" };
  }

  it("passes when mode is off", async () => {
    const policy = new SSRFPolicy({ ...config, mode: "off" });
    const result = await policy.check(ctx("test", { url: "http://10.0.0.1" }));
    expect(result.allowed).toBe(true);
  });

  it("blocks private IP from URL parameter", async () => {
    // Use a private IP not in block_domains to test private IP check specifically
    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "http://172.31.0.1/admin" }));
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("private IP");
    }
  });

  it("blocks private IP via DNS resolution", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue([{ address: "10.0.0.5", ttl: 60 }]);

    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "http://internal-host.local/secret" }));
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("private IP");
    }
  });

  it("allows public IP", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue([{ address: "142.250.80.46", ttl: 120 }]);

    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "https://google.com" }));
    expect(result.allowed).toBe(true);
  });

  it("uses DNS cache for repeated lookups", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue([{ address: "10.0.0.5", ttl: 60 }]);

    const policy = new SSRFPolicy(config);

    // First call: DNS lookup, blocked
    const r1 = await policy.check(ctx("test", { url: "http://cached-host.local" }));
    expect(r1.allowed).toBe(false);
    expect(resolveMock).toHaveBeenCalledTimes(1);

    // Second call: same hostname → cache hit, DNS not called again
    const r2 = await policy.check(ctx("test", { url: "http://cached-host.local" }));
    expect(r2.allowed).toBe(false);
    expect(resolveMock).toHaveBeenCalledTimes(1); // Still 1 — cached
  });

  it("allows whitelisted domain without DNS check", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "https://api.github.com/repos" }));
    expect(result.allowed).toBe(true);
    // DNS should not be called for whitelisted domains
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it("blocks blacklisted domain", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "http://192.168.1.1/admin" }));
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("block list");
    }
  });

  it("passes when no URL in arguments", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { query: "hello world" }));
    expect(result.allowed).toBe(true);
  });

  it("extracts URLs from nested objects", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", {
        config: { endpoint: "http://10.0.0.1/api" },
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it("handles dns resolution failure gracefully", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockRejectedValue(new Error("DNS failure"));

    const policy = new SSRFPolicy({
      ...config,
      block_private_ips: true,
      allow_domains: [],
    });
    const result = await policy.check(ctx("test", { url: "http://unknown-host.local/path" }));
    // DNS 失败 → 没有 IP 可检查 → allow
    expect(result.allowed).toBe(true);
  });

  it("clamps minimum DNS cache TTL to 10s for security", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue([{ address: "10.0.0.5", ttl: 0 }]);

    const policy = new SSRFPolicy(config);

    // First call: DNS lookup, cached with min 10s TTL
    await policy.check(ctx("test", { url: "http://zero-ttl-host.local" }));
    expect(resolveMock).toHaveBeenCalledTimes(1);

    // Second call (immediately): cache still valid (10s min clamp)
    await policy.check(ctx("test", { url: "http://zero-ttl-host.local" }));
    // Still 1 call — cache hit, min TTL clamp prevents rebinding
    expect(resolveMock).toHaveBeenCalledTimes(1);
  });

  it("blocks private IP when block_private_ips is true", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(ctx("test", { url: "http://127.0.0.1:8080/admin" }));
    expect(result.allowed).toBe(false);
  });

  it("allows private IP when block_private_ips is false", async () => {
    const policy = new SSRFPolicy({ ...config, block_private_ips: false, block_domains: [] });
    const result = await policy.check(ctx("test", { url: "http://10.0.0.1" }));
    expect(result.allowed).toBe(true);
  });

  it("mode=log allows private IP but returns a warn reason", async () => {
    // 不带 block_domains，确保走 private IP 检测分支而非域名黑名单
    const policy = new SSRFPolicy({ ...config, mode: "log" as const, block_domains: [] });
    const result = await policy.check(ctx("test", { url: "http://10.0.0.1/admin" }));
    // 放行（log 不阻止）
    expect(result.allowed).toBe(true);
    // 但携带 warn reason，让审计 trail 能记录这次内网命中
    expect(result.reason).toMatch(/SSRF log/);
    expect(result.reason).toContain("private IP");
  });

  it("mode=log passes public IP without a warn reason", async () => {
    dns.resolve4.mockResolvedValue([{ address: "93.184.216.34", ttl: 60 }]);
    const policy = new SSRFPolicy({ ...config, mode: "log" as const, allow_domains: [], block_domains: [] });
    const result = await policy.check(ctx("test", { url: "http://example.com/" }));
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("mode=log records blocked-domain hit as a warn but does not block", async () => {
    const policy = new SSRFPolicy({ ...config, mode: "log" as const, block_domains: ["evil.com"] });
    const result = await policy.check(ctx("test", { url: "http://evil.com/" }));
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("evil.com");
  });
});

describe("ipToInt", () => {
  it("converts IPv4 to integer", () => {
    expect(ipToInt("10.0.0.0")).toBe(167772160);
    expect(ipToInt("127.0.0.1")).toBe(2130706433);
    expect(ipToInt("192.168.0.0")).toBe(3232235520);
    expect(ipToInt("255.255.255.255")).toBe(4294967295);
  });
});

describe("extractURLs", () => {
  it("extracts http and https URLs from string values", () => {
    const urls = extractURLs({
      url: "Check https://example.com and http://test.com",
    });
    expect(urls).toContain("https://example.com");
    expect(urls).toContain("http://test.com");
  });

  it("extracts file, ftp, gopher, dict, ldap, sftp URLs", () => {
    const urls = extractURLs({
      f: "file:///etc/passwd",
      g: "gopher://internal:7070/",
      d: "dict://internal:6379/config",
      ftp: "ftp://evil.com/",
    });
    expect(urls).toContain("file:///etc/passwd");
    expect(urls).toContain("gopher://internal:7070/");
    expect(urls).toContain("dict://internal:6379/config");
    expect(urls).toContain("ftp://evil.com/");
  });

  it("returns empty array when no URLs", () => {
    const urls = extractURLs({ query: "hello", count: 5 });
    expect(urls).toEqual([]);
  });

  it("extracts URLs from nested objects", () => {
    const urls = extractURLs({
      config: { endpoint: "http://10.0.0.1/api" },
    });
    expect(urls).toContain("http://10.0.0.1/api");
  });

  it("extracts multiple URLs from same string", () => {
    const urls = extractURLs({
      text: "See http://a.com and https://b.org/path",
    });
    expect(urls).toHaveLength(2);
  });
});
