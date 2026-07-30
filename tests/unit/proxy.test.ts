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
  sendToolListChanged: ReturnType<typeof vi.fn>;
}>;

// ---------------------------------------------------------------------------
// Mock MCP SDK modules
// ---------------------------------------------------------------------------

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(() => {
    const instance = {
      setRequestHandler: vi.fn((schema: symbol, handler: Function) => {
        mockServerHandlers!.set(schema, handler);
      }),
      connect: vi.fn((transport?: { connectError?: Error }) =>
        transport?.connectError ? Promise.reject(transport.connectError) : Promise.resolve(undefined),
      ),
      close: vi.fn().mockResolvedValue(undefined),
      sendToolListChanged: vi.fn().mockResolvedValue(undefined),
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
import { CALL_TOOL, FIND_TOOL, READ_RESULT } from "../../src/secure-projection.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal GuardConfig for testing */
function makeMinimalConfig(): GuardConfig {
  return {
    version: 1,
    tools: { allow: ["*"], deny: [] },
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
    newTrace: vi.fn().mockReturnValue("t_test"),
    logDiscovery: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock ServerManager */
function makeMockServerManager() {
  return {
    start: vi.fn().mockResolvedValue({ configured: 0, connected: [], failed: [] }),
    stop: vi.fn().mockResolvedValue({ closed: [], failed: [] }),
    getTools: vi
      .fn()
      .mockReturnValue(
        [
          "github_search",
          "github_create_repo",
          "srv_tool1",
          "srv_write",
          "my_complex_server_my_tool",
          "old_tool",
          "fixture_slow",
        ].map((name) => ({ name, inputSchema: { type: "object" as const } })),
      ),
    getNativeTools: vi.fn().mockReturnValue([]),
    getLegacyCatalogNames: vi.fn().mockReturnValue([]),
    resolveTool: vi.fn(),
    callTool: vi.fn().mockResolvedValue({
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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
    expect(srv.setRequestHandler).toHaveBeenCalledWith(LIST_TOOLS_SCHEMA, expect.any(Function));
    expect(srv.setRequestHandler).toHaveBeenCalledWith(CALL_TOOL_SCHEMA, expect.any(Function));
  });

  it("records a degraded ready lifecycle without exposing upstream configuration", async () => {
    const config = {
      ...makeMinimalConfig(),
      servers: {
        good: { command: "node", args: ["good.js"], env: {} },
        bad: { command: "node", args: ["bad.js"], env: { API_TOKEN: "not-for-audit" } },
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.start.mockResolvedValue({
      configured: 2,
      connected: [{ serverName: "good", transportKind: "stdio", toolCount: 2 }],
      failed: [{ serverName: "bad", errorType: "Error" }],
    });
    serverManager.getTools.mockReturnValue([
      { name: "good_one", inputSchema: { type: "object" as const } },
      { name: "good_two", inputSchema: { type: "object" as const } },
    ]);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const lifecycle = audit.log.mock.calls.filter((call) => call[6]?.event === "lifecycle");
    expect(lifecycle.map((call) => call[0].toolName)).toEqual(["runtime/starting", "runtime/ready_degraded"]);
    expect(lifecycle.map((call) => call[6]?.outcome)).toEqual(["success", "degraded"]);
    expect(lifecycle[1]?.[6]?.metadata).toEqual({
      configuredServers: 2,
      connectedUpstreams: [{ serverName: "good", transportKind: "stdio", toolCount: 2 }],
      failedUpstreams: [{ serverName: "bad", errorType: "Error" }],
      catalogTools: 2,
      modelFacingTools: 2,
    });
    expect(JSON.stringify(lifecycle)).not.toContain("API_TOKEN");
    expect(JSON.stringify(lifecycle)).not.toContain("bad.js");
  });

  it("cleans up upstream and downstream resources when downstream startup fails", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.stop.mockResolvedValue({
      closed: ["fixture"],
      failed: [],
    });
    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await expect(proxy.start({ connectError: new TypeError("transport failed") } as never)).rejects.toThrow(
      "transport failed",
    );

    expect(mockServerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(audit.close).toHaveBeenCalledTimes(1);
    const failed = audit.log.mock.calls.find((call) => call[0].toolName === "runtime/start_failed");
    expect(failed?.[6]).toEqual({
      event: "lifecycle",
      outcome: "internal_error",
      metadata: {
        errorType: "TypeError",
        upstreamClosed: ["fixture"],
        upstreamCloseFailures: [],
      },
    });
  });

  it("rolls back a connected upstream when startup fails before downstream connect", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.stop.mockResolvedValue({
      closed: ["fixture"],
      failed: [],
    });
    let finishManagerStart!: (report: { configured: number; connected: never[]; failed: never[] }) => void;
    serverManager.start.mockReturnValueOnce(
      new Promise((resolve) => {
        finishManagerStart = resolve;
      }),
    );
    serverManager.getTools.mockImplementationOnce(() => {
      throw new TypeError("catalog construction failed");
    });
    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    const starting = proxy.start({} as never);
    await vi.waitFor(() => expect(serverManager.start).toHaveBeenCalledTimes(1));
    const stopping = proxy.stop();
    finishManagerStart({ configured: 0, connected: [], failed: [] });
    await expect(starting).rejects.toThrow("catalog construction failed");

    expect(serverManager.start).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(mockServerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(() => proxy.getServer()).toThrow("Server not started");
    const stopOutcome = await Promise.race([
      stopping.then(() => "stopped" as const),
      new Promise<"timed_out">((resolve) => {
        setTimeout(() => resolve("timed_out"), 100);
      }),
    ]);
    expect(stopOutcome).toBe("stopped");

    serverManager.getTools.mockReturnValue([]);
    await expect(proxy.start({} as never)).resolves.toBeUndefined();
    await proxy.stop();
    expect(serverManager.start).toHaveBeenCalledTimes(2);
    expect(serverManager.stop).toHaveBeenCalledTimes(2);
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await proxy.start({} as never);

    // Find and invoke the list handler
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA);
    expect(listHandler).toBeDefined();

    const result = await listHandler!({});

    expect(result).toEqual({ tools: mockTools });
    expect(serverManager.getTools).toHaveBeenCalledTimes(1);
  });

  it("secure projection omits catalog names that do not resolve uniquely", async () => {
    const config: GuardConfig = {
      ...makeMinimalConfig(),
      tools: { allow: ["*"], deny: [] },
      compressor: { enabled: true, level: "light", lazy_loading: false },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "foo_bar_baz",
        description: "An ambiguous flattened route",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockReturnValue(null);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const result = await callHandler({
      method: "tools/call",
      params: { name: FIND_TOOL, arguments: { query: "ambiguous" } },
    });
    const content = result.content[0];
    expect(content.type).toBe("text");
    expect(JSON.parse(content.text).matches).toEqual([]);
    expect(serverManager.callTool).not.toHaveBeenCalled();
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await proxy.start({} as never);

    // Invoke the call handler
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    expect(callHandler).toBeDefined();

    const request = {
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    };
    const result = await callHandler!(request);

    // Pass-through must return the exact upstream object without adding fields.
    expect(result).toBe(upstreamResult);

    // Verify resolveTool was called
    expect(serverManager.resolveTool).toHaveBeenCalledWith("github_search");

    // Verify pipeline was called with correct context
    expect(pipeline.executeWithTrail).toHaveBeenCalledTimes(1);
    expect(pipeline.executeWithTrail).toHaveBeenCalledWith({
      toolName: "github_search",
      arguments: { q: "mcp" },
      serverName: "github",
      agentId: "s_test",
    });

    // Verify callTool was forwarded
    expect(serverManager.callTool).toHaveBeenCalledWith("github", "search", { q: "mcp" });
  });

  it("routes an advertised catalog Tool whose name matches a reserved wrapper", async () => {
    const config = {
      ...makeMinimalConfig(),
      compressor: { enabled: false, level: "off" as const },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const upstreamResult = {
      content: [{ type: "text" as const, text: "upstream list result" }],
    };
    serverManager.getTools.mockReturnValue([
      {
        name: "mcp__list_tools",
        description: "A real upstream Tool",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockImplementation((name: string) =>
      name === "mcp__list_tools" ? { serverName: "mcp_", originalToolName: "list_tools" } : null,
    );
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    expect((await listHandler({})).tools.map((tool: { name: string }) => tool.name)).toEqual(["mcp__list_tools"]);
    await expect(
      callHandler({
        params: { name: "mcp__list_tools", arguments: { marker: "real-tool" } },
      }),
    ).resolves.toBe(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledOnce();
    expect(serverManager.callTool).toHaveBeenCalledWith("mcp_", "list_tools", { marker: "real-tool" });
  });

  it("returns the exact upstream result when audit recording throws after execution", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["srv_*"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const upstreamResult = {
      content: [{ type: "text" as const, text: "side effect completed" }],
      extension: { preserve: true },
    };
    serverManager.resolveTool.mockReturnValue({
      serverName: "srv",
      originalToolName: "write",
    });
    serverManager.callTool.mockResolvedValue(upstreamResult);
    audit.log.mockImplementation((...args: unknown[]) => {
      const details = args[6] as { event?: string } | undefined;
      if (details?.event === "upstream") throw new Error("AUDIT_FAILURE_SENTINEL");
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await expect(
      callHandler({
        params: { name: "srv_write", arguments: { value: "once" } },
      }),
    ).resolves.toBe(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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
      resultType: "complete",
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    await callHandler!({
      method: "tools/call",
      params: { name: "srv_tool1", arguments: { x: 1 } },
    });

    const requestCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_test");
    expect(requestCalls).toHaveLength(2);
    expect(requestCalls[0]).toEqual([
      { toolName: "srv_tool1", arguments: {}, serverName: "srv", agentId: "s_test" },
      { allowed: true },
      [], // trail
      "s_test",
      expect.any(Number), // requestId
      expect.any(Number), // durationMs
      { traceId: "t_test", event: "policy", outcome: "success" },
    ]);
    expect(requestCalls[1]).toEqual([
      { toolName: "srv_tool1", arguments: {}, serverName: "srv", agentId: "s_test" },
      { allowed: true },
      [],
      "s_test",
      expect.any(Number),
      expect.any(Number),
      {
        traceId: "t_test",
        event: "upstream",
        outcome: "success",
        metadata: { upstreamInvoked: true, isError: false, contentBlocks: 1, resultChars: 43 },
      },
    ]);
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA);
    await callHandler!({
      method: "tools/call",
      params: { name: "srv_tool1", arguments: { x: 1 } },
    });

    const requestCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_test");
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0]).toEqual([
      { toolName: "srv_tool1", arguments: {}, serverName: "srv", agentId: "s_test" },
      { allowed: false, reason: "Blocked by whitelist", policy: "whitelist" },
      [{ policy: "whitelist", result: "block", reason: "Blocked by whitelist" }],
      "s_test",
      expect.any(Number),
      expect.any(Number),
      { traceId: "t_test", event: "policy", outcome: "blocked" },
    ]);
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

    await proxy.start({} as never);

    const srv = mockServerInstances[0];
    expect(srv.close).not.toHaveBeenCalled();
    expect(serverManager.stop).not.toHaveBeenCalled();

    await proxy.stop();

    expect(srv.close).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(audit.close).toHaveBeenCalledTimes(1);
    const lifecycle = audit.log.mock.calls.filter((call) => call[6]?.event === "lifecycle");
    expect(lifecycle.map((call) => call[0].toolName)).toEqual([
      "runtime/starting",
      "runtime/ready",
      "runtime/stopping",
      "runtime/stopped",
    ]);
  });

  it("continues upstream cleanup and records a degraded stop when downstream close fails", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.stop.mockResolvedValue({
      closed: ["healthy"],
      failed: [{ serverName: "broken", errorType: "Error" }],
    });
    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    mockServerInstances[0].close.mockRejectedValue(new TypeError("downstream close failed"));

    await expect(proxy.stop()).resolves.toBeUndefined();

    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(audit.close).toHaveBeenCalledTimes(1);
    const stopped = audit.log.mock.calls.find((call) => call[0].toolName === "runtime/stopped_degraded");
    expect(stopped?.[6]).toEqual({
      event: "lifecycle",
      outcome: "degraded",
      metadata: {
        upstreamClosed: ["healthy"],
        upstreamCloseFailures: [{ serverName: "broken", errorType: "Error" }],
        downstreamErrorType: "TypeError",
        invalidatedResults: 0,
        inFlightAtWait: 0,
        drainDurationMs: 0,
      },
    });
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

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);

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
      agentId: "s_test",
    });

    // Audit receives the route identity but never the invocation arguments.
    expect(audit.log).toHaveBeenCalledWith(
      {
        toolName: "my_complex_server_my_tool",
        arguments: {},
        serverName: "my_complex_server",
        agentId: "s_test",
      },
      { allowed: true },
      [],
      expect.any(String),
      expect.any(Number),
      expect.any(Number),
      { traceId: "t_test", event: "policy", outcome: "success" },
    );
  });

  it("preserves an omitted arguments field while policy evaluates an empty object", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.resolveTool.mockReturnValue({
      serverName: "my_complex_server",
      originalToolName: "my_tool",
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await callHandler({
      method: "tools/call",
      params: { name: "my_complex_server_my_tool" },
    });

    expect(pipeline.executeWithTrail).toHaveBeenCalledWith({
      toolName: "my_complex_server_my_tool",
      arguments: {},
      serverName: "my_complex_server",
      agentId: "s_test",
    });
    expect(serverManager.callTool).toHaveBeenCalledWith("my_complex_server", "my_tool", undefined);
  });

  it("correlates projection, policy, and upstream events without calling an upstream error a block", async () => {
    const config = {
      ...makeMinimalConfig(),
      compressor: { enabled: true, level: "light" as const },
      tools: { allow: ["agent_search_*"], deny: [] },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    audit.newTrace.mockReturnValueOnce("t_find").mockReturnValueOnce("t_call");
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "agent_search_free_search_advanced",
        description: "Advanced web search filters",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockReturnValue({
      serverName: "agent_search",
      originalToolName: "free_search_advanced",
    });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text", text: "UNSUPPORTED_FILTER" }],
      isError: true,
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const found = await callHandler({
      method: "tools/call",
      params: { name: FIND_TOOL, arguments: { query: "advanced web search" } },
    });
    const foundText = found.content[0];
    if (!foundText || foundText.type !== "text") throw new Error("Expected find_tool JSON");
    const match = JSON.parse(foundText.text).matches[0] as { tool_ref: string };

    const result = await callHandler({
      method: "tools/call",
      params: {
        name: CALL_TOOL,
        arguments: {
          tool_ref: match.tool_ref,
          arguments: { query: "offline", time_range: "day" },
        },
      },
    });

    expect(result.isError).toBe(true);
    const traceCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_call");
    expect(traceCalls).toHaveLength(3);
    expect(traceCalls.map((call) => call[6]?.event)).toEqual(["policy", "upstream", "projection"]);
    expect(traceCalls.map((call) => call[6]?.outcome)).toEqual(["success", "upstream_error", "upstream_error"]);
    expect(traceCalls[2]?.[1]).toEqual({ allowed: true });
    expect(traceCalls[2]?.[0].arguments).toEqual({});
  });

  it("keeps a projection policy rejection blocked without claiming an upstream invocation", async () => {
    const config = {
      ...makeMinimalConfig(),
      compressor: { enabled: true, level: "light" as const },
      tools: { allow: ["fixture_*"], deny: [] },
    };
    const pipeline = makeMockPipeline();
    pipeline.executeWithTrail.mockResolvedValue({
      result: { allowed: false, reason: "Rate limit exceeded", policy: "ratelimit" },
      trail: [{ policy: "ratelimit", result: "block", reason: "Rate limit exceeded" }],
    });
    const audit = makeMockAudit();
    audit.newTrace.mockReturnValueOnce("t_find").mockReturnValueOnce("t_blocked");
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "fixture_marker",
        description: "Fixture marker",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockReturnValue({
      serverName: "fixture",
      originalToolName: "marker",
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const found = await callHandler({
      method: "tools/call",
      params: { name: FIND_TOOL, arguments: { query: "fixture marker" } },
    });
    const foundText = found.content[0];
    if (!foundText || foundText.type !== "text") throw new Error("Expected find_tool JSON");
    const match = JSON.parse(foundText.text).matches[0] as { tool_ref: string };

    const result = await callHandler({
      method: "tools/call",
      params: {
        name: CALL_TOOL,
        arguments: { tool_ref: match.tool_ref, arguments: { value: "blocked" } },
      },
    });

    expect(result.isError).toBe(true);
    expect(serverManager.callTool).not.toHaveBeenCalled();
    const traceCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_blocked");
    expect(traceCalls.map((call) => call[6]?.event)).toEqual(["policy", "projection"]);
    expect(traceCalls.map((call) => call[6]?.outcome)).toEqual(["blocked", "blocked"]);
    expect(traceCalls[1]?.[1]).toEqual({
      allowed: false,
      reason: "Rate limit exceeded",
      policy: "projection",
    });
    expect(traceCalls[1]?.[6]?.metadata.upstreamInvoked).toBe(false);
  });

  it("adds a terminal projection event when the upstream transport throws", async () => {
    const config = {
      ...makeMinimalConfig(),
      compressor: { enabled: true, level: "light" as const },
      tools: { allow: ["fixture_*"], deny: [] },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    audit.newTrace.mockReturnValueOnce("t_find").mockReturnValueOnce("t_transport");
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "fixture_marker",
        description: "Fixture marker",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockReturnValue({
      serverName: "fixture",
      originalToolName: "marker",
    });
    serverManager.callTool.mockRejectedValue(new Error("Connection closed"));

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const found = await callHandler({
      method: "tools/call",
      params: { name: FIND_TOOL, arguments: { query: "fixture marker" } },
    });
    const foundText = found.content[0];
    if (!foundText || foundText.type !== "text") throw new Error("Expected find_tool JSON");
    const match = JSON.parse(foundText.text).matches[0] as { tool_ref: string };

    await expect(
      callHandler({
        method: "tools/call",
        params: {
          name: CALL_TOOL,
          arguments: { tool_ref: match.tool_ref, arguments: { value: "transport" } },
        },
      }),
    ).rejects.toThrow("Connection closed");

    const traceCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_transport");
    expect(traceCalls.map((call) => call[6]?.event)).toEqual(["policy", "upstream", "projection"]);
    expect(traceCalls.map((call) => call[6]?.outcome)).toEqual(["success", "transport_error", "transport_error"]);
    expect(traceCalls[2]?.[1]).toEqual({ allowed: true });
    expect(traceCalls[2]?.[6]?.metadata).toEqual({
      upstreamInvoked: true,
      errorType: "Error",
    });
  });

  it("records policy exceptions and a terminal projection internal error", async () => {
    const config = {
      ...makeMinimalConfig(),
      compressor: { enabled: true, level: "light" as const },
      tools: { allow: ["fixture_*"], deny: [] },
    };
    const pipeline = makeMockPipeline();
    pipeline.executeWithTrail.mockRejectedValue(new TypeError("Policy failed"));
    const audit = makeMockAudit();
    audit.newTrace.mockReturnValueOnce("t_find").mockReturnValueOnce("t_policy_error");
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "fixture_marker",
        description: "Fixture marker",
        inputSchema: { type: "object" as const },
      },
    ]);
    serverManager.resolveTool.mockReturnValue({
      serverName: "fixture",
      originalToolName: "marker",
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const found = await callHandler({
      method: "tools/call",
      params: { name: FIND_TOOL, arguments: { query: "fixture marker" } },
    });
    const foundText = found.content[0];
    if (!foundText || foundText.type !== "text") throw new Error("Expected find_tool JSON");
    const match = JSON.parse(foundText.text).matches[0] as { tool_ref: string };

    await expect(
      callHandler({
        method: "tools/call",
        params: {
          name: CALL_TOOL,
          arguments: { tool_ref: match.tool_ref, arguments: { value: "policy-error" } },
        },
      }),
    ).rejects.toThrow("Policy failed");

    expect(serverManager.callTool).not.toHaveBeenCalled();
    const traceCalls = audit.log.mock.calls.filter((call) => call[6]?.traceId === "t_policy_error");
    expect(traceCalls.map((call) => call[6]?.event)).toEqual(["policy", "projection"]);
    expect(traceCalls.map((call) => call[6]?.outcome)).toEqual(["internal_error", "internal_error"]);
    expect(traceCalls[0]?.[6]?.metadata).toEqual({ errorType: "TypeError" });
    expect(traceCalls[1]?.[6]?.metadata).toEqual({
      upstreamInvoked: false,
      errorType: "TypeError",
    });
  });
  // -----------------------------------------------------------------------
  // Regression: reload() refreshes the tool list served by tools/list
  // -----------------------------------------------------------------------
  it("reload() should refresh tools/list to serve the new ServerManager's tools", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.getTools.mockReturnValue([{ name: "old_tool", inputSchema: { type: "object" as const } }]);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const before = await listHandler({});
    expect(before).toEqual({
      tools: [{ name: "old_tool", inputSchema: { type: "object" } }],
    });

    // Build a new ServerManager with a different tool list and reload
    const newServerManager = makeMockServerManager();
    newServerManager.getTools.mockReturnValue([
      { name: "new_tool", inputSchema: { type: "object" as const } },
      { name: "another_tool", inputSchema: { type: "object" as const } },
    ]);
    const newPipeline = makeMockPipeline();
    const newAudit = makeMockAudit();

    await proxy.reload(
      { ...config, tools: { allow: ["new_*"], deny: [] } },
      newPipeline as never,
      newAudit as never,
      newServerManager as never,
    );

    // tools/list must now reflect the NEW manager's tools, not the stale cache
    const after = await listHandler({});
    expect(after).toEqual({
      tools: [{ name: "new_tool", inputSchema: { type: "object" } }],
    });
    // The new manager's getTools should have been consulted after reload
    expect(newServerManager.getTools).toHaveBeenCalled();
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(audit.close).toHaveBeenCalledTimes(1);
    expect(mockServerInstances[0].sendToolListChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the active runtime unchanged when reload preparation fails", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([{ name: "old_tool", inputSchema: { type: "object" as const } }]);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;

    const candidateManager = makeMockServerManager();
    candidateManager.getTools.mockImplementation(() => {
      throw new TypeError("candidate catalog failed");
    });
    const candidateAudit = makeMockAudit();

    await expect(
      proxy.reload(config, makeMockPipeline() as never, candidateAudit as never, candidateManager as never),
    ).rejects.toThrow("candidate catalog failed");

    expect(await listHandler({})).toEqual({
      tools: [{ name: "old_tool", inputSchema: { type: "object" } }],
    });
    expect(audit.close).not.toHaveBeenCalled();
    expect(candidateAudit.log).not.toHaveBeenCalled();
    expect(mockServerInstances[0].sendToolListChanged).not.toHaveBeenCalled();
  });

  it("waits for an in-flight tool call before swapping runtime state", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([{ name: "old_tool", inputSchema: { type: "object" as const } }]);
    serverManager.resolveTool.mockReturnValue({ serverName: "old", originalToolName: "tool" });
    let finishUpstream!: (value: { content: Array<{ type: "text"; text: string }> }) => void;
    serverManager.callTool.mockReturnValue(
      new Promise((resolve) => {
        finishUpstream = resolve;
      }),
    );

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const inFlightCall = callHandler({
      params: { name: "old_tool", arguments: { value: "held" } },
    });
    await vi.waitFor(() => expect(serverManager.callTool).toHaveBeenCalledTimes(1));

    const candidateManager = makeMockServerManager();
    candidateManager.getTools.mockReturnValue([{ name: "new_tool", inputSchema: { type: "object" as const } }]);
    const candidateAudit = makeMockAudit();
    const reload = proxy.reload(
      config,
      makeMockPipeline() as never,
      candidateAudit as never,
      candidateManager as never,
    );
    await Promise.resolve();

    expect(await listHandler({})).toEqual({
      tools: [{ name: "old_tool", inputSchema: { type: "object" } }],
    });
    expect(audit.close).not.toHaveBeenCalled();

    finishUpstream({ content: [{ type: "text", text: "finished" }] });
    await inFlightCall;
    await reload;

    expect(await listHandler({})).toEqual({
      tools: [{ name: "new_tool", inputSchema: { type: "object" } }],
    });
    expect(audit.close).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight tool call before closing upstreams", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.resolveTool.mockReturnValue({ serverName: "fixture", originalToolName: "slow" });
    let finishUpstream!: (value: { content: Array<{ type: "text"; text: string }> }) => void;
    serverManager.callTool.mockReturnValue(
      new Promise((resolve) => {
        finishUpstream = resolve;
      }),
    );

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const inFlightCall = callHandler({
      params: { name: "fixture_slow", arguments: {} },
    });
    await vi.waitFor(() => expect(serverManager.callTool).toHaveBeenCalledTimes(1));
    const stopping = proxy.stop();
    await Promise.resolve();

    expect(mockServerInstances[0].close).not.toHaveBeenCalled();
    expect(serverManager.stop).not.toHaveBeenCalled();

    finishUpstream({ content: [{ type: "text", text: "finished" }] });
    await inFlightCall;
    await stopping;

    expect(mockServerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
  });

  it("makes stop atomic against concurrent reload and shares one stop completion", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const candidateManager = makeMockServerManager();
    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const stopping = proxy.stop();
    expect(proxy.stop()).toBe(stopping);
    await expect(
      proxy.reload(config, makeMockPipeline() as never, makeMockAudit() as never, candidateManager as never),
    ).rejects.toThrow("Cannot reload while runtime is stopping");
    await stopping;

    expect(mockServerInstances[0].close).toHaveBeenCalledTimes(1);
    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(candidateManager.stop).not.toHaveBeenCalled();
  });

  it("lets an active reload finish before stop closes the replacement generation", async () => {
    const config = makeMinimalConfig();
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([{ name: "old_tool", inputSchema: { type: "object" as const } }]);
    serverManager.resolveTool.mockReturnValue({ serverName: "old", originalToolName: "tool" });
    let finishUpstream!: (value: { content: Array<{ type: "text"; text: string }> }) => void;
    serverManager.callTool.mockReturnValue(
      new Promise((resolve) => {
        finishUpstream = resolve;
      }),
    );
    const candidateManager = makeMockServerManager();
    candidateManager.getTools.mockReturnValue([{ name: "new_tool", inputSchema: { type: "object" as const } }]);
    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const inFlightCall = callHandler({ params: { name: "old_tool", arguments: {} } });
    await vi.waitFor(() => expect(serverManager.callTool).toHaveBeenCalledTimes(1));

    const reloading = proxy.reload(
      config,
      makeMockPipeline() as never,
      makeMockAudit() as never,
      candidateManager as never,
    );
    const stopping = proxy.stop();
    expect(serverManager.stop).not.toHaveBeenCalled();
    expect(candidateManager.stop).not.toHaveBeenCalled();

    finishUpstream({ content: [{ type: "text", text: "finished" }] });
    await inFlightCall;
    await reloading;
    await stopping;

    expect(serverManager.stop).toHaveBeenCalledTimes(1);
    expect(candidateManager.stop).toHaveBeenCalledTimes(1);
    expect(mockServerInstances[0].close).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Cache: hit returns cached result without calling upstream
  // -----------------------------------------------------------------------
  it("should return cached result on cache hit, skipping upstream call", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: true,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });

    const upstreamResult = {
      content: [{ type: "text" as const, text: "fresh from upstream" }],
    };
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    // First call: cache miss, calls upstream
    const result1 = await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    });
    expect(result1).toBe(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);

    // Second call with same args: cache hit, no upstream call
    const result2 = await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    });
    expect(result2).toEqual(upstreamResult);
    // callTool should still be 1 (not called again)
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Cache: non-cacheable tools bypass cache
  // -----------------------------------------------------------------------
  it("should not cache results for non-cacheable tools", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: true,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    // "create_repo" is not cacheable (match pattern excludes it)
    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "create_repo",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text" as const, text: "created" }],
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await callHandler!({
      method: "tools/call",
      params: { name: "github_create_repo", arguments: { name: "x" } },
    });
    await callHandler!({
      method: "tools/call",
      params: { name: "github_create_repo", arguments: { name: "x" } },
    });

    // Both calls should go to upstream (not cached)
    expect(serverManager.callTool).toHaveBeenCalledTimes(2);
  });

  // -----------------------------------------------------------------------
  // Cache: disabled config bypasses cache entirely
  // -----------------------------------------------------------------------
  it("should skip cache when disabled", async () => {
    const config = {
      ...makeMinimalConfig(),
      cache: {
        enabled: false,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
    };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();

    serverManager.resolveTool.mockReturnValue({
      serverName: "github",
      originalToolName: "search",
    });
    pipeline.executeWithTrail.mockResolvedValue({ result: { allowed: true }, trail: [] });
    serverManager.callTool.mockResolvedValue({
      content: [{ type: "text" as const, text: "result" }],
    });

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never);
    await proxy.start({} as never);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "a" } },
    });
    await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "a" } },
    });

    expect(serverManager.callTool).toHaveBeenCalledTimes(2);
  });

  it("native surface advertises authorized original Tools plus recovery and reuses one upstream call", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["fixture_*"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const structuredTool = {
      name: "structured",
      title: "Structured result",
      description: "Returns structured data",
      inputSchema: { type: "object" as const, properties: {} },
      outputSchema: { type: "object" as const, properties: { count: { type: "number" } } },
      annotations: { readOnlyHint: true },
      _meta: { provider: "fixture" },
      "x-native-fixture": { preserve: true },
    };
    const nativeRoutes = [
      {
        catalogName: "fixture_search",
        serverName: "fixture",
        originalToolName: "search",
        tool: { name: "search", inputSchema: { type: "object" as const, properties: {} } },
      },
      {
        catalogName: "fixture_structured",
        serverName: "fixture",
        originalToolName: "structured",
        tool: structuredTool,
      },
    ];
    serverManager.getTools.mockReturnValue(nativeRoutes.map((route) => ({ ...route.tool, name: route.catalogName })));
    serverManager.getNativeTools.mockReturnValue(nativeRoutes);
    const largeText = `${"native result line\n".repeat(1_000)}tail`;
    serverManager.callTool.mockImplementation(async (_server: string, toolName: string) =>
      toolName === "search"
        ? { content: [{ type: "text" as const, text: largeText }] }
        : {
            content: [{ type: "text" as const, text: "structured" }],
            structuredContent: { count: 1 },
            _meta: { provider: "fixture" },
            "x-result-fixture": true,
          },
    );

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);

    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const listed = await listHandler({});
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(["search", "structured", READ_RESULT]);
    expect(listed.tools[1]).toEqual(structuredTool);

    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    const forwardedArgs = { query: "mcp" };
    const projected = await callHandler({
      method: "tools/call",
      params: { name: "search", arguments: forwardedArgs },
    });
    expect(projected.structuredContent?.result_ref).toMatch(/^result_[a-f0-9]{32}$/);
    expect(serverManager.callTool).toHaveBeenCalledWith("fixture", "search", forwardedArgs);
    expect(serverManager.callTool.mock.calls[0]?.[2]).toBe(forwardedArgs);

    const resultRef = projected.structuredContent.result_ref as string;
    const recovered = await callHandler({
      method: "tools/call",
      params: { name: READ_RESULT, arguments: { result_ref: resultRef } },
    });
    expect(recovered.content[0]).toEqual({ type: "text", text: largeText.slice(0, recovered.content[0].text.length) });
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);

    const structured = await callHandler({
      method: "tools/call",
      params: { name: "structured", arguments: {} },
    });
    expect(structured).toEqual({
      content: [{ type: "text", text: "structured" }],
      structuredContent: { count: 1 },
      _meta: { provider: "fixture" },
      "x-result-fixture": true,
    });
  });

  it("returns the exact upstream result and discards its capsule when the delivery audit sink fails", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["fixture_search"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    audit.log.mockImplementation(
      (...args: unknown[]) => (args[6] as { event?: string } | undefined)?.event !== "projection",
    );
    const serverManager = makeMockServerManager();
    const route = {
      catalogName: "fixture_search",
      serverName: "fixture",
      originalToolName: "search",
      tool: { name: "search", inputSchema: { type: "object" as const, properties: {} } },
    };
    serverManager.getTools.mockReturnValue([{ ...route.tool, name: route.catalogName }]);
    serverManager.getNativeTools.mockReturnValue([route]);
    const upstreamResult = {
      content: [{ type: "text" as const, text: `${"audit failure result\n".repeat(1_000)}tail` }],
    };
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callHandler({
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });

    expect(result).toBe(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);
    expect(
      (
        proxy as unknown as {
          results: { clear(): number };
        }
      ).results.clear(),
    ).toBe(0);
  });

  it("restores an evicted capsule when a native delivery audit fails", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["fixture_search"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    let projectionAudits = 0;
    audit.log.mockImplementation((...args: unknown[]) => {
      const event = (args[6] as { event?: string } | undefined)?.event;
      if (event !== "projection") return true;
      projectionAudits += 1;
      return projectionAudits !== 65;
    });
    const serverManager = makeMockServerManager();
    const route = {
      catalogName: "fixture_search",
      serverName: "fixture",
      originalToolName: "search",
      tool: { name: "search", inputSchema: { type: "object" as const, properties: {} } },
    };
    serverManager.getTools.mockReturnValue([{ ...route.tool, name: route.catalogName }]);
    serverManager.getNativeTools.mockReturnValue([route]);
    let upstreamCalls = 0;
    const upstreamResults = Array.from({ length: 65 }, (_, index) => ({
      content: [{ type: "text" as const, text: `${index}:${"x".repeat(20_000)}` }],
    }));
    serverManager.callTool.mockImplementation(async () => upstreamResults[upstreamCalls++]!);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;
    let firstResultRef = "";
    let failedDelivery: unknown;
    for (let index = 0; index < 65; index++) {
      const result = await callHandler({
        params: { name: "search", arguments: {} },
      });
      if (index === 0) {
        firstResultRef = (result.structuredContent as { result_ref: string }).result_ref;
      }
      if (index === 64) failedDelivery = result;
    }

    expect(failedDelivery).toBe(upstreamResults[64]);
    const recovered = await callHandler({
      params: { name: READ_RESULT, arguments: { result_ref: firstResultRef } },
    });
    expect(recovered.isError).not.toBe(true);
    expect(serverManager.callTool).toHaveBeenCalledTimes(65);
  });

  it("returns the exact upstream result without projection when the policy audit sink fails", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["fixture_search"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    audit.log.mockImplementation(
      (...args: unknown[]) => (args[6] as { event?: string } | undefined)?.event !== "policy",
    );
    const serverManager = makeMockServerManager();
    const route = {
      catalogName: "fixture_search",
      serverName: "fixture",
      originalToolName: "search",
      tool: { name: "search", inputSchema: { type: "object" as const, properties: {} } },
    };
    serverManager.getTools.mockReturnValue([{ ...route.tool, name: route.catalogName }]);
    serverManager.getNativeTools.mockReturnValue([route]);
    const upstreamResult = {
      content: [{ type: "text" as const, text: `${"policy audit failure\n".repeat(1_000)}tail` }],
    };
    serverManager.callTool.mockResolvedValue(upstreamResult);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    const result = await callHandler({
      method: "tools/call",
      params: { name: "search", arguments: {} },
    });

    expect(result).toBe(upstreamResult);
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);
    expect(audit.log.mock.calls.some((call) => call[6]?.event === "projection")).toBe(false);
    expect(
      (
        proxy as unknown as {
          results: { clear(): number };
        }
      ).results.clear(),
    ).toBe(0);
  });

  it("native surface rejects an unauthorized or undiscovered direct name before upstream execution", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["fixture_search"], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const route = {
      catalogName: "fixture_search",
      serverName: "fixture",
      originalToolName: "search",
      tool: { name: "search", inputSchema: { type: "object" as const, properties: {} } },
    };
    serverManager.getTools.mockReturnValue([{ ...route.tool, name: route.catalogName }]);
    serverManager.getNativeTools.mockReturnValue([route]);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    const rejected = await callHandler({
      method: "tools/call",
      params: { name: "not_advertised", arguments: {} },
    });
    expect(rejected).toMatchObject({ isError: true });
    expect(serverManager.callTool).not.toHaveBeenCalled();
    expect(pipeline.executeWithTrail).not.toHaveBeenCalled();
  });

  it("native surface is fail-closed when the allow list is empty", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: [], deny: [] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    serverManager.getTools.mockReturnValue([
      {
        name: "fixture_write",
        description: "must stay hidden",
        inputSchema: { type: "object" },
      },
    ]);
    serverManager.getNativeTools.mockReturnValue([
      {
        catalogName: "fixture_write",
        serverName: "fixture",
        originalToolName: "write",
        tool: { name: "write", inputSchema: { type: "object" } },
      },
    ]);

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    const listed = await listHandler({});
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual([READ_RESULT]);
    await expect(
      callHandler({
        params: { name: "write", arguments: { value: "must-not-run" } },
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(serverManager.callTool).not.toHaveBeenCalled();
  });

  it("keeps a legacy deny effective when a collision receives canonical route names", async () => {
    const config = { ...makeMinimalConfig(), tools: { allow: ["*"], deny: ["a_b_c"] } };
    const pipeline = makeMockPipeline();
    const audit = makeMockAudit();
    const serverManager = makeMockServerManager();
    const catalogName = "a_b_c__sg_12345678";
    serverManager.getTools.mockReturnValue([
      {
        name: catalogName,
        description: "must stay denied",
        inputSchema: { type: "object" },
      },
    ]);
    serverManager.getNativeTools.mockReturnValue([
      {
        catalogName,
        serverName: "a",
        originalToolName: "b_c",
        tool: { name: "b_c", inputSchema: { type: "object" } },
      },
    ]);
    serverManager.getLegacyCatalogNames.mockImplementation((name: string) => (name === catalogName ? ["a_b_c"] : []));

    const proxy = new GuardProxy(config, pipeline as never, audit as never, serverManager as never, {
      surface: "native",
    });
    await proxy.start({} as never);
    const listHandler = mockServerHandlers.get(LIST_TOOLS_SCHEMA)!;
    const callHandler = mockServerHandlers.get(CALL_TOOL_SCHEMA)!;

    expect((await listHandler({})).tools.map((tool: { name: string }) => tool.name)).toEqual([READ_RESULT]);
    await expect(callHandler({ params: { name: "b_c", arguments: {} } })).resolves.toMatchObject({
      isError: true,
    });
    expect(serverManager.callTool).not.toHaveBeenCalled();
  });
});
