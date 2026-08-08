import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuardConfig } from "../../src/config-types.js";

const { LIST_TOOLS_SCHEMA, CALL_TOOL_SCHEMA } = vi.hoisted(() => ({
  LIST_TOOLS_SCHEMA: Symbol("ListToolsRequestSchema"),
  CALL_TOOL_SCHEMA: Symbol("CallToolRequestSchema"),
}));

let handlers: Map<
  symbol,
  (request: { params: { name: string; arguments?: Record<string, unknown> } }) => Promise<unknown>
>;

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: vi.fn(() => ({
    setRequestHandler: vi.fn((schema: symbol, handler: (request: never) => Promise<unknown>) =>
      handlers.set(schema, handler),
    ),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    sendToolListChanged: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: LIST_TOOLS_SCHEMA,
  CallToolRequestSchema: CALL_TOOL_SCHEMA,
  ErrorCode: { InvalidParams: -32602 },
  McpError: class McpError extends Error {},
}));

import { GuardProxy } from "../../src/proxy.js";
import { CALL_TOOL, FIND_TOOL, READ_RESULT } from "../../src/secure-projection.js";

function config(overrides: Partial<GuardConfig> = {}): GuardConfig {
  return {
    version: 2,
    tools: { allow: ["mock_*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
    rate_limit: { default: "" },
    injection_detection: { enabled: false },
    audit: { output: "file", filePath: "audit.log" },
    servers: { mock: { command: "node", args: ["server.mjs"] } },
    ...overrides,
  };
}

function dependencies() {
  const tools = [
    {
      name: "mock_search",
      description: "Search repositories.",
      inputSchema: { type: "object" as const, properties: { query: { type: "string" } }, required: ["query"] },
    },
    {
      name: "mock_secret",
      description: "Sensitive operation.",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];
  const manager = {
    start: vi.fn().mockResolvedValue({ configured: 1, connected: [], failed: [] }),
    stop: vi.fn().mockResolvedValue({ closed: [], failed: [] }),
    getTools: vi.fn().mockReturnValue(tools),
    getNativeTools: vi.fn().mockReturnValue(
      tools.map((tool) => ({
        catalogName: tool.name,
        serverName: "mock",
        originalToolName: tool.name.replace("mock_", ""),
        tool,
      })),
    ),
    getLegacyCatalogNames: vi.fn().mockReturnValue([]),
    resolveTool: vi.fn((name: string) => ({ serverName: "mock", originalToolName: name.replace("mock_", "") })),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text" as const, text: "ok" }] }),
  };
  const pipeline = { executeWithTrail: vi.fn().mockResolvedValue({ result: { allowed: true }, trail: [] }) };
  const audit = {
    newSession: vi.fn().mockReturnValue("s_test"),
    newTrace: vi.fn().mockReturnValue("t_test"),
    log: vi.fn(),
    logDiscovery: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { tools, manager, pipeline, audit };
}

async function start(mode: "compact" | "native" | "extreme", guardConfig = config()) {
  const dependency = dependencies();
  const proxy = new GuardProxy(
    guardConfig,
    dependency.pipeline as never,
    dependency.audit as never,
    dependency.manager as never,
    {
      mode,
    },
  );
  await proxy.start({} as never);
  return { ...dependency, proxy };
}

function text(result: unknown): Record<string, unknown> {
  const callResult = result as { content: Array<{ text?: string }> };
  return JSON.parse(callResult.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("GuardProxy public modes", () => {
  beforeEach(() => {
    handlers = new Map();
    vi.clearAllMocks();
  });

  it("uses the fixed Compact catalog, exposes complete matching schemas, and invokes upstream once", async () => {
    const { manager } = await start("compact");
    const list = (await handlers.get(LIST_TOOLS_SCHEMA)!({ params: { name: "" } })) as {
      tools: Array<{ name: string }>;
    };
    expect(list.tools.map((tool) => tool.name)).toEqual([FIND_TOOL, CALL_TOOL, READ_RESULT]);

    const found = text(
      await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: FIND_TOOL, arguments: { query: "search" } } }),
    );
    const match = (found.matches as Array<Record<string, unknown>>)[0];
    expect(match.input_schema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });

    await handlers.get(CALL_TOOL_SCHEMA)!({
      params: { name: CALL_TOOL, arguments: { tool_ref: match.tool_ref, arguments: { query: "guard" } } },
    });
    expect(manager.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid Compact arguments before upstream invocation", async () => {
    const { manager } = await start("compact");
    const found = text(
      await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: FIND_TOOL, arguments: { query: "search" } } }),
    );
    const match = (found.matches as Array<Record<string, unknown>>)[0];

    const result = (await handlers.get(CALL_TOOL_SCHEMA)!({
      params: { name: CALL_TOOL, arguments: { tool_ref: match.tool_ref, arguments: {} } },
    })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        kind: "mcp-slim-guard/argument-validation",
        error: "input_schema_invalid",
        tool: "mock_search",
        upstream_invoked: false,
      },
    });
    expect(result.structuredContent).not.toHaveProperty("attempted_arguments");
    expect(manager.callTool).not.toHaveBeenCalled();
  });

  it("does not reveal or invoke denied tools in every mode", async () => {
    for (const mode of ["compact", "native", "extreme"] as const) {
      handlers = new Map();
      const { manager } = await start(mode, config({ tools: { allow: ["mock_*"], deny: ["mock_secret"] } }));
      const list = (await handlers.get(LIST_TOOLS_SCHEMA)!({ params: { name: "" } })) as {
        tools: Array<{ name: string }>;
      };
      expect(list.tools.some((tool) => tool.name === "mock_secret")).toBe(false);
      if (mode === "native") {
        const result = (await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: "mock_secret", arguments: {} } })) as {
          isError?: boolean;
        };
        expect(result.isError).toBe(true);
      }
      expect(manager.callTool).not.toHaveBeenCalled();
    }
  });

  it("keeps original authorized schemas in Native mode and adds recovery", async () => {
    const { manager } = await start("native");
    const list = (await handlers.get(LIST_TOOLS_SCHEMA)!({ params: { name: "" } })) as {
      tools: Array<{ name: string; inputSchema: unknown }>;
    };
    expect(list.tools.map((tool) => tool.name)).toEqual(["mock_search", "mock_secret", READ_RESULT]);
    expect(list.tools[0]?.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });

    await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: "mock_search", arguments: { query: "guard" } } });
    expect(manager.callTool).toHaveBeenCalledTimes(1);
  });

  it("uses Extreme's recoverable result delivery without changing its three-tool catalog", async () => {
    const { manager } = await start("extreme");
    manager.callTool.mockResolvedValueOnce({ content: [{ type: "text", text: "result ".repeat(3_000) }] });
    const found = text(
      await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: FIND_TOOL, arguments: { query: "search" } } }),
    );
    const match = (found.matches as Array<Record<string, unknown>>)[0];
    const delivered = text(
      await handlers.get(CALL_TOOL_SCHEMA)!({
        params: { name: CALL_TOOL, arguments: { tool_ref: match.tool_ref, arguments: { query: "guard" } } },
      }),
    );
    expect(delivered.result_ref).toBeTypeOf("string");
    expect(manager.callTool).toHaveBeenCalledTimes(1);
    const recovered = await handlers.get(CALL_TOOL_SCHEMA)!({
      params: { name: READ_RESULT, arguments: { result_ref: delivered.result_ref } },
    });
    expect((recovered as { content: Array<{ text?: string }> }).content[0]?.text).toContain("result");
  });

  it("redacts typed selector and fallback values from recovery audit arguments", async () => {
    const { manager, audit } = await start("compact");
    const marker = "PRIVATE-SELECTOR-MARKER";
    const fallback = "PRIVATE-FALLBACK-QUERY";
    manager.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: `${"ordinary context\n".repeat(2_000)}INFO ${marker}\n` }],
    });
    const found = text(
      await handlers.get(CALL_TOOL_SCHEMA)!({ params: { name: FIND_TOOL, arguments: { query: "search" } } }),
    );
    const match = (found.matches as Array<Record<string, unknown>>)[0];
    const delivered = (await handlers.get(CALL_TOOL_SCHEMA)!({
      params: { name: CALL_TOOL, arguments: { tool_ref: match.tool_ref, arguments: { query: "guard" } } },
    })) as { structuredContent?: { result_ref?: string } };
    const resultRef = delivered.structuredContent?.result_ref;
    expect(resultRef).toBeTypeOf("string");

    const recovered = await handlers.get(CALL_TOOL_SCHEMA)({
      params: {
        name: READ_RESULT,
        arguments: {
          result_ref: resultRef,
          selector: { kind: "log_anchor_window", anchor: marker, before: 0, after: 0 },
          fallback_query: fallback,
        },
      },
    });
    expect((recovered as { structuredContent?: { retrieval?: string } }).structuredContent?.retrieval).toBe(
      "structured",
    );
    const recoveryAudits = audit.log.mock.calls.filter((call) => call[0]?.toolName === READ_RESULT);
    expect(recoveryAudits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(recoveryAudits);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain(fallback);
    expect(serialized).not.toContain("PRIVATE");
  });
});
