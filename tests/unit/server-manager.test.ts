/**
 * Tests for ServerManager
 *
 * Uses vi.mock() to mock Client and StdioClientTransport — does NOT spawn real processes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { UpstreamServer } from "../../src/config-types.js";

// ---------------------------------------------------------------------------
// Shared mock configuration — set per-test to control what each server returns
// ---------------------------------------------------------------------------

/** Tools to return for each server, keyed by server name */
let mockToolsForServer: Record<string, Array<Record<string, unknown>>> = {};

/** Ordered list of server names corresponding to the order clients are created */
let mockServerOrder: string[] = [];

/** Track failures: set connectFail[srvName] = true to simulate a connect error */
let mockConnectFails: Record<string, boolean> = {};

/** Collects all mock client instances created during a test */
let mockClientInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];

// ---------------------------------------------------------------------------
// Mock MCP SDK modules
// ---------------------------------------------------------------------------
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => {
    const idx = mockClientInstances.length;
    const srvName = mockServerOrder[idx] ?? "unknown";
    const toolsRaw = mockToolsForServer[srvName] ?? [];
    const tools = toolsRaw.map((t) => ({
      name: String(t.name ?? ""),
      description: t.description != null ? String(t.description) : undefined,
      inputSchema: {
        type: "object" as const,
        ...(t.inputSchema as Record<string, unknown> | undefined),
      },
    }));

    const instance = {
      connect: mockConnectFails[srvName]
        ? vi.fn().mockRejectedValue(new Error("Connection refused"))
        : vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools }),
      callTool: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockClientInstances.push(instance);
    return instance;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolResultSchema: {},
}));

// ---------------------------------------------------------------------------
// Import the SUT
// ---------------------------------------------------------------------------
import { ServerManager } from "../../src/server-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Factory for UpstreamServer test data */
const serverCfg = (
  command = "node",
  args: string[] = ["server.js"],
  env: Record<string, string> = {},
): UpstreamServer => ({ command, args, env });

/** Create a ServerManager with pre-configured mock tools */
async function makeServerManager(
  servers: Record<string, UpstreamServer>,
  tools: Record<string, Array<Record<string, unknown>>> = {},
): Promise<ServerManager> {
  vi.clearAllMocks();
  mockClientInstances = [];
  mockServerOrder = Object.keys(servers);
  mockToolsForServer = { ...tools };
  mockConnectFails = {};

  const manager = new ServerManager(servers);
  await manager.start();
  return manager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("ServerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientInstances = [];
    mockServerOrder = [];
    mockToolsForServer = {};
    mockConnectFails = {};
  });

  // 1. Constructor stores server configs
  it("should create connections for each server on start", async () => {
    const manager = new ServerManager({
      a: serverCfg(),
      b: serverCfg(),
    });
    expect(mockClientInstances).toHaveLength(0);

    await manager.start();

    expect(mockClientInstances).toHaveLength(2);
    for (const client of mockClientInstances) {
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.listTools).toHaveBeenCalledTimes(1);
    }
  });

  // 2. start() connects to all servers and collects tools
  it("should connect to all servers and call listTools on each", async () => {
    await makeServerManager(
      { x: serverCfg(), y: serverCfg() },
      { x: [{ name: "foo" }], y: [{ name: "bar" }] },
    );

    expect(mockClientInstances).toHaveLength(2);
    for (const client of mockClientInstances) {
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.listTools).toHaveBeenCalledTimes(1);
    }
  });

  // 3. getTools() returns prefixed tool names
  it("getTools should return prefixed tool names", async () => {
    const manager = await makeServerManager(
      { srv1: serverCfg(), srv2: serverCfg() },
      {
        srv1: [{ name: "greet" }],
        srv2: [{ name: "search" }, { name: "fetch" }],
      },
    );

    const tools = manager.getTools();

    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name);
    expect(names).toContain("srv1_greet");
    expect(names).toContain("srv2_search");
    expect(names).toContain("srv2_fetch");

    // Descriptions should include server name prefix
    for (const tool of tools) {
      expect(tool.description).toBeDefined();
    }
  });

  // 4. resolveTool() correctly parses serverName_toolName format
  it("resolveTool should correctly parse serverName_toolName", async () => {
    const manager = await makeServerManager(
      { my_server: serverCfg() },
      { my_server: [{ name: "list_stuff" }] },
    );

    const result = manager.resolveTool("my_server_list_stuff");

    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("my_server");
    expect(result!.originalToolName).toBe("list_stuff");
  });

  // 5. resolveTool() returns null for unknown tool
  it("resolveTool should return null for unknown tool", async () => {
    const manager = await makeServerManager(
      { srv: serverCfg() },
      { srv: [{ name: "exists" }] },
    );

    expect(manager.resolveTool("srv_nonexistent")).toBeNull();
    expect(manager.resolveTool("unknown_server_tool")).toBeNull();
    expect(manager.resolveTool("no_underscore")).toBeNull();
    expect(manager.resolveTool("")).toBeNull();
  });

  // 6. callTool() forwards to correct server
  it("callTool should forward to the correct upstream server", async () => {
    const manager = await makeServerManager(
      { srv_a: serverCfg(), srv_b: serverCfg() },
      { srv_a: [{ name: "alpha" }], srv_b: [{ name: "beta" }] },
    );

    mockClientInstances[0].callTool.mockResolvedValue({
      content: [{ type: "text", text: "result from A" }],
    });
    mockClientInstances[1].callTool.mockResolvedValue({
      content: [{ type: "text", text: "result from B" }],
    });

    const resultA = await manager.callTool("srv_a", "alpha", { x: 1 });
    const resultB = await manager.callTool("srv_b", "beta", { y: 2 });

    expect(resultA.content[0].text).toBe("result from A");
    expect(resultB.content[0].text).toBe("result from B");

    expect(mockClientInstances[0].callTool).toHaveBeenCalledWith(
      { name: "alpha", arguments: { x: 1 } },
      expect.anything(),
    );
    expect(mockClientInstances[1].callTool).toHaveBeenCalledWith(
      { name: "beta", arguments: { y: 2 } },
      expect.anything(),
    );
  });

  // 7. stop() closes all connections
  it("stop should close all connections and clear state", async () => {
    const manager = await makeServerManager(
      { srv1: serverCfg(), srv2: serverCfg() },
      { srv1: [{ name: "t1" }], srv2: [{ name: "t2" }] },
    );

    expect(manager.getTools()).toHaveLength(2);

    await manager.stop();

    // After stop, connections are cleared — resolveTool returns null
    expect(manager.resolveTool("srv1_t1")).toBeNull();
    expect(manager.getTools()).toHaveLength(0);
  });

  // 8. Graceful handling: one server fails, others still work
  it("should continue with other servers when one fails to start", async () => {
    vi.clearAllMocks();
    mockClientInstances = [];
    mockServerOrder = ["good", "bad", "also_good"];
    mockToolsForServer = {
      good: [{ name: "ok" }],
      bad: [{ name: "ok" }],
      also_good: [{ name: "ok" }],
    };
    mockConnectFails = { bad: true };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const manager = new ServerManager({
      good: serverCfg(),
      bad: serverCfg(),
      also_good: serverCfg(),
    });
    await manager.start();

    warnSpy.mockRestore();

    const tools = manager.getTools();
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name);
    expect(names).toContain("good_ok");
    expect(names).toContain("also_good_ok");
    expect(names).not.toContain("bad_ok");
  });

  // 9a. resolveTool handles tool names with underscores
  it("resolveTool should handle tool names with underscores", async () => {
    const manager = await makeServerManager(
      { srv: serverCfg() },
      { srv: [{ name: "my_tool_with_underscores" }] },
    );

    const result = manager.resolveTool("srv_my_tool_with_underscores");
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("srv");
    expect(result!.originalToolName).toBe("my_tool_with_underscores");
  });

  // 9b. resolveTool handles server names with underscores
  it("resolveTool should handle server names with underscores", async () => {
    const manager = await makeServerManager(
      { my_complex_server: serverCfg() },
      { my_complex_server: [{ name: "list" }] },
    );

    // Tries splits: "my"(✗) → "my_complex"(✗) → "my_complex_server"(✓)
    const result = manager.resolveTool("my_complex_server_list");
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("my_complex_server");
    expect(result!.originalToolName).toBe("list");
  });

  // 9c. resolveTool handles both server and tool with underscores
  it("resolveTool should handle both server and tool with underscores", async () => {
    const manager = await makeServerManager(
      { my_server: serverCfg() },
      { my_server: [{ name: "my_tool" }] },
    );

    const result = manager.resolveTool("my_server_my_tool");
    expect(result).not.toBeNull();
    expect(result!.serverName).toBe("my_server");
    expect(result!.originalToolName).toBe("my_tool");
  });

  // 10a. callTool throws for unknown server
  it("callTool should throw when server is unknown", async () => {
    const manager = await makeServerManager(
      { srv: serverCfg() },
      { srv: [{ name: "tool" }] },
    );

    await expect(
      manager.callTool("nonexistent", "tool", {}),
    ).rejects.toThrow("Unknown upstream server");
  });

  // 10b. callTool propagates upstream errors
  it("callTool should propagate upstream errors", async () => {
    const manager = await makeServerManager(
      { srv: serverCfg() },
      { srv: [{ name: "fail_tool" }] },
    );

    mockClientInstances[0].callTool.mockRejectedValue(
      new Error("Upstream server error"),
    );

    await expect(
      manager.callTool("srv", "fail_tool", { data: "test" }),
    ).rejects.toThrow("Upstream server error");
  });

  // Edge: empty server config
  it("should handle empty server config", async () => {
    const manager = new ServerManager({});
    await manager.start();

    expect(mockClientInstances).toHaveLength(0);
    expect(manager.getTools()).toHaveLength(0);
  });
});
