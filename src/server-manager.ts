/**
 * MCP Guard — ServerManager
 *
 * Manages connections to upstream MCP servers.
 * Creates per-upstream Client + StdioClientTransport, collects tools,
 * and provides prefixed tool name routing for tool calls.
 *
 * @module server-manager
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./config-types.js";

/**
 * Internal state for a single upstream server connection.
 */
interface ServerConnection {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  /** Original tool names (without prefix) */
  tools: Tool[];
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

  /**
   * @param servers - Map of server name → UpstreamServer config
   */
  constructor(servers: Record<string, UpstreamServer>) {
    this.servers = servers;
  }

  /**
   * Connect to all upstream MCP servers.
   *
   * For each server:
   * 1. Creates a Client and StdioClientTransport
   * 2. Connects the client to the transport
   * 3. Calls client.listTools() to discover available tools
   * 4. Stores tools for later retrieval with prefixed names
   *
   * Errors are handled gracefully: if a server fails to connect or list tools,
   * a warning is logged and the method continues with the remaining servers.
   */
  async start(): Promise<void> {
    for (const [serverName, serverConfig] of Object.entries(this.servers)) {
      try {
        const client = new Client(
          { name: "micro-mcp", version: "0.1.0" },
          { capabilities: {} },
        );

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
        });

        await client.connect(transport);

        const result = await client.listTools();
        const tools = result.tools;

        this.connections.set(serverName, {
          serverName,
          client,
          transport,
          tools,
        });
      } catch (error) {
        console.warn(
          `[micro-mcp] Failed to connect to server "${serverName}":`,
          error,
        );
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
      for (const tool of conn.tools) {
        allTools.push({
          ...tool,
          name: `${conn.serverName}_${tool.name}`,
          description: tool.description
            ? `[${conn.serverName}] ${tool.description}`
            : `[${conn.serverName}]`,
        });
      }
    }

    return allTools;
  }

  /**
   * Resolve a prefixed tool name to its server and original tool name.
   *
   * Tries splitting on each underscore position (left to right) and returns
   * the first match where the server exists and has the corresponding tool.
   * This handles edge cases where server names or tool names contain underscores.
   *
   * @param prefixedName - The prefixed tool name (e.g. "github_search_repositories")
   * @returns The resolved server name and original tool name, or null if not found
   */
  resolveTool(
    prefixedName: string,
  ): { serverName: string; originalToolName: string } | null {
    if (!prefixedName || !prefixedName.includes("_")) {
      return null;
    }

    // Find all underscore positions
    const positions: number[] = [];
    let idx = prefixedName.indexOf("_");
    while (idx !== -1) {
      positions.push(idx);
      idx = prefixedName.indexOf("_", idx + 1);
    }

    // Try each split position (left to right)
    for (const pos of positions) {
      const candidateServerName = prefixedName.substring(0, pos);
      const candidateToolName = prefixedName.substring(pos + 1);

      if (!candidateServerName || !candidateToolName) {
        continue;
      }

      // Check only that the server exists — policy (whitelist/deny) is enforced
      // later in the pipeline. If the upstream doesn't have the tool, the
      // callTool → upstream will return the native error.
      if (this.connections.has(candidateServerName)) {
        return {
          serverName: candidateServerName,
          originalToolName: candidateToolName,
        };
      }
    }

    return null;
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
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }> }> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      throw new Error(`Unknown upstream server: "${serverName}"`);
    }

    const result = await conn.client.callTool(
      { name: toolName, arguments: args },
      CallToolResultSchema,
    );

    return {
      content: result.content as Array<{ type: string; text?: string }>,
    };
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
      // Close the client first so it finishes its protocol shutdown and
      // releases the transport reference. Closing only the transport can
      // leave the client holding callbacks/handles that keep the process
      // alive after hot-reload or shutdown.
      try {
        await conn.client.close();
      } catch (error) {
        console.warn(
          `[mcp-guard] Error closing client for "${conn.serverName}":`,
          error,
        );
      }
      try {
        await conn.transport.close();
      } catch (error) {
        console.warn(
          `[micro-mcp] Error closing transport for "${conn.serverName}":`,
          error,
        );
      }
    }

    this.connections.clear();
  }
}
