/**
 * Integration tests for mcp-guard — full pipeline end-to-end (Task 13).
 *
 * Tests the complete GuardProxy pipeline with a real mock MCP server subprocess:
 * - Uses InMemoryTransport for test client ↔ GuardProxy communication
 *   (no subprocess needed for the proxy itself)
 * - Spawns mock-server as a real child process via ServerManager +
 *   StdioClientTransport (real subprocess for the upstream server)
 * - Tests: tools/list, tools/call (allowed / denied), rate limiting,
 *   audit logging
 *
 * Run: npm run build && npx vitest run tests/integration/
 */

import { describe, it, expect, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { GuardProxy } from "../../src/proxy.js";
import { ServerManager } from "../../src/server-manager.js";
import { PolicyPipeline } from "../../src/policies/base.js";
import { WhitelistPolicy } from "../../src/policies/whitelist.js";
import { RateLimitPolicy } from "../../src/policies/ratelimit.js";
import { AuditLogger } from "../../src/audit.js";
import type { GuardConfig } from "../../src/config-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "mock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal GuardConfig for integration testing. */
function makeConfig(overrides?: Partial<GuardConfig>): GuardConfig {
  return {
    version: 1,
    tools: { allow: ["*"], deny: [] },
    ssrf: {
      mode: "off",
      block_private_ips: false,
      allow_domains: [],
      block_domains: [],
    },
    rate_limit: { default: "" },
    injection_detection: { enabled: false },
    compressor: { enabled: false, level: "light" },
    servers: {
      [SERVER_NAME]: {
        command: "node",
        args: ["dist/mock-server.js"],
        env: {},
      },
    },
    ...overrides,
  };
}

/** Start GuardProxy with full pipeline, connect a test client via InMemoryTransport. */
async function buildProxy(config: GuardConfig) {
  const audit = new AuditLogger({ level: "silent" });

  const policies = new PolicyPipeline([
    new WhitelistPolicy(config.tools),
    new RateLimitPolicy(config.rate_limit),
  ]);

  const serverManager = new ServerManager(config.servers);
  const proxy = new GuardProxy(config, policies, audit, serverManager);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  // Start proxy — this spawns the mock-server subprocess, creates the MCP
  // Server, and connects it to the server-side InMemoryTransport.
  await proxy.start(serverTransport);

  // Connect test client to the client-side InMemoryTransport.
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return { proxy, client, audit };
}

/** Close client and stop proxy (best-effort cleanup). */
async function destroyProxy(ctx: { proxy: GuardProxy; client: Client }) {
  try {
    await ctx.client.close();
  } catch {
    // best-effort
  }
  try {
    await ctx.proxy.stop();
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GuardProxy Full Pipeline", () => {
  // Integration tests spawn real subprocesses, so allow generous timeout.
  vi.setConfig({ testTimeout: 15000 });

  // -------------------------------------------------------------------------
  // 1. Full pipeline: tools/list through GuardProxy
  // -------------------------------------------------------------------------
  it("should return prefixed tool names from tools/list", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toContain("mock_echo");
      expect(names).toContain("mock_add");
      expect(names).toContain("mock_get_time");
      expect(tools).toHaveLength(3);

      // Each tool should have [mock] prefix in its description
      for (const tool of tools) {
        expect(tool.description).toContain("[mock]");
      }
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Full pipeline: tools/call allowed
  // -------------------------------------------------------------------------
  it("should forward allowed tools/call and return echo result", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "integration test" },
      });

      expect(result.content).toHaveLength(1);
      const entry = result.content[0] as { type: string; text?: string };
      expect(entry.type).toBe("text");
      const parsed = JSON.parse(entry.text ?? "{}");
      expect(parsed).toEqual({ echoed: "integration test" });
    } finally {
      await destroyProxy(ctx);
    }
  });

  it("should forward allowed tools/call and return add result", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mock_add",
        arguments: { a: 10, b: 20 },
      });

      const entry = result.content[0] as { type: string; text?: string };
      expect(entry.text).toBe("30");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Full pipeline: tools/call denied
  // -------------------------------------------------------------------------
  it("should block tools matching deny pattern", async () => {
    const config = makeConfig({
      tools: { allow: ["*"], deny: ["mock_echo"] },
    });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "block me" },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      const entry = result.content[0] as { type: string; text?: string };
      expect(entry.text).toContain("deny");
    } finally {
      await destroyProxy(ctx);
    }
  });

  it("should allow non-denied tools when deny pattern is set", async () => {
    const config = makeConfig({
      tools: { allow: ["*"], deny: ["mock_echo"] },
    });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({
        name: "mock_add",
        arguments: { a: 3, b: 4 },
      });

      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const entry = result.content[0] as { type: string; text?: string };
      expect(entry.text).toBe("7");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Full pipeline: rate limiting
  // -------------------------------------------------------------------------
  it("should block requests exceeding rate limit", async () => {
    const config = makeConfig({
      rate_limit: { default: { window_ms: 60000, max_requests: 1 } },
    });
    const ctx = await buildProxy(config);
    try {
      // First call should succeed
      const r1 = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "first" },
      });
      expect((r1 as { isError?: boolean }).isError).toBeFalsy();

      // Second call (immediately after) should be blocked by rate limiter
      const r2 = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "second" },
      });
      expect((r2 as { isError?: boolean }).isError).toBe(true);
      const entry = r2.content[0] as { type: string; text?: string };
      expect(entry.text).toContain("Rate limit exceeded");
    } finally {
      await destroyProxy(ctx);
    }
  });

  it("should allow requests within rate limit", async () => {
    const config = makeConfig({
      rate_limit: { default: { window_ms: 500, max_requests: 5 } },
    });
    const ctx = await buildProxy(config);
    try {
      for (let i = 0; i < 3; i++) {
        const result = await ctx.client.callTool({
          name: "mock_echo",
          arguments: { message: `req-${i}` },
        });
        expect((result as { isError?: boolean }).isError).toBeFalsy();
      }
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Full pipeline: audit logging
  // -------------------------------------------------------------------------
  it("should generate audit entries for allowed tool calls", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "audit me" },
      });

      await ctx.client.callTool({
        name: "mock_add",
        arguments: { a: 1, b: 2 },
      });

      const entries = ctx.audit.getEntries();
      expect(entries.length).toBeGreaterThanOrEqual(2);

      const entryNames = entries.map((e) => e.toolName);
      expect(entryNames).toContain("mock_echo");
      expect(entryNames).toContain("mock_add");

      for (const entry of entries) {
        expect(entry.action).toBe("allowed");
        expect(entry.serverName).toBe(SERVER_NAME);
        expect(entry.timestamp).toBeDefined();
        expect(() => new Date(entry.timestamp)).not.toThrow();
      }
    } finally {
      await destroyProxy(ctx);
    }
  });

  it("should generate audit entries for blocked tool calls", async () => {
    const config = makeConfig({
      tools: { allow: ["*"], deny: ["mock_echo"] },
    });
    const ctx = await buildProxy(config);
    try {
      await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "block audit" },
      });

      const entries = ctx.audit.getEntries();
      expect(entries.length).toBeGreaterThanOrEqual(1);

      const entry = entries[0];
      expect(entry.toolName).toBe("mock_echo");
      expect(entry.action).toBe("blocked");
      expect(entry.reason).toBeDefined();
      expect(entry.serverName).toBe(SERVER_NAME);
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 6. Cache: cache hit avoids upstream call
  // -----------------------------------------------------------------------
  it("should cache tool call results and return cached on second call", async () => {
    const config = makeConfig({
      cache: {
        enabled: true,
        ttl: 30,
        max_entries: 500,
        allow: ["*"],
        deny: [],
      },
    });
    const ctx = await buildProxy(config);
    try {
      // First call: hits upstream
      const result1 = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "test" },
      });
      const text1 = (result1.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      expect(text1).toContain("test");

      // Second call with same args: should be cached, no upstream call
      const result2 = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "test" },
      });
      const text2 = (result2.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      expect(text2).toContain("test");

      // Verify audit log contains cache hit
      const entries = ctx.audit.getEntries();
      const cacheHits = entries.filter(
        (e: { decisionTrail?: Array<{ policy: string }> }) =>
          e.decisionTrail?.some((d) => d.policy === "cache"),
      );
      expect(cacheHits.length).toBeGreaterThanOrEqual(1);
    } finally {
      await destroyProxy(ctx);
    }
  });
});
