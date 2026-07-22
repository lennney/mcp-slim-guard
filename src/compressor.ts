/**
 * micro-mcp — Schema Compressor
 *
 * Lossless schema compression via wrapper tools.
 * Inspired by mcp-compressor (Atlassian): instead of exposing all tool schemas
 * upfront, expose `get_tool_schema` + `invoke_tool` wrappers that let the
 * agent fetch schemas on demand.
 *
 * Levels:
 *   - `light`: list_tools + get_tool_schema + invoke_tool
 *   - `tight`: get_tool_schema + invoke_tool (no discovery)
 *
 * @module compressor
 */

import type { CompressorConfig, CompressionLevel } from "./config-types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import micromatch from "micromatch";

const { isMatch } = micromatch;

/** Prefix for wrapper tools to avoid colliding with real tool names */
const PREFIX = "mcp__";
const LIST_TOOLS = `${PREFIX}list_tools`;
const GET_TOOL_SCHEMA = `${PREFIX}get_tool_schema`;  // renamed from GET_SCHEMA (wrapper mode)
const GET_SCHEMA = `${PREFIX}get_schema`;              // new: lazy mode discovery tool
const INVOKE = `${PREFIX}invoke_tool`;

/** A compression/lazy stage: input tools → output tools */
export type ToolStage = (tools: Tool[]) => Tool[];

/**
 * Whitelist filter stage — filters tools by allow/deny patterns.
 * deny match → blocked; allow non-empty → must match; otherwise allowed.
 * This replaces the isToolVisible logic previously embedded in handleWrapperTool.
 */
export const whitelistFilter = (allow: string[], deny: string[]): ToolStage => {
  return (tools: Tool[]) => {
    const isAllowed = (name: string): boolean => {
      if (deny.length > 0 && deny.some(p => isMatch(name, p))) return false;
      if (allow.length > 0) return allow.some(p => isMatch(name, p));
      return true;
    };
    return tools.filter(t => isAllowed(t.name));
  };
};

/**
 * Build wrapper tools for light/normal compression levels.
 * @param tools - Original full tool list
 * @param includeList - Whether to include mcp__list_tools (light only)
 */
function makeWrapperTools(tools: Tool[], includeList: boolean): Tool[] {
  const result: Tool[] = [];

  if (includeList) {
    result.push({
      name: LIST_TOOLS,
      description:
        "List all available tools (names and descriptions only, no schemas). Call get_tool_schema to get full input schema for a specific tool.",
      inputSchema: { type: "object", properties: {} },
    });
  }

  result.push({
    name: GET_TOOL_SCHEMA,
    description:
      "Get the full input schema (parameters, types, constraints) for one tool. Use this before calling invoke_tool to construct correct arguments.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: `The full tool name (e.g. "mock_echo"). Available tools: ${tools.map(t => t.name).sort().join(", ")}`,
        },
      },
      required: ["tool_name"],
    },
  });

  result.push({
    name: INVOKE,
    description:
      "Invoke a tool with the given arguments. Call get_tool_schema first to see required parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "The full tool name to invoke" },
        input: {
          type: "object",
          description: "Arguments to pass to the tool (use get_tool_schema to see expected fields)",
        },
      },
      required: ["tool_name", "input"],
    },
  });

  return result;
}

/**
 * Compression level → stage function.
 * When lazyLoading=true, light/normal/tight degrade to passthrough (no wrapper).
 * Note: config-loader's normalizeCompressionLevel already maps "tight" → "normal",
 * so the "tight" case is for type completeness only.
 */
export const levelToStage = (level: CompressionLevel, lazyLoading: boolean): ToolStage => {
  return (tools: Tool[]) => {
    if (lazyLoading && (level === "light" || level === "normal" || level === "tight")) {
      return tools; // passthrough — lazy mode doesn't use wrappers
    }

    switch (level) {
      case "off":
        return tools;

      case "light":
        return makeWrapperTools(tools, true);

      case "normal":
      case "tight":
        return makeWrapperTools(tools, false);

      case "extreme":
        return tools.map(t => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: stripPropertyDescriptions(t.inputSchema),
        }));

      case "maximum":
        return tools.map(t => ({
          name: t.name,
          description: `${t.description ?? ""} ${buildSignature(t)}`.trim(),
          inputSchema: { type: "object" as const, properties: {} },
        }));
    }
  };
};

/**
 * High-priority tool name pattern for lazy budget preload.
 * Matches read-operation verbs LLMs typically call first. The verb may appear
 * at the start of the tool name or right after a single server-prefix segment
 * (e.g. `github_search`, `slack_get_history`), matching the project's
 * `server_toolname` routing convention.
 */
const HIGH_PRIORITY = /^(?:[^_]+_)?(search|list|read|get|find|describe|info)/i;

/**
 * Lazy budget stage — preloads high-priority tools with full original schema,
 * strips schema from low-priority tools (slim format: name + description only).
 * @param budget - Max number of high-priority tools to preload
 * @param originalTools - Original full tool map (for restoring schema after level compression)
 */
export const applyLazyBudget = (
  budget: number,
  originalTools: Map<string, Tool>,
): ToolStage => {
  return (tools: Tool[]) => {
    // Select high-priority tools (up to budget)
    const fullSet = new Set<string>();
    for (const t of tools) {
      if (fullSet.size >= budget) break;
      if (HIGH_PRIORITY.test(t.name)) fullSet.add(t.name);
    }

    return tools.map(t => {
      if (fullSet.has(t.name)) {
        // High-priority: restore full original schema
        return originalTools.get(t.name) ?? t;
      }
      // Low-priority: slim format (name + description, no inputSchema).
      // The Tool type from the SDK marks inputSchema as required, but the slim
      // variant intentionally omits it so the client must call mcp__get_schema
      // to fetch it. Assert through unknown (type-safe, no `any`).
      return { name: t.name, description: t.description ?? "" } as unknown as Tool;
    });
  };
};

/**
 * Inject mcp__get_schema discovery tool at end of list.
 * LLM calls this to fetch full schema for a slim tool before invoking it.
 * The available tool names are embedded in the tool's main description so the
 * LLM can discover what it can ask about without an extra round-trip.
 */
export const injectGetSchema: ToolStage = (tools: Tool[]) => {
  const toolNames = tools.map(t => t.name).sort().join(", ");
  return [
    ...tools,
    {
      name: GET_SCHEMA,
      description:
        `Get the full input schema (parameters, types, constraints) for a specific tool. Call this before invoking a tool whose schema is not included in the tools list. Returns the complete original schema. Available tools: ${toolNames}`,
      inputSchema: {
        type: "object" as const,
        properties: {
          tool_name: {
            type: "string",
            description: "The tool name to get schema for.",
          },
        },
        required: ["tool_name"],
      },
    },
  ];
};

/**
 * Build the pipeline of stages from config.
 * Order: whitelistFilter → levelToStage → applyLazyBudget → injectGetSchema
 * @param originalTools - Original full tool map (for applyLazyBudget to restore schemas)
 */
export function buildPipeline(
  config: CompressorConfig,
  allow: string[],
  deny: string[],
  originalTools: Map<string, Tool>,
): ToolStage[] {
  const stages: ToolStage[] = [];

  // Stage 0: whitelist filter
  stages.push(whitelistFilter(allow, deny));

  // Stage 1: compression level
  stages.push(levelToStage(config.level, config.lazy_loading ?? false));

  // Stage 2 + 3: lazy loading (orthogonal to level)
  if (config.lazy_loading) {
    stages.push(applyLazyBudget(config.lazy_budget ?? 8, originalTools));
    stages.push(injectGetSchema);
  }

  return stages;
}

/**
 * Generate the tools/list response — pipeline serial execution.
 * Entry point for proxy.ts tools/list handler.
 *
 * When level=off and lazy_loading=false, passthrough (backward compat with
 * existing behavior where tools/list returns all tools unfiltered).
 * When level≠off or lazy_loading=true, pipeline runs (including whitelistFilter).
 */
export function generateTools(
  fullTools: Tool[],
  config: CompressorConfig,
  allow: string[] = [],
  deny: string[] = [],
): Tool[] {
  if (!config.enabled) return fullTools;
  if (config.level === "off" && !config.lazy_loading) return fullTools;

  const originalTools = new Map(fullTools.map(t => [t.name, t]));
  return buildPipeline(config, allow, deny, originalTools).reduce(
    (tools, stage) => stage(tools),
    fullTools,
  );
}

/**
 * Generate the compressed tool list that the agent sees.
 */
export function getCompressedTools(
  fullTools: Tool[],
  config: CompressorConfig,
): Tool[] {
  if (!config.enabled || config.level === "off") return fullTools;
  return makeWrapperTools(fullTools, config.level === "light");
}

/**
 * Handle a wrapper tool call. Returns the response if it's a wrapper tool,
 * or null if it's a regular tool call that should be handled normally.
 *
 * Whitelist filtering: LIST_TOOLS and GET_TOOL_SCHEMA only return tools that are
 * allowed by the allow/deny patterns, preventing information disclosure
 * through compressor discovery tools.
 */
export async function handleWrapperTool(
  toolName: string,
  args: Record<string, unknown>,
  fullTools: Tool[],
  serverCall: (resolvedToolName: string, resolvedArgs: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>;
  }>,
  allowPatterns: string[] = [],
  denyPatterns: string[] = [],
): Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
} | null> {
  // Only handle our wrapper tools
  if (!toolName.startsWith(PREFIX)) return null;

  // Build a name→schema lookup
  const nameToSchema: Record<string, Tool> = {};
  for (const t of fullTools) nameToSchema[t.name] = t;

  // Helper: check if a tool is allowed by the whitelist (allow/deny patterns).
  // Follows the same logic as WhitelistPolicy:
  //   deny matches → NOT allowed
  //   allow patterns non-empty AND no allow match → NOT allowed
  //   otherwise → allowed
  const isToolVisible = (toolName: string): boolean => {
    // Deny match always blocks
    if (denyPatterns.length > 0 && denyPatterns.some(p => isMatch(toolName, p))) {
      return false;
    }
    // Allow list non-empty → must match at least one pattern
    if (allowPatterns.length > 0) {
      return allowPatterns.some(p => isMatch(toolName, p));
    }
    // No allow patterns = everything allowed
    return true;
  };

  switch (toolName) {
    case LIST_TOOLS: {
      // Return tool names + descriptions only (no inputSchema), filtered by whitelist
      const entries = fullTools
        .filter(t => isToolVisible(t.name))
        .map(t => ({
          name: t.name,
          description: t.description || "(no description)",
        }));
      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
      };
    }

    case GET_TOOL_SCHEMA: {
      const targetName = args.tool_name as string;
      if (!targetName || !nameToSchema[targetName]) {
        return {
          content: [{
            type: "text",
            text: `Unknown tool: "${targetName}". Available: ${Object.keys(nameToSchema).sort().join(", ")}`,
          }],
          isError: true,
        };
      }
      // Whitelist check: deny tool schema enumeration for blocked tools
      if (!isToolVisible(targetName)) {
        return {
          content: [{ type: "text", text: `Tool "${targetName}" is not available` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(nameToSchema[targetName], null, 2) }],
      };
    }

    case INVOKE: {
      const targetName = args.tool_name as string;
      const input = (args.input || {}) as Record<string, unknown>;
      if (!targetName) {
        return { content: [{ type: "text", text: "Missing required parameter: tool_name" }], isError: true };
      }
      // Delegate to normal call handling (will go through policy pipeline)
      return serverCall(targetName, input);
    }

    default:
      // Wrapper prefix but unknown — ignore
      return null;
  }
}

/**
 * Build a function signature string for a tool.
 * Example: "search_repositories(query: string, page?: number, per_page?: number)"
 */
function buildSignature(tool: Tool): string {
  const props = (tool.inputSchema?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = (tool.inputSchema?.required as string[] | undefined) ?? [];
  const requiredSet = new Set(required);

  const params = Object.entries(props).map(([name, schema]) => {
    const type = schema.type ?? "unknown";
    const isRequired = requiredSet.has(name);
    return `${name}${isRequired ? "" : "?"}: ${type}`;
  });

  return `${tool.name}(${params.join(", ")})`;
}

/**
 * Strip property descriptions from inputSchema, keeping type, required, enum, default.
 * Used by the "extreme" compression level.
 */
function stripPropertyDescriptions(schema: Tool["inputSchema"]): Tool["inputSchema"] {
  if (!schema || !schema.properties) return schema;
  const stripped: Record<string, Record<string, unknown>> = {};
  for (const [key, prop] of Object.entries(schema.properties as Record<string, Record<string, unknown>>)) {
    const cleaned: Record<string, unknown> = {};
    if (prop.type !== undefined) cleaned.type = prop.type;
    if (prop.enum !== undefined) cleaned.enum = prop.enum;
    if (prop.default !== undefined) cleaned.default = prop.default;
    stripped[key] = cleaned;
  }
  return {
    type: schema.type,
    properties: stripped,
    required: schema.required,
  };
}

/**
 * Generate the tool list for schema transformation levels (extreme/maximum).
 *
 * Unlike wrapper levels, tools keep their real identities. The agent calls
 * `github_search_repositories` directly instead of going through
 * `mcp__invoke_tool`. The security pipeline sees the real tool name.
 *
 * @param fullTools - Complete tool list from upstream servers
 * @param level - "extreme" or "maximum"
 * @returns Compressed tool list with real tool identities
 */
export function getTransformTools(
  fullTools: Tool[],
  level: "extreme" | "maximum",
): Tool[] {
  return fullTools.map((tool) => {
    if (level === "maximum") {
      return {
        name: tool.name,
        description: `${tool.description ?? ""} ${buildSignature(tool)}`.trim(),
        inputSchema: {
          type: "object" as const,
          properties: {},
        },
      };
    }

    // extreme level
    return {
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: stripPropertyDescriptions(tool.inputSchema),
    };
  });
}

export { PREFIX, LIST_TOOLS, GET_TOOL_SCHEMA, GET_SCHEMA, INVOKE };
