/**
 * Opinionated model-facing projection for Slim Guard.
 *
 * A caller sees exactly three tools. The implementation hides the authorized
 * catalog, exact schema lookup, catalog-bound references, upstream invocation,
 * and bounded result retrieval behind that small interface.
 *
 * @module secure-projection
 */

import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ResultCapsuleStore,
  type ResultCapsuleObservation,
  type ResultCapsuleObserver,
} from "./result-capsule-store.js";

export const FIND_TOOL = "find_tool";
export const CALL_TOOL = "call_tool";
export const READ_RESULT = "read_result";

const MAX_MATCHES = 3;

interface CatalogEntry {
  ref: string;
  tool: Tool;
}

export type ProjectionInvoker = (toolName: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export interface ResultDeliveryStore {
  capture(result: CallToolResult, observer?: ResultCapsuleObserver): CallToolResult;
  read(args: Record<string, unknown>, observer?: ResultCapsuleObserver): CallToolResult;
  clear(): number | void;
}

export type ProjectionCallOutcome =
  | "success"
  | "invalid_request"
  | "upstream_error"
  | "projected"
  | "pass_through"
  | "fail_open"
  | "chunk"
  | "complete"
  | "rejected";

export interface ProjectionCallReport {
  toolName: string;
  outcome: ProjectionCallOutcome;
  upstreamInvoked: boolean;
  upstreamToolName?: string;
  upstreamIsError?: boolean;
  capsule?: ResultCapsuleObservation;
}

export interface ObservedProjectionCall {
  result: CallToolResult;
  report: ProjectionCallReport;
}

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
        "Read the next bounded chunk of a captured large result. The first text block is the raw chunk; the second carries cursor metadata. Use only when call_tool returns a result_ref.",
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
  private results: ResultDeliveryStore;

  constructor(tools: Tool[], results: ResultDeliveryStore = new ResultCapsuleStore()) {
    this.results = results;
    this.replaceCatalog(tools);
  }

  listTools(): Tool[] {
    return projectionTools();
  }

  handles(toolName: string): boolean {
    return toolName === FIND_TOOL || toolName === CALL_TOOL || toolName === READ_RESULT;
  }

  replaceCatalog(tools: Tool[]): { invalidatedResults: number } {
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
    return { invalidatedResults: this.results.clear() ?? 0 };
  }

  clear(): { invalidatedResults: number } {
    this.catalogDigest = "";
    this.entriesByRef.clear();
    this.orderedEntries = [];
    return { invalidatedResults: this.results.clear() ?? 0 };
  }

  async call(toolName: string, args: Record<string, unknown>, invoke: ProjectionInvoker): Promise<CallToolResult> {
    return (await this.callObserved(toolName, args, invoke)).result;
  }

  async callObserved(
    toolName: string,
    args: Record<string, unknown>,
    invoke: ProjectionInvoker,
  ): Promise<ObservedProjectionCall> {
    switch (toolName) {
      case FIND_TOOL: {
        const result = this.findTool(args);
        return {
          result,
          report: {
            toolName,
            outcome: result.isError ? "invalid_request" : "success",
            upstreamInvoked: false,
          },
        };
      }
      case CALL_TOOL:
        return this.callToolObserved(args, invoke);
      case READ_RESULT: {
        let capsule: ResultCapsuleObservation | undefined;
        const result = this.results.read(args, (observation) => {
          capsule = observation;
        });
        return {
          result,
          report: {
            toolName,
            outcome: capsule?.phase === "recovery" ? capsule.outcome : result.isError ? "rejected" : "complete",
            upstreamInvoked: false,
            ...(capsule ? { capsule } : {}),
          },
        };
      }
      default: {
        const result = errorResult(`Unknown Slim Guard tool: ${toolName}`);
        return {
          result,
          report: {
            toolName,
            outcome: "invalid_request",
            upstreamInvoked: false,
          },
        };
      }
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
      .map(({ entry }) => {
        const { inputSchema, ...toolMetadata } = entry.tool;
        return {
          ...toolMetadata,
          tool_ref: entry.ref,
          input_schema: inputSchema,
        };
      });

    return jsonResult({
      catalog_digest: this.catalogDigest,
      matches,
    });
  }

  private async callToolObserved(
    args: Record<string, unknown>,
    invoke: ProjectionInvoker,
  ): Promise<ObservedProjectionCall> {
    const toolRef = typeof args.tool_ref === "string" ? args.tool_ref : "";
    const callArgs =
      args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
        ? (args.arguments as Record<string, unknown>)
        : null;

    if (!toolRef) {
      return this.invalidCall("Missing required parameter: tool_ref");
    }
    if (!callArgs) {
      return this.invalidCall("Parameter arguments must be an object");
    }

    const entry = this.entriesByRef.get(toolRef);
    if (!entry) {
      return this.invalidCall("Unknown or stale tool_ref. Call find_tool again.");
    }

    const upstreamResult = await invoke(entry.tool.name, callArgs);
    let capsule: ResultCapsuleObservation | undefined;
    let result: CallToolResult;
    try {
      result = this.results.capture(upstreamResult, (observation) => {
        capsule = observation;
      });
    } catch {
      capsule = {
        phase: "delivery",
        outcome: "fail_open",
        reason: "internal_error",
      };
      result = upstreamResult;
    }
    const deliveryOutcome = capsule?.phase === "delivery" ? capsule.outcome : ("pass_through" as const);
    return {
      result,
      report: {
        toolName: CALL_TOOL,
        outcome: upstreamResult.isError ? "upstream_error" : deliveryOutcome,
        upstreamInvoked: true,
        upstreamToolName: entry.tool.name,
        upstreamIsError: upstreamResult.isError === true,
        ...(capsule ? { capsule } : {}),
      },
    };
  }

  private invalidCall(message: string): ObservedProjectionCall {
    return {
      result: errorResult(message),
      report: {
        toolName: CALL_TOOL,
        outcome: "invalid_request",
        upstreamInvoked: false,
      },
    };
  }
}

export function usesSecureProjection(config: { enabled: boolean; level: string; lazy_loading?: boolean }): boolean {
  return config.enabled && config.level === "light" && !config.lazy_loading;
}
