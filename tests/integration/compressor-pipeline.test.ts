/**
 * Integration tests for mcp-guard compressor pipeline.
 *
 * Tests the compressor wrapper tools (mcp__list_tools, mcp__get_tool_schema,
 * mcp__invoke_tool) through the full GuardProxy pipeline with a real
 * mock-server subprocess.
 *
 * Covers:
 * - tools/list returns wrapper tools
 * - mcp__list_tools enumerates upstream tools
 * - mcp__get_tool_schema returns full schema
 * - mcp__invoke_tool delegates through policy pipeline
 * - Whitelist filtering on wrapper tools
 * - Blocked tools via invoke_tool
 *
 * Run: npm run build && npx vitest run tests/integration/compressor-pipeline.test.ts
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
import type { Policy } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVER_NAME = "mock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GuardConfig>): GuardConfig {
  return {
    version: 1,
    tools: { allow: ["*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
    rate_limit: { default: "" },
    injection_detection: { enabled: false },
    compressor: { enabled: true, level: "light" },
    audit: { output: "stdout" },
    servers: {
      [SERVER_NAME]: { command: "node", args: ["dist/mock-server.js"], env: {} },
    },
    ...overrides,
  } as GuardConfig;
}

/** Start GuardProxy with compressor, connect test client via InMemoryTransport. */
async function buildProxy(config: GuardConfig) {
  const audit = new AuditLogger({ level: "silent" });

  const policies: Policy[] = [new WhitelistPolicy(config.tools), new RateLimitPolicy(config.rate_limit)];
  const pipeline = new PolicyPipeline(policies);

  const serverManager = new ServerManager(config.servers);
  const proxy = new GuardProxy(config, pipeline, audit, serverManager);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await proxy.start(serverTransport);

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);

  return { proxy, client, audit };
}

async function destroyProxy(ctx: { proxy: GuardProxy; client: Client }) {
  try { await ctx.client.close(); } catch { /* best-effort */ }
  try { await ctx.proxy.stop(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Compressor Pipeline", () => {
  vi.setConfig({ testTimeout: 15000 });

  // -----------------------------------------------------------------------
  // 1. tools/list returns wrapper tools (compressor light level)
  // -----------------------------------------------------------------------
  it("tools/list returns 3 wrapper tools when compressor=light", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
      expect(tools).toHaveLength(3);

      // Each wrapper must have an inputSchema
      for (const t of tools) {
        expect(t.inputSchema).toBeDefined();
      }
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 2. tools/list returns 2 wrapper tools when compressor=tight
  // -----------------------------------------------------------------------
  it("tools/list returns 2 wrapper tools when compressor=tight", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "tight" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
      expect(tools).toHaveLength(2);
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 3. mcp__list_tools returns tool names + descriptions
  // -----------------------------------------------------------------------
  it("mcp__list_tools returns tool names and descriptions", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({ name: "mcp__list_tools", arguments: {} });
      const content = result.content[0] as { type: string; text?: string };
      expect(content.type).toBe("text");

      const parsed = JSON.parse(content.text ?? "[]");
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBeGreaterThanOrEqual(1);

      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toContain("mock_echo");
      expect(names).toContain("mock_add");
      expect(names).toContain("mock_get_time");

      // Should have descriptions but no inputSchema
      for (const entry of parsed) {
        expect(entry).toHaveProperty("description");
        expect(entry).not.toHaveProperty("inputSchema");
      }
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 4. mcp__get_tool_schema returns full schema for known tool
  // -----------------------------------------------------------------------
  it("mcp__get_tool_schema returns full schema", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mcp__get_tool_schema",
        arguments: { tool_name: "mock_echo" },
      });
      const content = result.content[0] as { type: string; text?: string };
      const parsed = JSON.parse(content.text ?? "{}");

      expect(parsed.name).toBe("mock_echo");
      expect(parsed).toHaveProperty("inputSchema");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 5. mcp__get_tool_schema returns error for unknown tool
  // -----------------------------------------------------------------------
  it("mcp__get_tool_schema returns error for unknown tool", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mcp__get_tool_schema",
        arguments: { tool_name: "mock_nonexistent" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const content = result.content[0] as { type: string; text?: string };
      expect(content.text).toContain("Unknown tool");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 6. mcp__invoke_tool delegates through policy pipeline
  // -----------------------------------------------------------------------
  it("mcp__invoke_tool calls tool with correct arguments", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mcp__invoke_tool",
        arguments: { tool_name: "mock_echo", input: { message: "compressor test" } },
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const content = result.content[0] as { type: string; text?: string };
      const parsed = JSON.parse(content.text ?? "{}");
      expect(parsed).toEqual({ echoed: "compressor test" });
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 7. mcp__invoke_tool correctly routes add tool
  // -----------------------------------------------------------------------
  it("mcp__invoke_tool calls add tool with numeric args", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      const result = await ctx.client.callTool({
        name: "mcp__invoke_tool",
        arguments: { tool_name: "mock_add", input: { a: 10, b: 20 } },
      });
      const content = result.content[0] as { type: string; text?: string };
      expect(content.text).toBe("30");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 8. Audit entries generated for wrapper calls
  // -----------------------------------------------------------------------
  it("generates audit entries for compressor wrapper calls", async () => {
    const ctx = await buildProxy(makeConfig());
    try {
      await ctx.client.callTool({ name: "mcp__list_tools", arguments: {} });
      await ctx.client.callTool({
        name: "mcp__invoke_tool",
        arguments: { tool_name: "mock_echo", input: { message: "audit" } },
      });

      const entries = ctx.audit.getEntries();
      const entryNames = entries.map((e) => e.toolName);
      expect(entryNames).toContain("mcp__list_tools");

      // The invoke_tool wrapper call is logged as "mcp__invoke_tool" (proxy audit),
      // and the inner tool call is logged as "mock_echo" (forwardToolCall audit).
      expect(entryNames).toContain("mcp__invoke_tool");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 9. Whitelist filtering: mcp__list_tools only shows allowed tools
  // -----------------------------------------------------------------------
  it("mcp__list_tools filters by whitelist when allow is restricted", async () => {
    const config = makeConfig({ tools: { allow: ["mock_echo"], deny: [] } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({ name: "mcp__list_tools", arguments: {} });
      const content = result.content[0] as { type: string; text?: string };
      const parsed = JSON.parse(content.text ?? "[]");

      const names = parsed.map((e: { name: string }) => e.name);
      expect(names).toEqual(["mock_echo"]);
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 10. Whitelist filtering: mcp__get_tool_schema rejects blocked tools
  // -----------------------------------------------------------------------
  it("mcp__get_tool_schema rejects tool not in allow list", async () => {
    const config = makeConfig({ tools: { allow: ["mock_echo"], deny: [] } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({
        name: "mcp__get_tool_schema",
        arguments: { tool_name: "mock_add" },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const content = result.content[0] as { type: string; text?: string };
      expect(content.text).toContain("not available");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 11. Blocked tool via mcp__invoke_tool reaches deny policy
  // -----------------------------------------------------------------------
  it("mcp__invoke_tool blocks tool matching deny pattern", async () => {
    const config = makeConfig({ tools: { allow: ["*"], deny: ["mock_echo"] } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({
        name: "mcp__invoke_tool",
        arguments: { tool_name: "mock_echo", input: { message: "block me" } },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      const content = result.content[0] as { type: string; text?: string };
      expect(content.text).toContain("deny");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 12. Compressor off still works as normal proxy
  // -----------------------------------------------------------------------
  it("compressor=off returns real tools from tools/list", async () => {
    const config = makeConfig({ compressor: { enabled: false, level: "light" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toContain("mock_echo");
      expect(names).toContain("mock_add");
      expect(names).toContain("mock_get_time");
      expect(tools).toHaveLength(3);
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 13. extreme level: tools/list returns real tools (not wrappers)
  // -----------------------------------------------------------------------
  it("tools/list returns real tools when compressor=extreme", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "extreme" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toContain("mock_echo");
      expect(names).toContain("mock_add");
      expect(names).toContain("mock_get_time");
      // Wrapper tools should NOT appear
      expect(names).not.toContain("mcp__list_tools");
      expect(names).not.toContain("mcp__get_tool_schema");
      expect(names).not.toContain("mcp__invoke_tool");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 14. extreme level: tool calls go directly to real tool names
  // -----------------------------------------------------------------------
  it("calls real tool directly when compressor=extreme", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "extreme" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.callTool({
        name: "mock_echo",
        arguments: { message: "direct call" },
      });
      expect((result as { isError?: boolean }).isError).toBeFalsy();
      const content = result.content[0] as { type: string; text?: string };
      const parsed = JSON.parse(content.text ?? "{}");
      expect(parsed).toEqual({ echoed: "direct call" });
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 15. extreme level: tools still have inputSchema with type info
  // -----------------------------------------------------------------------
  it("extreme level preserves type info but strips descriptions", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "extreme" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const echoTool = tools.find(t => t.name === "mock_echo")!;
      expect(echoTool.inputSchema).toBeDefined();
      expect(echoTool.inputSchema.type).toBe("object");
      expect(echoTool.inputSchema.properties).toBeDefined();

      const messageProp = (echoTool.inputSchema.properties as Record<string, Record<string, unknown>>).message;
      expect(messageProp).toBeDefined();
      expect(messageProp.type).toBe("string");
      // Description should be stripped at extreme level
      expect(messageProp.description).toBeUndefined();
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 16. maximum level: tools/list returns real tools with minimal schemas
  // -----------------------------------------------------------------------
  it("tools/list returns real tools when compressor=maximum", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "maximum" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const names = tools.map((t) => t.name);

      expect(names).toContain("mock_echo");
      expect(names).toContain("mock_add");
      expect(names).toContain("mock_get_time");
      // Wrapper tools should NOT appear
      expect(names).not.toContain("mcp__list_tools");
      expect(names).not.toContain("mcp__get_tool_schema");
      expect(names).not.toContain("mcp__invoke_tool");
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 17. maximum level: inputSchema is minimal {type:object}
  // -----------------------------------------------------------------------
  it("maximum level replaces inputSchema with minimal {type:object}", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "maximum" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const echoTool = tools.find(t => t.name === "mock_echo")!;
      expect(echoTool.inputSchema).toEqual({ type: "object", properties: {} });
    } finally {
      await destroyProxy(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // 18. maximum level: description contains function signature
  // -----------------------------------------------------------------------
  it("maximum level embeds function signature in description", async () => {
    const config = makeConfig({ compressor: { enabled: true, level: "maximum" } });
    const ctx = await buildProxy(config);
    try {
      const result = await ctx.client.listTools();
      const tools = result.tools as Tool[];
      const echoTool = tools.find(t => t.name === "mock_echo")!;
      // Description should contain the function signature
      expect(echoTool.description).toContain("mock_echo(message: string)");
    } finally {
      await destroyProxy(ctx);
    }
  });
});
