/**
 * Unit tests for compressor module — getTransformTools() and getCompressedTools().
 */
import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

// We'll import these after implementation
import { getTransformTools, getCompressedTools, whitelistFilter } from "../../src/compressor.js";

// Sample tools matching what mock-server exposes
const sampleTools: Tool[] = [
  {
    name: "mock_echo",
    description: "Echo back the input message",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo" },
      },
      required: ["message"],
    },
  },
  {
    name: "mock_add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "number", description: "First number" },
        b: { type: "number", description: "Second number" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "mock_get_time",
    description: "Get the current server time",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "mock_search",
    description: "Search for items",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        limit: { type: "number", description: "Maximum number of results" },
        offset: { type: "number", description: "Pagination offset" },
      },
      required: ["query"],
    },
  },
];

describe("whitelistFilter", () => {
  const tools: Tool[] = [
    { name: "github_search", description: "search", inputSchema: { type: "object", properties: {} } },
    { name: "github_create", description: "create", inputSchema: { type: "object", properties: {} } },
    { name: "slack_send", description: "send", inputSchema: { type: "object", properties: {} } },
  ];

  it("passes all tools when allow is empty and deny is empty", () => {
    const stage = whitelistFilter([], []);
    expect(stage(tools)).toHaveLength(3);
  });

  it("filters by allow pattern", () => {
    const stage = whitelistFilter(["github_*"], []);
    const result = stage(tools);
    expect(result.map(t => t.name)).toEqual(["github_search", "github_create"]);
  });

  it("filters by deny pattern (deny takes priority)", () => {
    const stage = whitelistFilter(["*"], ["github_create"]);
    const result = stage(tools);
    expect(result.map(t => t.name)).toEqual(["github_search", "slack_send"]);
  });

  it("combines allow + deny patterns", () => {
    const stage = whitelistFilter(["github_*"], ["github_create"]);
    const result = stage(tools);
    expect(result.map(t => t.name)).toEqual(["github_search"]);
  });
});

describe("getTransformTools", () => {
  describe("extreme level", () => {
    it("returns tools with real identities (not wrappers)", () => {
      const result = getTransformTools(sampleTools, "extreme");
      const names = result.map(t => t.name);
      expect(names).toEqual(["mock_echo", "mock_add", "mock_get_time", "mock_search"]);
    });

    it("strips property descriptions from inputSchema", () => {
      const result = getTransformTools(sampleTools, "extreme");
      const searchTool = result.find(t => t.name === "mock_search")!;
      const props = searchTool.inputSchema.properties as Record<string, Record<string, unknown>>;
      // Properties should exist but have no description
      expect(props.query).toBeDefined();
      expect(props.query.description).toBeUndefined();
      expect(props.query.type).toBe("string");
      expect(props.limit).toBeDefined();
      expect(props.limit.description).toBeUndefined();
      expect(props.limit.type).toBe("number");
    });

    it("preserves required array", () => {
      const result = getTransformTools(sampleTools, "extreme");
      const searchTool = result.find(t => t.name === "mock_search")!;
      expect(searchTool.inputSchema.required).toEqual(["query"]);
    });

    it("preserves tool descriptions", () => {
      const result = getTransformTools(sampleTools, "extreme");
      const addTool = result.find(t => t.name === "mock_add")!;
      expect(addTool.description).toBe("Add two numbers");
    });

    it("handles tools with no properties", () => {
      const result = getTransformTools(sampleTools, "extreme");
      const timeTool = result.find(t => t.name === "mock_get_time")!;
      expect(timeTool.inputSchema.properties).toEqual({});
    });
  });

  describe("maximum level", () => {
    it("returns tools with real identities", () => {
      const result = getTransformTools(sampleTools, "maximum");
      const names = result.map(t => t.name);
      expect(names).toEqual(["mock_echo", "mock_add", "mock_get_time", "mock_search"]);
    });

    it("replaces inputSchema with minimal {type:object}", () => {
      const result = getTransformTools(sampleTools, "maximum");
      const addTool = result.find(t => t.name === "mock_add")!;
      expect(addTool.inputSchema).toEqual({ type: "object", properties: {} });
    });

    it("embeds function signature in description", () => {
      const result = getTransformTools(sampleTools, "maximum");
      const searchTool = result.find(t => t.name === "mock_search")!;
      expect(searchTool.description).toContain("mock_search(query: string, limit?: number, offset?: number)");
    });

    it("marks required params without ? in signature", () => {
      const result = getTransformTools(sampleTools, "maximum");
      const echoTool = result.find(t => t.name === "mock_echo")!;
      expect(echoTool.description).toContain("mock_echo(message: string)");
      // message is required, so no "?" after it
      expect(echoTool.description).not.toContain("message?:");
    });

    it("handles tools with no params", () => {
      const result = getTransformTools(sampleTools, "maximum");
      const timeTool = result.find(t => t.name === "mock_get_time")!;
      expect(timeTool.description).toContain("mock_get_time()");
    });
  });
});

describe("getCompressedTools", () => {
  it("light level returns 3 wrapper tools", () => {
    const result = getCompressedTools(sampleTools, { enabled: true, level: "light" });
    const names = result.map(t => t.name);
    expect(names).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("normal level returns 2 wrapper tools", () => {
    const result = getCompressedTools(sampleTools, { enabled: true, level: "normal" });
    const names = result.map(t => t.name);
    expect(names).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("off level returns full tools", () => {
    const result = getCompressedTools(sampleTools, { enabled: true, level: "off" });
    expect(result).toEqual(sampleTools);
  });

  it("disabled returns full tools regardless of level", () => {
    const result = getCompressedTools(sampleTools, { enabled: false, level: "light" });
    expect(result).toEqual(sampleTools);
  });
});
