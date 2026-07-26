/**
 * MCP Guard — ServerManager
 *
 * Manages connections to upstream MCP servers.
 * Connects through the UpstreamConnector seam, collects tools, and provides
 * prefixed tool name routing for tool calls.
 *
 * @module server-manager
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./config-types.js";
import { McpSdkUpstreamConnector, type ConnectedUpstream, type UpstreamConnector } from "./upstream-connector.js";

/**
 * Internal state for a single upstream server connection.
 */
interface ServerConnection {
  serverName: string;
  upstream: ConnectedUpstream;
}

/**
 * Manages connections to upstream MCP servers.
 *
 * Usage:
 * ```ts
 * const manager = new ServerManager(servers);
 * await manager.start();
 * const tools = manager.getTools();
 * const result = await manager.callTool("github", "search_repositories", { q: "..." });
 * await manager.stop();
 * ```
 */
export class ServerManager {
  private connections: Map<string, ServerConnection> = new Map();
  private servers: Record<string, UpstreamServer>;
  private connector: UpstreamConnector;

  /**
   * @param servers - Map of server name → UpstreamServer config
   * @param connector - Production SDK connector or a test adapter
   */
  constructor(servers: Record<string, UpstreamServer>, connector: UpstreamConnector = new McpSdkUpstreamConnector()) {
    this.servers = servers;
    this.connector = connector;
  }

  /**
   * Connect to all upstream MCP servers.
   *
   * For each server:
   * 1. Asks the connector to open a standard MCP upstream
   * 2. Collects the discovered tools
   * 3. Stores the connected session for exact routing
   *
   * Errors are handled gracefully: if a server fails to connect or list tools,
   * a warning is logged and the method continues with the remaining servers.
   */
  async start(): Promise<void> {
    for (const [serverName, serverConfig] of Object.entries(this.servers)) {
      try {
        const upstream = await this.connector.connect(serverName, serverConfig);
        this.connections.set(serverName, {
          serverName,
          upstream,
        });
      } catch (error) {
        console.warn(`[mcp-slim-guard] Failed to connect to server "${serverName}":`, error);
      }
    }
  }

  /**
   * Return all tools from all connected servers with prefixed names.
   *
   * Tool name format: `{serverName}_{originalToolName}`
   * The server name is also prepended to the description for identification.
   */
  getTools(): Tool[] {
    const allTools: Tool[] = [];

    for (const [, conn] of this.connections) {
      for (const tool of conn.upstream.tools) {
        allTools.push({
          ...tool,
          name: `${conn.serverName}_${tool.name}`,
          description: tool.description ? `[${conn.serverName}] ${tool.description}` : `[${conn.serverName}]`,
        });
      }
    }

    return allTools;
  }

  /**
   * Resolve a prefixed tool name to its server and original tool name.
   *
   * Resolves only an exact tool discovered from the upstream catalog. This
   * deliberately rejects guessed names and ambiguous server/tool prefix
   * combinations instead of forwarding them to an upstream server.
   *
   * @param prefixedName - The prefixed tool name (e.g. "github_search_repositories")
   * @returns The resolved server name and original tool name, or null if not found
   */
  resolveTool(prefixedName: string): { serverName: string; originalToolName: string } | null {
    const matches: Array<{ serverName: string; originalToolName: string }> = [];
    for (const [serverName, connection] of this.connections) {
      for (const tool of connection.upstream.tools) {
        if (`${serverName}_${tool.name}` === prefixedName) {
          matches.push({ serverName, originalToolName: tool.name });
        }
      }
    }

    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Forward a tool call to the correct upstream server.
   *
   * @param serverName - The upstream server name
   * @param toolName - The original (unprefixed) tool name
   * @param args - Tool call arguments
   * @returns The tool call result from the upstream server
   * @throws If the server is not connected or the upstream call fails
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`Unknown upstream server: "${serverName}"`);
    }

    return conn.upstream.callTool(toolName, args);
  }

  /**
   * Synthesize server discovery metadata for all connected upstream servers.
   *
   * Returns metadata for each connected server including its capabilities.
   * This is a polyfill for the MCP 2026-07-28 server/discover method,
   * which is not yet implemented in SDK 1.29.0.
   *
   * @returns Discovery result with server metadata
   */
  async discover(): Promise<{
    servers: Array<{
      name: string;
      version?: string;
      capabilities: Record<string, unknown>;
    }>;
  }> {
    const servers: Array<{
      name: string;
      version?: string;
      capabilities: Record<string, unknown>;
    }> = [];

    for (const [name] of this.connections) {
      // Best-effort: return capabilities for each connected server.
      // When SDK supports server/discover natively, this can forward to upstream.
      servers.push({
        name,
        capabilities: {
          tools: { listChanged: false },
        },
      });
    }

    return { servers };
  }

  /**
   * Close all upstream connections.
   *
   * Iterates over all connected servers, closes their transports,
   * and clears the connection map. Errors during shutdown are logged
   * as warnings but do not prevent other connections from closing.
   */
  async stop(): Promise<void> {
    for (const [, conn] of this.connections) {
      try {
        await conn.upstream.close();
      } catch (error) {
        console.warn(`[mcp-slim-guard] Error closing upstream "${conn.serverName}":`, error);
      }
    }

    this.connections.clear();
  }
}
