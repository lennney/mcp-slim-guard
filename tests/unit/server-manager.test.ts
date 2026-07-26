import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "../../src/config-types.js";
import { ServerManager } from "../../src/server-manager.js";
import { InMemoryUpstreamConnector, type InMemoryUpstreamDefinition } from "../helpers/in-memory-upstream.js";

const stdioServer = (command = "node"): UpstreamServer => ({
  command,
  args: ["server.js"],
  env: {},
});

const tool = (name: string, description?: string): Tool => ({
  name,
  ...(description ? { description } : {}),
  inputSchema: { type: "object" },
});

async function startManager(
  servers: Record<string, UpstreamServer>,
  definitions: Record<string, InMemoryUpstreamDefinition>,
): Promise<{ manager: ServerManager; connector: InMemoryUpstreamConnector }> {
  const connector = new InMemoryUpstreamConnector(definitions);
  const manager = new ServerManager(servers, connector);
  await manager.start();
  return { manager, connector };
}

describe("ServerManager", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("connects every configured server through the upstream seam", async () => {
    const servers = {
      local: stdioServer(),
      remote: { type: "http" as const, url: "https://mcp.example.test/mcp" },
    };
    const connector = new InMemoryUpstreamConnector({
      local: { tools: [tool("echo")] },
      remote: { tools: [tool("search")], transportKind: "streamable-http" },
    });
    const manager = new ServerManager(servers, connector);
    const report = await manager.start();

    expect(connector.connectCalls).toEqual([
      { serverName: "local", server: servers.local },
      { serverName: "remote", server: servers.remote },
    ]);
    expect(report).toEqual({
      configured: 2,
      connected: [
        { serverName: "local", transportKind: "stdio", toolCount: 1 },
        { serverName: "remote", transportKind: "streamable-http", toolCount: 1 },
      ],
      failed: [],
    });
  });

  it("returns catalog tools with exact server prefixes", async () => {
    const { manager } = await startManager(
      { alpha: stdioServer(), beta: stdioServer() },
      {
        alpha: { tools: [tool("echo", "Echo input")] },
        beta: { tools: [tool("search"), tool("fetch")] },
      },
    );

    expect(manager.getTools()).toEqual([
      expect.objectContaining({ name: "alpha_echo", description: "[alpha] Echo input" }),
      expect.objectContaining({ name: "beta_search", description: "[beta]" }),
      expect.objectContaining({ name: "beta_fetch", description: "[beta]" }),
    ]);
  });

  it("resolves exact catalog entries with underscores", async () => {
    const { manager } = await startManager(
      { my_server: stdioServer() },
      { my_server: { tools: [tool("my_tool_with_underscores")] } },
    );

    expect(manager.resolveTool("my_server_my_tool_with_underscores")).toEqual({
      serverName: "my_server",
      originalToolName: "my_tool_with_underscores",
    });
  });

  it("rejects guessed tools, unknown servers, and malformed names", async () => {
    const { manager } = await startManager({ server: stdioServer() }, { server: { tools: [tool("exists")] } });

    expect(manager.resolveTool("server_exists")).not.toBeNull();
    expect(manager.resolveTool("server_guessed")).toBeNull();
    expect(manager.resolveTool("unknown_exists")).toBeNull();
    expect(manager.resolveTool("")).toBeNull();
  });

  it("rejects a prefixed name that is ambiguous across catalogs", async () => {
    const { manager } = await startManager(
      { foo: stdioServer(), foo_bar: stdioServer() },
      {
        foo: { tools: [tool("bar_baz")] },
        foo_bar: { tools: [tool("baz")] },
      },
    );

    expect(manager.resolveTool("foo_bar_baz")).toBeNull();
  });

  it("routes calls through the connected upstream session", async () => {
    const { manager, connector } = await startManager(
      { alpha: stdioServer(), beta: stdioServer() },
      {
        alpha: { tools: [tool("read")] },
        beta: {
          tools: [tool("search")],
          call: async () => ({
            content: [{ type: "text", text: "remote result" }],
          }),
        },
      },
    );

    await expect(manager.callTool("beta", "search", { q: "mcp" })).resolves.toEqual({
      content: [{ type: "text", text: "remote result" }],
    });
    expect(connector.state("beta").calls).toEqual([
      {
        toolName: "search",
        args: { q: "mcp" },
      },
    ]);
    expect(connector.state("alpha").calls).toEqual([]);
  });

  it("preserves the complete upstream CallToolResult", async () => {
    const upstreamResult: CallToolResult = {
      content: [{ type: "text", text: "failed safely" }],
      structuredContent: { code: "E_UPSTREAM", retryable: false },
      isError: true,
      _meta: { traceId: "trace-123" },
    };
    const { manager } = await startManager(
      { server: stdioServer() },
      {
        server: {
          tools: [tool("read")],
          call: async () => upstreamResult,
        },
      },
    );

    await expect(manager.callTool("server", "read", {})).resolves.toEqual(upstreamResult);
  });

  it("throws for an unknown or disconnected server", async () => {
    const { manager } = await startManager({ server: stdioServer() }, { server: { tools: [tool("read")] } });

    await expect(manager.callTool("missing", "read", {})).rejects.toThrow("Unknown upstream server");
  });

  it("propagates upstream tool errors", async () => {
    const { manager } = await startManager(
      { server: stdioServer() },
      {
        server: {
          tools: [tool("fail")],
          call: async () => {
            throw new Error("Upstream server error");
          },
        },
      },
    );

    await expect(manager.callTool("server", "fail", {})).rejects.toThrow("Upstream server error");
  });

  it("continues when one upstream cannot connect", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const servers = {
      good: stdioServer(),
      bad: stdioServer(),
      also_good: stdioServer(),
    };
    const connector = new InMemoryUpstreamConnector({
      good: { tools: [tool("one")] },
      bad: { tools: [], connectError: new Error("Connection refused") },
      also_good: { tools: [tool("two")] },
    });
    const manager = new ServerManager(servers, connector);
    const report = await manager.start();

    expect(manager.getTools().map((entry) => entry.name)).toEqual(["good_one", "also_good_two"]);
    expect(warn).toHaveBeenCalledWith('[mcp-slim-guard] Failed to connect to server "bad" (Error)');
    expect(report).toEqual({
      configured: 3,
      connected: [
        { serverName: "good", transportKind: "stdio", toolCount: 1 },
        { serverName: "also_good", transportKind: "stdio", toolCount: 1 },
      ],
      failed: [{ serverName: "bad", errorType: "Error" }],
    });
  });

  it("closes all sessions and clears the catalog", async () => {
    const { manager, connector } = await startManager(
      { one: stdioServer(), two: stdioServer() },
      {
        one: { tools: [tool("a")] },
        two: { tools: [tool("b")] },
      },
    );

    const report = await manager.stop();

    expect(connector.state("one").closed).toBe(true);
    expect(connector.state("two").closed).toBe(true);
    expect(manager.getTools()).toEqual([]);
    expect(manager.resolveTool("one_a")).toBeNull();
    expect(report).toEqual({ closed: ["one", "two"], failed: [] });
  });

  it("continues shutdown when one session close fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager, connector } = await startManager(
      { broken: stdioServer(), healthy: stdioServer() },
      {
        broken: { tools: [], closeError: new Error("close failed") },
        healthy: { tools: [] },
      },
    );

    const report = await manager.stop();

    expect(connector.state("broken").closed).toBe(true);
    expect(connector.state("healthy").closed).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(report).toEqual({
      closed: ["healthy"],
      failed: [{ serverName: "broken", errorType: "Error" }],
    });
  });

  it("discovers only connected upstreams", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { manager } = await startManager(
      { one: stdioServer(), broken: stdioServer() },
      {
        one: { tools: [tool("a")] },
        broken: { tools: [], connectError: new Error("offline") },
      },
    );

    await expect(manager.discover()).resolves.toEqual({
      servers: [
        {
          name: "one",
          capabilities: { tools: { listChanged: false } },
        },
      ],
    });
  });

  it("handles an empty configuration", async () => {
    const { manager, connector } = await startManager({}, {});

    expect(connector.connectCalls).toEqual([]);
    expect(manager.getTools()).toEqual([]);
    await expect(manager.discover()).resolves.toEqual({ servers: [] });
  });
});
