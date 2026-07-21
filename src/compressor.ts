/**
 * tinymcp — Schema Compressor
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

import type { CompressorConfig } from "./config-types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import micromatch from "micromatch";

const { isMatch } = micromatch;

/** Prefix for wrapper tools to avoid colliding with real tool names */
const PREFIX = "mcp__";
const LIST_TOOLS = `${PREFIX}list_tools`;
const GET_SCHEMA = `${PREFIX}get_tool_schema`;
const INVOKE = `${PREFIX}invoke_tool`;

/**
 * Generate the compressed tool list that the agent sees.
 */
export function getCompressedTools(
  fullTools: Tool[],
  config: CompressorConfig,
): Tool[] {
  if (!config.enabled) return fullTools;

  const tools: Tool[] = [];

  // 1. list_tools (only at light level — tight level omits discovery)
  if (config.level === "light") {
    tools.push({
      name: LIST_TOOLS,
      description:
        "List all available tools (names and descriptions only, no schemas). Call get_tool_schema to get full input schema for a specific tool.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    });
  }

  // 2. get_tool_schema — always available
  tools.push({
    name: GET_SCHEMA,
    description:
      "Get the full input schema (parameters, types, constraints) for one tool. Use this before calling invoke_tool to construct correct arguments.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: `The full tool name (e.g. "mock_echo"). Available tools: ${fullTools.map(t => t.name).sort().join(", ")}`,
        },
      },
      required: ["tool_name"],
    },
  });

  // 3. invoke_tool — always available
  tools.push({
    name: INVOKE,
    description:
      "Invoke a tool with the given arguments. Call get_tool_schema first to see required parameters.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: {
          type: "string",
          description: "The full tool name to invoke",
        },
        input: {
          type: "object",
          description: "Arguments to pass to the tool (use get_tool_schema to see expected fields)",
        },
      },
      required: ["tool_name", "input"],
    },
  });

  return tools;
}

/**
 * Handle a wrapper tool call. Returns the response if it's a wrapper tool,
 * or null if it's a regular tool call that should be handled normally.
 *
 * Whitelist filtering: LIST_TOOLS and GET_SCHEMA only return tools that are
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

    case GET_SCHEMA: {
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

export { PREFIX, LIST_TOOLS, GET_SCHEMA, INVOKE };
