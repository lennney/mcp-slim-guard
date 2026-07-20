/**
 * Tests for GuardProxy
 *
 * Uses vi.mock() to mock Server, StdioServerTransport, and ServerManager.
 * Does NOT spawn real processes. The MCP SDK Server mock captures handlers
 * so tests can invoke tools/list and tools/call directly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { GuardConfig } from "../../src/config-types.js";
import type { PolicyContext, PolicyResult } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Shared mock symbols — same objects used in vi.mock factory and in tests
// vi.hoisted() ensures these are initialized before vi.mock factories run.
// ---------------------------------------------------------------------------

const { LIST_TOOLS_SCHEMA, CALL_TOOL_SCHEMA } = vi.hoisted(() => ({
  LIST_TOOLS_SCHEMA: Symbol("ListToolsRequestSchema"),
  CALL_TOOL_SCHEMA: Symbol("CallToolRequestSchema"),
}));

// ---------------------------------------------------------------------------
// Shared mock state for Server instances
// ---------------------------------------------------------------------------

/** Map schema → handler, populated when the mock Server registers handlers */
let mockServerHandlers: Map<symbol, Function>;

/** All mock Server instances created during a test */
let mockServerInstances: Array<{
  setRequestHandler: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}>;

// ---------------------------------------------------------------------------
// Mock MCP SDK modules
// ---------------------------------------------------------------------------

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(() => {
    const instance = {
      setRequestHandler: vi.fn(
        (schema: symbol, handler: Function) => {
          mockServerHandlers!.set(schema, handler);
        },
      ),
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockServerInstances!.push(instance);
    return instance;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(() => ({})),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: LIST_TOOLS_SCHEMA,
  CallToolRequestSchema: CALL_TOOL_SCHEMA,
}));

// ---------------------------------------------------------------------------
// Import SUT (must come after vi.mock)
// ---------------------------------------------------------------------------

import { GuardProxy } from "../../src/proxy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal GuardConfig for testing */
function makeMinimalConfig(): GuardConfig {
  return {
    version: 1,
    tools: { allow: [], deny: [] },
    ssrf: {
      mode: "off",
      block_private_ips: false,
      allow_domains: [],
      block_domains: [],
    },
    rate_limit: { default: 100 },
    injection_detection: { enabled: false },
    compressor: { enabled: false, level: "light" },
    servers: {},
  };
}

/** Create a mock Pipeline with executeWithTrail */
function makeMockPipeline() {
  return {
    execute: vi.fn().mockResolvedValue({ allowed: true }),
    executeWithTrail: vi.fn().mockResolvedValue({ result: { allowed: true }, trail: [] }),
    getPolicyNames: vi.fn().mockReturnValue([]),
  };
}

/** Create a mock AuditLogger */
function makeMockAudit() {
  return {
    log: vi.fn(),
    getEntries: vi.fn().mockReturnValue([]),
    clear: vi.fn(),
    newSession: vi.fn().mockReturnValue("s_test"),
    logDiscovery: vi.fn(),
  };
}

/** Create a mock ServerManager */
function makeMockServerManager() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getTools: vi.fn().mockReturnValue([]),
    resolveTool: vi.fn(),
    callTool: vi
      .fn()
      .mockResolvedValue({
        content: [{ type: "text" as const, text: "ok" }],
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GuardProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServerHandlers = new Map();
    mockServerInstances = [];
  });

  // -----------------------------------------------------------------------
  // 1. Constructor stores dependencies
  // -----------------------------------------------------------------------
  it("should store constructor dependencies", () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    expect(proxy).toBeInstanceOf(GuardProxy);
    // getServer() before start should throw
    expect(() => proxy.getServer()).toThrow("Server not started");
  });

  // -----------------------------------------------------------------------
  // 2. start() starts ServerManager and creates Server
  // -----------------------------------------------------------------------
  it("should start ServerManager and create Server on start", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    const transport = {};
    await proxy.start(transport as never);

    // ServerManager.start() should be called
    expect(serverManager.start).toHaveBeenCalledTimes(1);

    // A Server instance should be created
    expect(mockServerInstances).toHaveLength(1);
    const srv = mockServerInstances[0];

    // Server should be connected to the transport
    expect(srv.connect).toHaveBeenCalledWith(transport);

    // Two handlers should be registered (list + call)
    expect(srv.setRequestHandler).toHaveBeenCalledTimes(2);
    expect(srv.setRequestHandler).toHaveBeenCalledWith(
      LIST_TOOLS_SCHEMA,
      expect.any(Function),
    );
    expect(srv.setRequestHandler).toHaveBeenCalledWith(
      CALL_TOOL_SCHEMA,
      expect.any(Function),
    );
  });

  // -----------------------------------------------------------------------
  // 3. tools/list handler returns tools from ServerManager
  // -----------------------------------------------------------------------
  it("tools/list handler should return tools from ServerManager", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    const mockTools = [
      { name: "git_search", inputSchema: { type: "object" as const } },
      { name: "git_status", inputSchema: { type: "object" as const } },
    ];
    serverManager.getTools.mockReturnValue(mockTools);

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    // Find and invoke the list handler
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA);
    expect(listHandler).toBeDefined();

    const result = await listHandler!({});

    expect(result).toEqual({ tools: mockTools });
    expect(serverManager.getTools).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 4. tools/call handler forwards allowed requests
  // -----------------------------------------------------------------------
  it("tools/call handler should forward allowed requests", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    // Resolve: github → { serverName: "github", originalToolName: "search" }
    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });

    // Pipeline allows
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });

    // Upstream returns a result
    const upstreamResult = {
      content: [{ type: "text" as const, text: "found 3 repos" }],
    };
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    // Invoke the call handler
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    expect(callHandler).toBeDefined();

    const request = {
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    };
    const result = await callHandler!(request);

    // Should return the upstream result
    expect(result).toEqual(upstreamResult);

    // Verify resolveTool was called
    expect(serverManager.resolveTool).toHaveBeenCalledWith("github_search");

    // Verify pipeline was called with correct context
    expect(pipeline.executeWithTrail).toHaveBeenCalledTimes(1);
    expect(pipeline.executeWithTrail).toHaveBeenCalledWith({
      toolName: "github_search",
      arguments: { q: "mcp" },
      serverName: "github",
    });

    // Verify callTool was forwarded
    expect(serverManager.callTool).toHaveBeenCalledWith(
      "github",
      "search",
      { q: "mcp" },
    );
  });

  // -----------------------------------------------------------------------
  // 5. tools/call handler rejects blocked requests
  // -----------------------------------------------------------------------
  it("tools/call handler should reject blocked requests", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });

    // Pipeline blocks
    pipeline.executeWithTrail.mockResolvedValue({
      result: {
        allowed: false,
        reason: "Rate limit exceeded",
        policy: "ratelimit",
      },
      trail: [{ policy: "ratelimit", result: "block", reason: "Rate limit exceeded" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    expect(callHandler).toBeDefined();

    const request = {
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "test" } },
    };
    const result = await callHandler!(request);

    // Should return an error
    expect(result).toEqual({
      content: [{ type: "text", text: "Rate limit exceeded" }],
      isError: true,
    });

    // callTool should NOT have been called
    expect(serverManager.callTool).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 6. tools/call handler audit-logs all requests (allowed and blocked)
  // -----------------------------------------------------------------------
  it("tools/call handler should audit-log allowed requests", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "srv",
      originalToolName: "tool1",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    await callHandler!({
      method: "tools/call",
      params: { name: "srv_tool1", arguments: { x: 1 } },
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      { toolName: "srv_tool1", arguments: { x: 1 }, serverName: "srv" },
      { allowed: true },
      [],                // trail
      expect.any(String), // sessionId
      1,                  // requestId
      expect.any(Number), // durationMs
    );
  });

  it("tools/call handler should audit-log blocked requests", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "srv",
      originalToolName: "tool1",
    });
    pipeline.executeWithTrail.mockResolvedValue({
      result: {
        allowed: false,
        reason: "Blocked by whitelist",
        policy: "whitelist",
      },
      trail: [{ policy: "whitelist", result: "block", reason: "Blocked by whitelist" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    await callHandler!({
      method: "tools/call",
      params: { name: "srv_tool1", arguments: { x: 1 } },
    });

    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      { toolName: "srv_tool1", arguments: { x: 1 }, serverName: "srv" },
      { allowed: false, reason: "Blocked by whitelist", policy: "whitelist" },
      [{ policy: "whitelist", result: "block", reason: "Blocked by whitelist" }],
      expect.any(String),
      1,
      expect.any(Number),
    );
  });

  // -----------------------------------------------------------------------
  // 7. tools/call handler returns error for unknown tool
  // -----------------------------------------------------------------------
  it("tools/call handler should return error for unknown tool", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    // resolveTool returns null for unknown tool
    serverManager.resolveTool.mockReturnValue(null);

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    expect(callHandler).toBeDefined();

    const request = {
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    };
    const result = await callHandler!(request);

    expect(result).toEqual({
      content: [{ type: "text", text: "Unknown tool: nonexistent_tool" }],
      isError: true,
    });

    // Pipeline should NOT be called for unknown tools
    expect(pipeline.executeWithTrail).not.toHaveBeenCalled();
    // callTool should NOT be called
    expect(serverManager.callTool).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 8. getServer() returns the Server instance
  // -----------------------------------------------------------------------
  it("getServer should return the underlying Server instance after start", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const server = proxy.getServer();
    expect(server).toBe(mockServerInstances[0]);
    expect(server).toHaveProperty("connect");
    expect(server).toHaveProperty("setRequestHandler");
    expect(server).toHaveProperty("close");
  });

  // -----------------------------------------------------------------------
  // 9. stop() closes server and stops ServerManager
  // -----------------------------------------------------------------------
  it("stop should close server and stop ServerManager", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const srv = mockServerInstances[0];
    expect(srv.close).not.toHaveBeenCalled();
    expect(serverManager.stop).not.toHaveBeenCalled();

    await proxy.stop();

    expect(srv.close).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // 10. tools/call handler passes correct PolicyContext to pipeline
  // -----------------------------------------------------------------------
  it("tools/call handler should pass correct PolicyContext to pipeline", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    // Use underscores in both server and tool names to exercise the resolver
    serverManager.resolveTool.mockReturnValue({
      serverName: "my_complex_server",
      originalToolName: "my_tool",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text", text: "done" }],
    });

    const proxy = new GuardProxy(
      config,
      pipeline as never,
      audit as never,
      serverManager as never,
    );

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    expect(callHandler).toBeDefined();

    const request = {
      method: "tools/call",
      params: {
        name: "my_complex_server_my_tool",
        arguments: { repo: "org/project", limit: 10 },
      },
    };
    await callHandler!(request);

    // Verify the exact PolicyContext passed to pipeline.executeWithTrail
    expect(pipeline.executeWithTrail).toHaveBeenCalledWith({
      toolName: "my_complex_server_my_tool",
      arguments: { repo: "org/project", limit: 10 },
      serverName: "my_complex_server",
    });

    // Also verify audit received the same context
    expect(audit.log).toHaveBeenCalledWith(
      {
        toolName: "my_complex_server_my_tool",
        arguments: { repo: "org/project", limit: 10 },
        serverName: "my_complex_server",
      },
      { allowed: true },
      [],
      expect.any(String),
      1,
      expect.any(Number),
    );
  });
});
