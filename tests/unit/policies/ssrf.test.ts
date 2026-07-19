import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SSRFPolicy,
  ipToInt,
  extractURLs,
} from "../../../src/policies/ssrf.js";
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

  function ctx(
    toolName: string,
    args: Record<string, unknown> = {},
  ): PolicyContext {
    return { toolName, arguments: args, serverName: "test" };
  }

  it("passes when mode is off", async () => {
    const policy = new SSRFPolicy({ ...config, mode: "off" });
    const result = await policy.check(
      ctx("test", { url: "http://10.0.0.1" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks private IP from URL parameter", async () => {
    // Use a private IP not in block_domains to test private IP check specifically
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://172.31.0.1/admin" }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("private IP");
    }
  });

  it("blocks private IP via DNS resolution", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue(["10.0.0.5"]);

    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://internal-host.local/secret" }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("private IP");
    }
  });

  it("allows public IP", async () => {
    const resolveMock = vi.mocked(dns.resolve4);
    resolveMock.mockResolvedValue(["142.250.80.46"]);

    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "https://google.com" }),
    );
    expect(result.allowed).toBe(true);
  });

  it("allows whitelisted domain without DNS check", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "https://api.github.com/repos" }),
    );
    expect(result.allowed).toBe(true);
    // DNS should not be called for whitelisted domains
    expect(dns.resolve4).not.toHaveBeenCalled();
  });

  it("blocks blacklisted domain", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://192.168.1.1/admin" }),
    );
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("block list");
    }
  });

  it("passes when no URL in arguments", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { query: "hello world" }),
    );
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
    const result = await policy.check(
      ctx("test", { url: "http://unknown-host.local/path" }),
    );
    // DNS 失败 → 没有 IP 可检查 → allow
    expect(result.allowed).toBe(true);
  });

  it("blocks private IP when block_private_ips is true", async () => {
    const policy = new SSRFPolicy(config);
    const result = await policy.check(
      ctx("test", { url: "http://127.0.0.1:8080/admin" }),
    );
    expect(result.allowed).toBe(false);
  });

  it("allows private IP when block_private_ips is false", async () => {
    const policy = new SSRFPolicy({ ...config, block_private_ips: false, block_domains: [] });
    const result = await policy.check(
      ctx("test", { url: "http://10.0.0.1" }),
    );
    expect(result.allowed).toBe(true);
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
