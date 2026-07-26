/**
 * Opinionated model-facing projection for Slim Guard.
 *
 * A caller sees exactly three tools. The implementation hides the authorized
 * catalog, exact schema lookup, catalog-bound references, upstream invocation,
 * and bounded result retrieval behind that small interface.
 *
 * @module secure-projection
 */

import { createHash, randomBytes } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export const FIND_TOOL = "find_tool";
export const CALL_TOOL = "call_tool";
export const READ_RESULT = "read_result";

const MAX_MATCHES = 3;
const RESULT_BUDGET_CHARS = 12_000;
const RESULT_CHUNK_CHARS = 8_000;
const RESULT_TTL_MS = 5 * 60 * 1000;
const MAX_STORED_RESULTS = 64;

interface CatalogEntry {
  ref: string;
  tool: Tool;
}

interface StoredResult {
  serialized: string;
  expiresAt: number;
}

export type ProjectionInvoker = (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>;

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}

function scoreTool(tool: Tool, query: string): number {
  const name = normalized(tool.name);
  const description = normalized(tool.description ?? "");
  const exactQuery = normalized(query.trim());
  if (!exactQuery) return 0;

  let score = 0;
  if (name === exactQuery) score += 1_000;
  else if (name.startsWith(exactQuery)) score += 500;
  else if (name.includes(exactQuery)) score += 250;
  if (description.includes(exactQuery)) score += 125;

  for (const term of exactQuery.split(/\s+/u).filter(Boolean)) {
    if (name.includes(term)) score += 50;
    if (description.includes(term)) score += 20;
  }

  // CJK intent is often written without spaces. Character bigrams provide a
  // deterministic, dependency-free fallback for phrases such as "读取文档"
  // matching "读取本地文档内容".
  if (/[^\p{ASCII}]/u.test(exactQuery)) {
    const characters = Array.from(exactQuery.replace(/\s+/gu, ""));
    for (let index = 0; index < characters.length - 1; index++) {
      const bigram = characters[index] + characters[index + 1];
      if (name.includes(bigram)) score += 20;
      if (description.includes(bigram)) score += 10;
    }
  }
  return score;
}

function projectionTools(): Tool[] {
  return [
    {
      name: FIND_TOOL,
      description:
        "Find authorized MCP tools for an intent. Returns at most three matches with exact input schemas and catalog-bound references.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Describe the action or information you need.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: CALL_TOOL,
      description:
        "Call a tool returned by find_tool. The reference must belong to the current authorized catalog. Security policy is enforced before execution.",
      inputSchema: {
        type: "object",
        properties: {
          tool_ref: {
            type: "string",
            description: "The exact tool_ref returned by find_tool.",
          },
          arguments: {
            type: "object",
            description: "Arguments matching the exact input schema returned by find_tool.",
          },
        },
        required: ["tool_ref", "arguments"],
        additionalProperties: false,
      },
    },
    {
      name: READ_RESULT,
      description:
        "Read the next bounded chunk of a captured large result. Use only when call_tool returns a result_ref.",
      inputSchema: {
        type: "object",
        properties: {
          result_ref: {
            type: "string",
            description: "The unpredictable result_ref returned by call_tool.",
          },
          cursor: {
            type: "number",
            description: "The next_cursor from the previous chunk. Omit for the first chunk.",
          },
        },
        required: ["result_ref"],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Deep module for the fixed three-tool product surface.
 *
 * The supplied tool list must already be visibility-filtered. Replacing the
 * catalog invalidates every previous tool and result reference.
 */
export class SecureProjectionKernel {
  private catalogDigest = "";
  private entriesByRef = new Map<string, CatalogEntry>();
  private orderedEntries: CatalogEntry[] = [];
  private results = new Map<string, StoredResult>();
  private resultOrder: string[] = [];

  constructor(tools: Tool[]) {
    this.replaceCatalog(tools);
  }

  listTools(): Tool[] {
    return projectionTools();
  }

  handles(toolName: string): boolean {
    return toolName === FIND_TOOL || toolName === CALL_TOOL || toolName === READ_RESULT;
  }

  replaceCatalog(tools: Tool[]): void {
    const orderedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
    this.catalogDigest = createHash("sha256").update(JSON.stringify(orderedTools)).digest("hex");

    this.entriesByRef.clear();
    this.orderedEntries = orderedTools.map((tool, index) => {
      const entry = {
        ref: `tool_${this.catalogDigest.slice(0, 16)}_${index}`,
        tool,
      };
      this.entriesByRef.set(entry.ref, entry);
      return entry;
    });
    this.results.clear();
    this.resultOrder = [];
  }

  async call(toolName: string, args: Record<string, unknown>, invoke: ProjectionInvoker): Promise<CallToolResult> {
    switch (toolName) {
      case FIND_TOOL:
        return this.findTool(args);
      case CALL_TOOL:
        return this.callTool(args, invoke);
      case READ_RESULT:
        return this.readResult(args);
      default:
        return errorResult(`Unknown Slim Guard tool: ${toolName}`);
    }
  }

  private findTool(args: Record<string, unknown>): CallToolResult {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return errorResult("Missing required parameter: query");

    const matches = this.orderedEntries
      .map((entry) => ({ entry, score: scoreTool(entry.tool, query) }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.tool.name.localeCompare(b.entry.tool.name))
      .slice(0, MAX_MATCHES)
      .map(({ entry }) => ({
        tool_ref: entry.ref,
        name: entry.tool.name,
        description: entry.tool.description ?? "",
        input_schema: entry.tool.inputSchema,
      }));

    return jsonResult({
      catalog_digest: this.catalogDigest,
      matches,
    });
  }

  private async callTool(args: Record<string, unknown>, invoke: ProjectionInvoker): Promise<CallToolResult> {
    const toolRef = typeof args.tool_ref === "string" ? args.tool_ref : "";
    const callArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : null;

    if (!toolRef) return errorResult("Missing required parameter: tool_ref");
    if (!callArgs) return errorResult("Parameter arguments must be an object");

    const entry = this.entriesByRef.get(toolRef);
    if (!entry) {
      return errorResult("Unknown or stale tool_ref. Call find_tool again.");
    }

    const result = await invoke(entry.tool.name, callArgs);
    const serialized = JSON.stringify(result);
    if (serialized.length <= RESULT_BUDGET_CHARS) return result;

    const resultRef = `result_${randomBytes(16).toString("hex")}`;
    this.storeResult(resultRef, serialized);
    const preview = serialized.slice(0, 1_000);
    const capsule = {
      result_ref: resultRef,
      original_chars: serialized.length,
      preview,
      next_cursor: 0,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...capsule,
            message: "Large result captured. Use read_result with result_ref to retrieve bounded chunks.",
          }),
        },
      ],
      isError: result.isError,
      structuredContent: capsule,
      _meta: {
        ...(result._meta ?? {}),
        "io.github.lennney/slim-guard": capsule,
      },
    };
  }

  private readResult(args: Record<string, unknown>): CallToolResult {
    const resultRef = typeof args.result_ref === "string" ? args.result_ref : "";
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!resultRef) return errorResult("Missing required parameter: result_ref");
    if (!Number.isInteger(cursor) || cursor < 0) return errorResult("cursor must be a non-negative integer");

    const stored = this.results.get(resultRef);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) this.deleteResult(resultRef);
      return errorResult("Unknown or expired result_ref.");
    }
    if (cursor > stored.serialized.length) {
      return errorResult("cursor is beyond the captured result.");
    }

    const chunk = stored.serialized.slice(cursor, cursor + RESULT_CHUNK_CHARS);
    const nextCursor = cursor + chunk.length;
    const done = nextCursor >= stored.serialized.length;

    return jsonResult({
      result_ref: resultRef,
      cursor,
      next_cursor: done ? null : nextCursor,
      done,
      chunk,
    });
  }

  private storeResult(resultRef: string, serialized: string): void {
    this.results.set(resultRef, {
      serialized,
      expiresAt: Date.now() + RESULT_TTL_MS,
    });
    this.resultOrder.push(resultRef);
    while (this.resultOrder.length > MAX_STORED_RESULTS) {
      const oldest = this.resultOrder.shift();
      if (oldest) this.results.delete(oldest);
    }
  }

  private deleteResult(resultRef: string): void {
    this.results.delete(resultRef);
    this.resultOrder = this.resultOrder.filter((candidate) => candidate !== resultRef);
  }
}

export function usesSecureProjection(config: { enabled: boolean; level: string; lazy_loading?: boolean }): boolean {
  return config.enabled && config.level === "light" && !config.lazy_loading;
}
