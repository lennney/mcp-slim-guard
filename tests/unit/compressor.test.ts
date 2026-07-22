/**
 * Unit tests for compressor module — pipeline stages (whitelistFilter, levelToStage,
 * applyLazyBudget, injectGetSchema, generateTools).
 */
import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { whitelistFilter, levelToStage, applyLazyBudget, injectGetSchema, generateTools, buildPipeline } from "../../src/compressor.js";

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

describe("levelToStage (extreme/maximum)", () => {
  describe("extreme level", () => {
    it("returns tools with real identities (not wrappers)", () => {
      const result = levelToStage("extreme", false)(sampleTools);
      const names = result.map(t => t.name);
      expect(names).toEqual(["mock_echo", "mock_add", "mock_get_time", "mock_search"]);
    });

    it("strips property descriptions from inputSchema", () => {
      const result = levelToStage("extreme", false)(sampleTools);
      const searchTool = result.find(t => t.name === "mock_search")!;
      const props = searchTool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.query).toBeDefined();
      expect(props.query.description).toBeUndefined();
      expect(props.query.type).toBe("string");
      expect(props.limit).toBeDefined();
      expect(props.limit.description).toBeUndefined();
      expect(props.limit.type).toBe("number");
    });

    it("preserves required array", () => {
      const result = levelToStage("extreme", false)(sampleTools);
      const searchTool = result.find(t => t.name === "mock_search")!;
      expect(searchTool.inputSchema.required).toEqual(["query"]);
    });

    it("preserves tool descriptions", () => {
      const result = levelToStage("extreme", false)(sampleTools);
      const addTool = result.find(t => t.name === "mock_add")!;
      expect(addTool.description).toBe("Add two numbers");
    });

    it("handles tools with no properties", () => {
      const result = levelToStage("extreme", false)(sampleTools);
      const timeTool = result.find(t => t.name === "mock_get_time")!;
      expect(timeTool.inputSchema.properties).toEqual({});
    });
  });

  describe("maximum level", () => {
    it("returns tools with real identities", () => {
      const result = levelToStage("maximum", false)(sampleTools);
      const names = result.map(t => t.name);
      expect(names).toEqual(["mock_echo", "mock_add", "mock_get_time", "mock_search"]);
    });

    it("replaces inputSchema with minimal {type:object}", () => {
      const result = levelToStage("maximum", false)(sampleTools);
      const addTool = result.find(t => t.name === "mock_add")!;
      expect(addTool.inputSchema).toEqual({ type: "object", properties: {} });
    });

    it("embeds function signature in description", () => {
      const result = levelToStage("maximum", false)(sampleTools);
      const searchTool = result.find(t => t.name === "mock_search")!;
      expect(searchTool.description).toContain("mock_search(query: string, limit?: number, offset?: number)");
    });

    it("marks required params without ? in signature", () => {
      const result = levelToStage("maximum", false)(sampleTools);
      const echoTool = result.find(t => t.name === "mock_echo")!;
      expect(echoTool.description).toContain("mock_echo(message: string)");
      expect(echoTool.description).not.toContain("message?:");
    });

    it("handles tools with no params", () => {
      const result = levelToStage("maximum", false)(sampleTools);
      const timeTool = result.find(t => t.name === "mock_get_time")!;
      expect(timeTool.description).toContain("mock_get_time()");
    });
  });
});

describe("generateTools (wrapper levels via pipeline)", () => {
  it("light level returns 3 wrapper tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "light" });
    const names = result.map(t => t.name);
    expect(names).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("normal level returns 2 wrapper tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "normal" });
    const names = result.map(t => t.name);
    expect(names).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("off level returns full tools", () => {
    const result = generateTools(sampleTools, { enabled: true, level: "off" });
    expect(result).toEqual(sampleTools);
  });

  it("disabled returns full tools regardless of level", () => {
    const result = generateTools(sampleTools, { enabled: false, level: "light" });
    expect(result).toEqual(sampleTools);
  });
});

describe("levelToStage", () => {
  const tools: Tool[] = [
    {
      name: "mock_echo",
      description: "Echo back the input message",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "The message to echo" } },
        required: ["message"],
      },
    },
    {
      name: "mock_get_time",
      description: "Get the current server time",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  it("off level passes tools through unchanged", () => {
    const stage = levelToStage("off", false);
    expect(stage(tools)).toEqual(tools);
  });

  it("light level produces 3 wrapper tools (list + get_tool_schema + invoke)", () => {
    const stage = levelToStage("light", false);
    const result = stage(tools);
    expect(result.map(t => t.name)).toEqual(["mcp__list_tools", "mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("normal level produces 2 wrapper tools (get_tool_schema + invoke)", () => {
    const stage = levelToStage("normal", false);
    const result = stage(tools);
    expect(result.map(t => t.name)).toEqual(["mcp__get_tool_schema", "mcp__invoke_tool"]);
  });

  it("extreme level strips property descriptions but keeps type/required", () => {
    const stage = levelToStage("extreme", false);
    const result = stage(tools);
    const echo = result.find(t => t.name === "mock_echo")!;
    const props = echo.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.message.type).toBe("string");
    expect(props.message.description).toBeUndefined();
    expect(echo.inputSchema.required).toEqual(["message"]);
  });

  it("maximum level embeds signature in description and empties schema", () => {
    const stage = levelToStage("maximum", false);
    const result = stage(tools);
    const echo = result.find(t => t.name === "mock_echo")!;
    expect(echo.description).toContain("mock_echo(message: string)");
    expect(echo.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("lazy+light degrades to passthrough (no wrapper)", () => {
    const stage = levelToStage("light", true);
    expect(stage(tools)).toEqual(tools);
  });

  it("lazy+normal degrades to passthrough", () => {
    const stage = levelToStage("normal", true);
    expect(stage(tools)).toEqual(tools);
  });
});

describe("applyLazyBudget", () => {
  const tools: Tool[] = [
    { name: "github_search", description: "Search repos", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "github_get_user", description: "Get user", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
    { name: "github_create_issue", description: "Create issue", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
    { name: "github_delete_repo", description: "Delete repo", inputSchema: { type: "object", properties: {} } },
  ];
  const originalMap = new Map(tools.map(t => [t.name, t]));

  it("preloads high-priority tools (search/get) with full schema, strips others", () => {
    const stage = applyLazyBudget(8, originalMap);
    const result = stage(tools);
    // github_search and github_get_user match HIGH_PRIORITY pattern
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");

    const create = result.find(t => t.name === "github_create_issue")!;
    // Slim format: name + description only, no inputSchema field
    expect(create.inputSchema).toBeUndefined();
    expect(create.description).toBe("Create issue");
  });

  it("budget=0 strips all schemas (all slim)", () => {
    const stage = applyLazyBudget(0, originalMap);
    const result = stage(tools);
    for (const t of result) {
      expect(t.inputSchema).toBeUndefined();
    }
  });

  it("budget >= tool count keeps all full (all preloaded if high-priority)", () => {
    const stage = applyLazyBudget(100, originalMap);
    const result = stage(tools);
    // search and get_user are high priority → full schema
    // create_issue and delete_repo are NOT high priority → slim even with budget=100
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const del = result.find(t => t.name === "github_delete_repo")!;
    expect(del.inputSchema).toBeUndefined();
  });

  it("mixed: some high-priority, some not", () => {
    const stage = applyLazyBudget(1, originalMap);
    const result = stage(tools);
    // Only first high-priority tool gets full schema (budget=1)
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const getUser = result.find(t => t.name === "github_get_user")!;
    expect(getUser.inputSchema).toBeUndefined();
  });

  it("restores full schema from originalTools (not from level-compressed tools)", () => {
    // Simulate: levelToStage(extreme) already stripped descriptions
    const extremeTools: Tool[] = tools.map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: { type: "object", properties: {} }, // stripped by extreme
    }));
    const stage = applyLazyBudget(8, originalMap);
    const result = stage(extremeTools);
    const search = result.find(t => t.name === "github_search")!;
    // Should have original full schema, not the extreme-stripped one
    expect(search.inputSchema.properties).toHaveProperty("q");
    expect(search.inputSchema.required).toEqual(["q"]);
  });
});

describe("injectGetSchema", () => {
  it("appends mcp__get_schema tool at end of list", () => {
    const tools: Tool[] = [
      { name: "mock_echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
    ];
    const result = injectGetSchema(tools);
    expect(result).toHaveLength(2);
    expect(result[1].name).toBe("mcp__get_schema");
  });

  it("get_schema description contains available tool names", () => {
    const tools: Tool[] = [
      { name: "mock_echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
      { name: "mock_add", description: "Add", inputSchema: { type: "object", properties: {} } },
    ];
    const result = injectGetSchema(tools);
    expect(result[2].description).toContain("mock_add");
    expect(result[2].description).toContain("mock_echo");
  });

  it("get_schema has inputSchema with required tool_name param", () => {
    const result = injectGetSchema([]);
    const schema = result[0].inputSchema;
    expect(schema.required).toEqual(["tool_name"]);
  });
});

describe("generateTools / buildPipeline", () => {
  const tools: Tool[] = [
    { name: "github_search", description: "Search", inputSchema: { type: "object", properties: { q: { type: "string", description: "query" } }, required: ["q"] } },
    { name: "github_create", description: "Create", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
  ];

  it("lazy+off: returns preloaded + slim + get_schema", () => {
    const config = { enabled: true, level: "off" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    // github_search is high-priority → full schema
    // github_create is not → slim
    // + mcp__get_schema
    expect(result).toHaveLength(3);
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
    const create = result.find(t => t.name === "github_create")!;
    expect(create.inputSchema).toBeUndefined();
    expect(result[2].name).toBe("mcp__get_schema");
  });

  it("lazy+extreme: level strips first, then lazy restores high-priority from original", () => {
    const config = { enabled: true, level: "extreme" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    const search = result.find(t => t.name === "github_search")!;
    // Should have original full schema (restored from originalTools), not extreme-stripped
    expect(search.inputSchema.properties).toHaveProperty("q");
    const create = result.find(t => t.name === "github_create")!;
    expect(create.inputSchema).toBeUndefined();
  });

  it("lazy+maximum: level embeds signature, then lazy restores high-priority", () => {
    const config = { enabled: true, level: "maximum" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toHaveProperty("q");
  });

  it("lazy+light: degrades to off behavior (no wrapper)", () => {
    const config = { enabled: true, level: "light" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, [], []);
    // No mcp__list_tools / mcp__get_tool_schema / mcp__invoke_tool
    expect(result.find(t => t.name === "mcp__list_tools")).toBeUndefined();
    expect(result.find(t => t.name === "mcp__invoke_tool")).toBeUndefined();
    // But mcp__get_schema IS present (lazy mode)
    expect(result.find(t => t.name === "mcp__get_schema")).toBeDefined();
  });

  it("non-lazy+extreme: works without lazy (existing behavior)", () => {
    const config = { enabled: true, level: "extreme" as const };
    const result = generateTools(tools, config, [], []);
    expect(result).toHaveLength(2);
    const search = result.find(t => t.name === "github_search")!;
    expect(search.inputSchema.properties).toBeDefined();
    // No mcp__get_schema
    expect(result.find(t => t.name === "mcp__get_schema")).toBeUndefined();
  });

  it("non-lazy+off: passes through unchanged", () => {
    const config = { enabled: true, level: "off" as const };
    const result = generateTools(tools, config, [], []);
    expect(result).toEqual(tools);
  });

  it("disabled compressor returns full tools", () => {
    const config = { enabled: false, level: "off" as const, lazy_loading: true };
    const result = generateTools(tools, config, [], []);
    expect(result).toEqual(tools);
  });

  it("whitelist filters before lazy budget selection", () => {
    const config = { enabled: true, level: "off" as const, lazy_loading: true, lazy_budget: 8 };
    const result = generateTools(tools, config, ["github_*"], ["github_create"]);
    // Only github_search survives whitelist
    const names = result.map(t => t.name);
    expect(names).toContain("github_search");
    expect(names).not.toContain("github_create");
  });
});
