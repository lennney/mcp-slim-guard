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
      setRequestHandler: vi.fn((schema: symbol, handler: Function) => {
        mockServerHandlers!.set(schema, handler);
      }),
      connect: vi.fn((transport?: { connectError?: Error }) =>
        transport?.connectError ? Promise.reject(transport.connectError) : Promise.resolve(undefined),
      ),
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
import { CALL_TOOL, FIND_TOOL } from "../../src/secure-projection.js";

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
    getTools: vi.fn().mockReturnValue([]),
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

    // Should return the upstream result with resultType
    expect(result).toEqual({ ...upstreamResult, resultType: "complete" });

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
      { toolName: "srv_tool1", arguments: { x: 1 }, serverName: "srv", agentId: "s_test" },
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
        metadata: { upstreamInvoked: true, isError: false, contentBlocks: 1 },
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
      { toolName: "srv_tool1", arguments: { x: 1 }, serverName: "srv", agentId: "s_test" },
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
      resultType: "complete",
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

    // Also verify audit received the same context
    expect(audit.log).toHaveBeenCalledWith(
      {
        toolName: "my_complex_server_my_tool",
        arguments: { repo: "org/project", limit: 10 },
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
    expect(traceCalls[2]?.[0].arguments).toEqual({ tool_ref: match.tool_ref });
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
      tools: [
        { name: "new_tool", inputSchema: { type: "object" } },
        { name: "another_tool", inputSchema: { type: "object" } },
      ],
    });
    // The new manager's getTools should have been consulted after reload
    expect(newServerManager.getTools).toHaveBeenCalled();
    expect(audit.close).toHaveBeenCalledTimes(1);
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
    expect(result1).toEqual({ ...upstreamResult, resultType: "complete" });
    expect(serverManager.callTool).toHaveBeenCalledTimes(1);

    // Second call with same args: cache hit, no upstream call
    const result2 = await callHandler!({
      method: "tools/call",
      params: { name: "github_search", arguments: { q: "mcp" } },
    });
    expect(result2).toEqual({ ...upstreamResult, resultType: "complete" });
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
});
