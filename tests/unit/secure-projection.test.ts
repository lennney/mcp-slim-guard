import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  type ResultDeliveryStore,
  SecureProjectionKernel,
  usesSecureProjection,
} from "../../src/secure-projection.js";

const tools: Tool[] = [
  {
    name: "github_search_repositories",
    title: "Search repositories",
    description: "Search GitHub repositories by query",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    },
    annotations: { readOnlyHint: true },
    _meta: { provider: "github" },
    "x-slim-guard-fixture": { preserve: true },
    tool_ref: "untrusted-upstream-value",
  } as Tool,
  {
    name: "files_read_document",
    description: "读取本地文档内容",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
  {
    name: "calendar_list_events",
    description: "List calendar events",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "agent_search_free_search_advanced",
    title: "Advanced web search",
    description: "Search the web with quality controls and optional filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        language: { type: "string", description: "Preferred result language" },
        include_domains: {
          type: "array",
          description: "Only return results from these web domains",
          items: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
];

function parseText(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

function textChunk(result: CallToolResult): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text result");
  return content.text;
}

describe("SecureProjectionKernel", () => {
  it("exposes exactly the three product tools", () => {
    const kernel = new SecureProjectionKernel(tools);
    expect(kernel.listTools().map((tool) => tool.name)).toEqual([FIND_TOOL, CALL_TOOL, READ_RESULT]);
  });

  it("does not preload the catalog into the fixed three-tool surface", () => {
    const kernel = new SecureProjectionKernel(tools);
    const findTool = kernel.listTools().find((tool) => tool.name === FIND_TOOL);

    expect(findTool?.description).not.toContain("agent_search_free_search_advanced");
    expect(findTool?.description).not.toContain("Advanced web search");
  });

  it("keeps the zero-match catalog preview within its fixed internal budget", async () => {
    const largeCatalog = Array.from({ length: 100 }, (_, index): Tool => ({
      name: `namespace_${index}_tool_with_a_long_descriptive_name`,
      title: `Tool ${index} ${"summary ".repeat(30)}`,
      description: "The longer description must not expand the public three-tool surface without a bound.",
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 8 }, (__, propertyIndex) => [
            `parameter_${propertyIndex}_with_a_long_name`,
            { type: "string" },
          ]),
        ),
      },
    }));
    const kernel = new SecureProjectionKernel(largeCatalog);
    const result = await kernel.call(FIND_TOOL, { query: "no matching capability" }, vi.fn());
    const body = parseText(result);
    const preview = String(body.catalog_preview);
    const weightedChars = Array.from(preview).reduce(
      (total, character) => total + (character.codePointAt(0)! <= 0x7f ? 1 : 2),
      0,
    );

    expect(weightedChars).toBeLessThanOrEqual(1_600);
    expect(preview).toContain("more authorized tools");
    expect(preview).toContain("remaining namespaces");
  });

  it("finds at most three matches and preserves complete MCP tool metadata", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const result = await kernel.call(FIND_TOOL, { query: "github" }, vi.fn());
    const body = parseText(result);
    const matches = body.matches as Array<Record<string, unknown>>;

    expect(matches).toHaveLength(2);
    expect(matches[0]).toHaveProperty("tool_ref");
    expect(matches.map((match) => match.name)).toEqual(["github_search_repositories", "github_create_issue"]);
    expect(matches.find((match) => match.name === "github_search_repositories")?.input_schema).toEqual(
      tools[0].inputSchema,
    );
    expect(matches[0]).toMatchObject({
      title: "Search repositories",
      outputSchema: (tools[0] as Tool & Record<string, unknown>).outputSchema,
      annotations: { readOnlyHint: true },
      _meta: { provider: "github" },
      "x-slim-guard-fixture": { preserve: true },
    });
    expect(matches[0]).not.toHaveProperty("inputSchema");
    expect(matches[0].tool_ref).not.toBe("untrusted-upstream-value");
    expect(matches[0].tool_ref).toMatch(/^tool_[a-f0-9]{16}_\d+$/);
  });

  it("searches Unicode descriptions without a model dependency", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const result = await kernel.call(FIND_TOOL, { query: "读取文档" }, vi.fn());
    const body = parseText(result);
    const matches = body.matches as Array<Record<string, unknown>>;

    expect(matches[0]?.name).toBe("files_read_document");
  });

  it("uses titles and parameter descriptions to rank natural-language intent", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const result = await kernel.call(
      FIND_TOOL,
      { query: "高级网页搜索 advanced filters result language web domains" },
      vi.fn(),
    );
    const body = parseText(result);
    const matches = body.matches as Array<Record<string, unknown>>;

    expect(matches[0]?.name).toBe("agent_search_free_search_advanced");
  });

  it("does not return weak shared-field matches beside a strong intent match", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const result = await kernel.call(FIND_TOOL, { query: "advanced web search domains language" }, vi.fn());
    const body = parseText(result);
    const matches = body.matches as Array<Record<string, unknown>>;

    expect(matches.map((match) => match.name)).toEqual(["agent_search_free_search_advanced"]);
  });

  it("returns the compact catalog preview instead of guessing when no tool matches", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const result = await kernel.call(FIND_TOOL, { query: "完全未知的能力" }, vi.fn());
    const body = parseText(result);

    expect(body.matches).toEqual([]);
    expect(body.catalog_preview).toContain("agent_search_free_search_advanced");
    expect(body.retry_hint).toContain("catalog terms");
    expect(body.retry_hint).toContain("untrusted discovery data");
  });

  it("recovers an English-only catalog from a Chinese discovery miss without guessing", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const first = parseText(await kernel.call(FIND_TOOL, { query: "高级网页搜索" }, vi.fn()));

    expect(first.matches).toEqual([]);
    expect(first.catalog_preview).toContain("agent_search_free_search_advanced");
    expect(first.catalog_preview).toContain("Advanced web search");

    const retry = parseText(await kernel.call(FIND_TOOL, { query: "advanced web search" }, vi.fn()));
    const matches = retry.matches as Array<Record<string, unknown>>;
    expect(matches[0]?.name).toBe("agent_search_free_search_advanced");
  });

  it("invokes only a reference issued by the current catalog", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search repositories" }, vi.fn()));
    const match = (find.matches as Array<Record<string, unknown>>)[0];
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { count: 1 },
      _meta: { traceId: "trace-1" },
    });

    const result = await kernel.call(CALL_TOOL, { tool_ref: match.tool_ref, arguments: { query: "mcp" } }, invoke);

    expect(invoke).toHaveBeenCalledWith("github_search_repositories", { query: "mcp" });
    expect(result).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { count: 1 },
      _meta: { traceId: "trace-1" },
    });

    const rejected = await kernel.call(CALL_TOOL, { tool_ref: "github_search_repositories", arguments: {} }, invoke);
    expect(rejected.isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns the exact upstream result when result delivery fails without changing arguments or retrying", async () => {
    const delivery: ResultDeliveryStore = {
      capture: vi.fn(() => {
        throw new Error("projection unavailable");
      }),
      read: vi.fn(() => ({ content: [{ type: "text", text: "unused" }] })),
      clear: vi.fn(),
    };
    const kernel = new SecureProjectionKernel(tools, delivery);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search repositories" }, vi.fn()));
    const match = (find.matches as Array<Record<string, unknown>>)[0];
    const exactArguments = { query: "mcp", nested: { preserve: true } };
    const upstreamResult: CallToolResult = {
      content: [{ type: "text", text: "upstream-ok" }],
      structuredContent: { marker: "once-only" },
      _meta: { traceId: "trace-1" },
    };
    const invoke = vi.fn().mockResolvedValue(upstreamResult);

    const result = await kernel.call(CALL_TOOL, { tool_ref: match.tool_ref, arguments: exactArguments }, invoke);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.[1]).toBe(exactArguments);
    expect(delivery.capture).toHaveBeenCalledTimes(1);
    expect(delivery.capture).toHaveBeenCalledWith(upstreamResult, expect.any(Function));
    expect(result).toBe(upstreamResult);
  });

  it("reports upstream errors as allowed upstream outcomes rather than projection rejection", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search repositories" }, vi.fn()));
    const match = (find.matches as Array<Record<string, unknown>>)[0];
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "UNSUPPORTED_FILTER" }],
      isError: true,
    });

    const observed = await kernel.callObserved(
      CALL_TOOL,
      { tool_ref: match.tool_ref, arguments: { query: "mcp", time_range: "day" } },
      invoke,
    );

    expect(observed.result.isError).toBe(true);
    expect(observed.report).toMatchObject({
      outcome: "upstream_error",
      upstreamInvoked: true,
      upstreamToolName: "github_search_repositories",
      upstreamIsError: true,
      capsule: {
        phase: "delivery",
        outcome: "pass_through",
        reason: "within_budget",
      },
    });
  });

  it("captures a large result once and retrieves bounded chunks without re-invoking", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search" }, vi.fn()));
    const match = (find.matches as Array<Record<string, unknown>>)[0];
    const largeText = "x".repeat(25_000);
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: largeText }],
      isError: false,
    });

    const callResult = await kernel.call(CALL_TOOL, { tool_ref: match.tool_ref, arguments: { query: "mcp" } }, invoke);
    const capsule = parseText(callResult);
    expect(capsule.result_ref).toMatch(/^result_[a-f0-9]{32}$/);
    expect(callResult.structuredContent).not.toHaveProperty("preview");
    expect(callResult._meta?.["io.github.lennney/slim-guard"]).not.toHaveProperty("preview");

    const chunks: string[] = [];
    let cursor = capsule.replay_cursor as number;
    let finalCursor = cursor;
    for (let page = 0; page < 10; page++) {
      finalCursor = cursor;
      const result = await kernel.call(READ_RESULT, { result_ref: capsule.result_ref, cursor }, invoke);
      const metadata = result.structuredContent as Record<string, unknown>;
      chunks.push(textChunk(result));
      if (metadata.done) break;
      cursor = metadata.next_cursor as number;
    }

    expect({
      content: [{ type: "text", text: largeText }],
      ...((capsule.result_shape as Record<string, unknown> | undefined) ?? {}),
    }).toEqual({
      content: [{ type: "text", text: chunks.join("") }],
      isError: false,
    });
    const retryFinal = await kernel.call(READ_RESULT, { result_ref: capsule.result_ref, cursor: finalCursor }, invoke);
    expect(retryFinal.structuredContent).toHaveProperty("done", true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects an out-of-range cursor without destroying the captured result", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search" }, vi.fn()));
    const match = (find.matches as Array<Record<string, unknown>>)[0];
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "x".repeat(25_000) }],
    });
    const callResult = await kernel.call(CALL_TOOL, { tool_ref: match.tool_ref, arguments: {} }, invoke);
    const capsule = parseText(callResult);

    const rejected = await kernel.call(
      READ_RESULT,
      { result_ref: capsule.result_ref, cursor: Number.MAX_SAFE_INTEGER },
      invoke,
    );
    expect(rejected.isError).toBe(true);

    const first = await kernel.call(READ_RESULT, { result_ref: capsule.result_ref }, invoke);
    expect(first.structuredContent).toHaveProperty("cursor", 0);
    expect(textChunk(first)).not.toBe("");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("invalidates old references when the catalog is replaced", async () => {
    const kernel = new SecureProjectionKernel(tools);
    const find = parseText(await kernel.call(FIND_TOOL, { query: "search" }, vi.fn()));
    const oldRef = (find.matches as Array<Record<string, unknown>>)[0].tool_ref;
    const invoke = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "x".repeat(25_000) }],
    });
    const delivered = parseText(await kernel.call(CALL_TOOL, { tool_ref: oldRef, arguments: {} }, invoke));

    const lifecycle = kernel.replaceCatalog([tools[1]]);
    const result = await kernel.call(CALL_TOOL, { tool_ref: oldRef, arguments: {} }, invoke);
    const recovered = await kernel.call(READ_RESULT, { result_ref: delivered.result_ref }, invoke);

    expect(lifecycle).toEqual({ invalidatedResults: 1 });
    expect(result.isError).toBe(true);
    expect(recovered.isError).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("usesSecureProjection", () => {
  it("selects the one normal product path", () => {
    expect(usesSecureProjection({ enabled: true, level: "light" })).toBe(true);
    expect(usesSecureProjection({ enabled: true, level: "light", lazy_loading: true })).toBe(false);
    expect(usesSecureProjection({ enabled: false, level: "light" })).toBe(false);
    expect(usesSecureProjection({ enabled: true, level: "normal" })).toBe(false);
  });
});
