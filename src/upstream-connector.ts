/* eslint-disable @typescript-eslint/no-deprecated -- MCP requires a legacy SSE compatibility fallback. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./config-types.js";
import { resolveUpstreamServer } from "./upstream-config.js";
import { VERSION } from "./version.js";

export type UpstreamTransportKind = "stdio" | "streamable-http" | "sse";

/**
 * A connected MCP dependency. ServerManager depends only on this interface,
 * not on SDK transports or process/network lifecycle details.
 */
export interface ConnectedUpstream {
  readonly tools: Tool[];
  readonly transportKind: UpstreamTransportKind;
  callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** External seam for connecting any standard MCP server. */
export interface UpstreamConnector {
  connect(serverName: string, server: UpstreamServer): Promise<ConnectedUpstream>;
}

function isWireRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Restore wire extensions recursively after the SDK has validated and
 * normalized the standard MCP fields. The validated value is authoritative
 * wherever both trees contain a standard field; raw-only keys survive at any
 * object depth.
 */
function preserveWireExtensions(raw: unknown, validated: unknown): unknown {
  if (Array.isArray(validated)) {
    if (!Array.isArray(raw)) return validated;
    return validated.map((entry, index) => preserveWireExtensions(raw[index], entry));
  }
  if (!isWireRecord(validated)) return validated;

  const rawRecord = isWireRecord(raw) ? raw : {};
  const merged: Record<string, unknown> = { ...rawRecord };
  for (const [key, value] of Object.entries(validated)) {
    merged[key] = preserveWireExtensions(rawRecord[key], value);
  }
  return merged;
}

const MetadataPreservingCallToolResultSchema = {
  safeParse(value: unknown) {
    const validated = CallToolResultSchema.safeParse(value);
    if (!validated.success) return validated;

    return {
      success: true as const,
      data: preserveWireExtensions(value, validated.data),
    };
  },
} as unknown as typeof CallToolResultSchema;

class McpSdkConnectedUpstream implements ConnectedUpstream {
  constructor(
    private readonly client: Client,
    readonly tools: Tool[],
    readonly transportKind: UpstreamTransportKind,
  ) {}

  async callTool(toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
    const request: { name: string; arguments?: Record<string, unknown> } = { name: toolName };
    if (args !== undefined) request.arguments = args;
    const result = await this.client.callTool(request, MetadataPreservingCallToolResultSchema);

    // Validate the standard result while returning raw extension fields that
    // the SDK's normalizing schema would otherwise strip from content blocks.
    return result as CallToolResult;
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

interface OpenedClient {
  client: Client;
  transportKind: UpstreamTransportKind;
}

const MetadataPreservingListToolsResultSchema = {
  safeParse(value: unknown) {
    const validated = ListToolsResultSchema.safeParse(value);
    if (!validated.success) return validated;

    return {
      success: true as const,
      data: preserveWireExtensions(value, validated.data),
    };
  },
} as unknown as typeof ListToolsResultSchema;

async function openClient(
  transportKind: UpstreamTransportKind,
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport,
): Promise<OpenedClient> {
  const client = new Client({ name: "mcp-slim-guard", version: VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    return { client, transportKind };
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Preserve the connection error; shutdown is best-effort on a failed start.
    }
    throw error;
  }
}

async function discoverTools(opened: OpenedClient): Promise<ConnectedUpstream> {
  try {
    // The SDK validates standard Tool fields but its default Zod object drops
    // unknown top-level metadata. Validate with the official schema, then
    // merge the validated fields over the original wire object so an MCP
    // extension survives catalog projection.
    const { tools } = await opened.client.request(
      {
        method: "tools/list",
        params: {},
      },
      MetadataPreservingListToolsResultSchema,
    );
    return new McpSdkConnectedUpstream(opened.client, tools, opened.transportKind);
  } catch (error) {
    try {
      await opened.client.close();
    } catch {
      // Preserve the discovery error; shutdown is best-effort.
    }
    throw error;
  }
}

/**
 * Production adapter backed by the official MCP TypeScript SDK.
 *
 * Remote URL entries use the protocol's compatibility order: Streamable HTTP
 * first, then one deprecated HTTP+SSE attempt. Explicit `type: "sse"` entries
 * skip the modern attempt.
 */
export class McpSdkUpstreamConnector implements UpstreamConnector {
  async connect(serverName: string, server: UpstreamServer): Promise<ConnectedUpstream> {
    const resolved = resolveUpstreamServer(serverName, server);

    if (resolved.kind === "stdio") {
      return discoverTools(
        await openClient(
          "stdio",
          new StdioClientTransport({
            command: resolved.command,
            args: resolved.args,
            env: resolved.env,
            cwd: resolved.cwd,
          }),
        ),
      );
    }

    const requestInit: RequestInit = { headers: resolved.headers };
    if (resolved.kind === "sse") {
      return discoverTools(await openClient("sse", new SSEClientTransport(resolved.url, { requestInit })));
    }

    let streamableError: unknown;
    let opened: OpenedClient;
    try {
      opened = await openClient("streamable-http", new StreamableHTTPClientTransport(resolved.url, { requestInit }));
    } catch (error) {
      streamableError = error;
      console.warn(
        `[mcp-slim-guard] Streamable HTTP initialization failed for upstream "${serverName}"; trying legacy SSE once.`,
      );
      try {
        opened = await openClient("sse", new SSEClientTransport(resolved.url, { requestInit }));
      } catch (sseError) {
        throw new AggregateError(
          [streamableError, sseError],
          `Failed to connect upstream "${serverName}" using Streamable HTTP or legacy SSE`,
          { cause: sseError },
        );
      }
    }

    return discoverTools(opened);
  }
}
