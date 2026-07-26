/* eslint-disable @typescript-eslint/no-deprecated -- MCP requires a legacy SSE compatibility fallback. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./config-types.js";
import { resolveUpstreamServer } from "./upstream-config.js";

export type UpstreamTransportKind = "stdio" | "streamable-http" | "sse";

/**
 * A connected MCP dependency. ServerManager depends only on this interface,
 * not on SDK transports or process/network lifecycle details.
 */
export interface ConnectedUpstream {
  readonly tools: Tool[];
  readonly transportKind: UpstreamTransportKind;
  callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** External seam for connecting any standard MCP server. */
export interface UpstreamConnector {
  connect(serverName: string, server: UpstreamServer): Promise<ConnectedUpstream>;
}

class McpSdkConnectedUpstream implements ConnectedUpstream {
  constructor(
    private readonly client: Client,
    readonly tools: Tool[],
    readonly transportKind: UpstreamTransportKind,
  ) {}

  async callTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.client.callTool(
      {
        name: toolName,
        arguments: args,
        _meta: {
          protocolVersion: "2025-11-25",
          clientCapabilities: {},
        },
      },
      CallToolResultSchema,
    );

    return CallToolResultSchema.parse(result);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

interface OpenedClient {
  client: Client;
  transportKind: UpstreamTransportKind;
}

async function openClient(
  transportKind: UpstreamTransportKind,
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport,
): Promise<OpenedClient> {
  const client = new Client({ name: "mcp-slim-guard", version: "0.1.0" }, { capabilities: {} });
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
    const { tools } = await opened.client.listTools();
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
