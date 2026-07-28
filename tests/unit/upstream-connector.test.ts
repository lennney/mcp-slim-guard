import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  interface ClientPlan {
    connectError?: Error;
    listToolsError?: Error;
    tools?: Array<Record<string, unknown>>;
    callResult?: Record<string, unknown>;
  }

  const state = {
    plans: [] as ClientPlan[],
    clients: [] as Array<{
      connect: ReturnType<typeof vi.fn>;
      listTools: ReturnType<typeof vi.fn>;
      request: ReturnType<typeof vi.fn>;
      callTool: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
    }>,
    transports: [] as Array<{
      kind: "stdio" | "streamable-http" | "sse";
      url?: URL;
      options: Record<string, unknown>;
    }>,
  };

  return state;
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(() => {
    const plan = sdk.plans[sdk.clients.length] ?? {};
    const client = {
      connect: plan.connectError ? vi.fn().mockRejectedValue(plan.connectError) : vi.fn().mockResolvedValue(undefined),
      listTools: plan.listToolsError
        ? vi.fn().mockRejectedValue(plan.listToolsError)
        : vi.fn().mockResolvedValue({ tools: plan.tools ?? [] }),
      request: plan.listToolsError
        ? vi.fn().mockRejectedValue(plan.listToolsError)
        : vi
            .fn()
            .mockImplementation(
              (
                _request: unknown,
                schema: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } },
              ) => {
                const parsed = schema.safeParse({ tools: plan.tools ?? [] });
                if (!parsed.success) throw parsed.error;
                return Promise.resolve(parsed.data);
              },
            ),
      callTool: vi
        .fn()
        .mockImplementation(
          (
            _request: unknown,
            schema?: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } },
          ) => {
            const raw = plan.callResult ?? {
              content: [{ type: "text", text: "ok" }],
            };
            if (!schema) return Promise.resolve(raw);
            const parsed = schema.safeParse(raw);
            if (!parsed.success) throw parsed.error;
            return Promise.resolve(parsed.data);
          },
        ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    sdk.clients.push(client);
    return client;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn((options: Record<string, unknown>) => {
    const transport = { kind: "stdio" as const, options };
    sdk.transports.push(transport);
    return transport;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn((url: URL, options: Record<string, unknown>) => {
    const transport = { kind: "streamable-http" as const, url, options };
    sdk.transports.push(transport);
    return transport;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn((url: URL, options: Record<string, unknown>) => {
    const transport = { kind: "sse" as const, url, options };
    sdk.transports.push(transport);
    return transport;
  }),
}));

import { McpSdkUpstreamConnector } from "../../src/upstream-connector.js";

describe("McpSdkUpstreamConnector", () => {
  beforeEach(() => {
    sdk.plans = [];
    sdk.clients = [];
    sdk.transports = [];
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.SLIM_GUARD_TEST_RUNTIME;
    delete process.env.SLIM_GUARD_TEST_MODE;
    vi.restoreAllMocks();
  });

  it("connects stdio entries and exposes one connected session", async () => {
    process.env.SLIM_GUARD_TEST_RUNTIME = "node";
    sdk.plans = [
      {
        tools: [
          {
            name: "echo",
            title: "Echo",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            annotations: {
              readOnlyHint: true,
              "x-annotation-extension": { preserve: "tool-annotation" },
            },
            "x-test-extension": { preserved: true },
          },
        ],
        callResult: {
          content: [
            {
              type: "text",
              text: "complete",
              annotations: {
                audience: ["assistant"],
                priority: 0.7,
                "x-annotation-extension": { preserve: "content-annotation" },
              },
              "x-block-extension": { preserve: true },
            },
            {
              type: "resource",
              resource: {
                uri: "file:///fixture.txt",
                mimeType: "text/plain",
                text: "fixture",
                "x-resource-extension": { preserve: "nested-resource" },
              },
              "x-block-extension": { preserve: "resource-block" },
            },
          ],
          structuredContent: { ok: true },
          _meta: { traceId: "trace-1" },
          "x-result-extension": { preserve: true },
        },
      },
    ];
    const connector = new McpSdkUpstreamConnector();

    const session = await connector.connect("local", {
      command: "${SLIM_GUARD_TEST_RUNTIME}",
      args: ["server.js"],
      env: { MODE: "test" },
      cwd: "fixtures",
    });

    expect(session.transportKind).toBe("stdio");
    expect(session.tools.map((entry) => entry.name)).toEqual(["echo"]);
    expect(session.tools[0]).toMatchObject({
      title: "Echo",
      outputSchema: { type: "object" },
      annotations: {
        readOnlyHint: true,
        "x-annotation-extension": { preserve: "tool-annotation" },
      },
      "x-test-extension": { preserved: true },
    });
    expect(sdk.clients[0].request).toHaveBeenCalledWith({ method: "tools/list", params: {} }, expect.anything());
    expect(sdk.transports).toEqual([
      {
        kind: "stdio",
        options: {
          command: "node",
          args: ["server.js"],
          env: { MODE: "test" },
          cwd: "fixtures",
        },
      },
    ]);

    await expect(session.callTool("echo", { message: "hello" })).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "complete",
          annotations: {
            audience: ["assistant"],
            priority: 0.7,
            "x-annotation-extension": { preserve: "content-annotation" },
          },
          "x-block-extension": { preserve: true },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///fixture.txt",
            mimeType: "text/plain",
            text: "fixture",
            "x-resource-extension": { preserve: "nested-resource" },
          },
          "x-block-extension": { preserve: "resource-block" },
        },
      ],
      structuredContent: { ok: true },
      _meta: { traceId: "trace-1" },
      "x-result-extension": { preserve: true },
    });
    expect(sdk.clients[0].callTool).toHaveBeenCalledWith(
      {
        name: "echo",
        arguments: { message: "hello" },
      },
      expect.anything(),
    );

    await session.callTool("echo");
    expect(sdk.clients[0].callTool).toHaveBeenNthCalledWith(2, { name: "echo" }, expect.anything());

    await session.close();
    expect(sdk.clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("uses Streamable HTTP first for a URL entry", async () => {
    process.env.SLIM_GUARD_TEST_MODE = "compat";
    sdk.plans = [{ tools: [{ name: "search", inputSchema: { type: "object" } }] }];
    const connector = new McpSdkUpstreamConnector();

    const session = await connector.connect("remote", {
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: { "X-Mode": "${SLIM_GUARD_TEST_MODE}" },
    });

    expect(session.transportKind).toBe("streamable-http");
    expect(sdk.transports).toEqual([
      {
        kind: "streamable-http",
        url: new URL("https://mcp.example.test/mcp"),
        options: {
          requestInit: {
            headers: { "X-Mode": "compat" },
          },
        },
      },
    ]);
  });

  it("falls back once to legacy SSE when Streamable HTTP initialization fails", async () => {
    sdk.plans = [
      { connectError: new Error("HTTP 404") },
      { tools: [{ name: "legacy", inputSchema: { type: "object" } }] },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = new McpSdkUpstreamConnector();

    const session = await connector.connect("legacy", {
      url: "https://mcp.example.test/sse",
    });

    expect(session.transportKind).toBe("sse");
    expect(sdk.transports.map((entry) => entry.kind)).toEqual(["streamable-http", "sse"]);
    expect(sdk.clients[0].close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not change transports when discovery fails after initialization", async () => {
    sdk.plans = [{ listToolsError: new Error("tools/list failed") }];
    const connector = new McpSdkUpstreamConnector();

    await expect(
      connector.connect("remote", {
        url: "https://mcp.example.test/mcp",
      }),
    ).rejects.toThrow("tools/list failed");

    expect(sdk.transports.map((entry) => entry.kind)).toEqual(["streamable-http"]);
    expect(sdk.clients[0].close).toHaveBeenCalledTimes(1);
  });

  it("uses SSE directly only for an explicitly legacy entry", async () => {
    sdk.plans = [{ tools: [] }];
    const connector = new McpSdkUpstreamConnector();

    const session = await connector.connect("legacy", {
      type: "sse",
      url: "https://mcp.example.test/sse",
    });

    expect(session.transportKind).toBe("sse");
    expect(sdk.transports.map((entry) => entry.kind)).toEqual(["sse"]);
  });

  it("reports both remote transport failures without hiding the cause", async () => {
    sdk.plans = [{ connectError: new Error("modern failed") }, { connectError: new Error("legacy failed") }];
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const connector = new McpSdkUpstreamConnector();

    await expect(
      connector.connect("offline", {
        url: "https://mcp.example.test/mcp",
      }),
    ).rejects.toMatchObject({
      name: "AggregateError",
      message: 'Failed to connect upstream "offline" using Streamable HTTP or legacy SSE',
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(sdk.clients.every((client) => client.close.mock.calls.length === 1)).toBe(true);
  });
});
