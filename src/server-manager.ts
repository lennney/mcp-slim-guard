/**
 * MCP Guard — ServerManager
 *
 * Manages connections to upstream MCP servers.
 * Connects through the UpstreamConnector seam, collects tools, and provides
 * prefixed tool name routing for tool calls.
 *
 * @module server-manager
 */

import { createHash } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamServer } from "./config-types.js";
import { McpSdkUpstreamConnector, type ConnectedUpstream, type UpstreamConnector } from "./upstream-connector.js";
import type { NativeToolRoute } from "./native-tool-adapter.js";

/**
 * Internal state for a single upstream server connection.
 */
interface ServerConnection {
  serverName: string;
  upstream: ConnectedUpstream;
}

interface CatalogRoute {
  catalogName: string;
  legacyName: string;
  serverName: string;
  originalToolName: string;
  tool: Tool;
}

const INTERNAL_WRAPPER_PREFIX = "mcp__";
const NATIVE_RECOVERY_TOOL_NAME = "read_result";

function routeDigest(serverName: string, toolName: string): string {
  return createHash("sha256").update(serverName).update("\0").update(toolName).digest("hex");
}

export interface ConnectedUpstreamLifecycle {
  serverName: string;
  transportKind: ConnectedUpstream["transportKind"];
  toolCount: number;
}

export interface FailedUpstreamLifecycle {
  serverName: string;
  errorType: string;
}

export interface ServerManagerStartReport {
  configured: number;
  connected: ConnectedUpstreamLifecycle[];
  failed: FailedUpstreamLifecycle[];
}

export interface ServerManagerStopReport {
  closed: string[];
  failed: FailedUpstreamLifecycle[];
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
  async start(): Promise<ServerManagerStartReport> {
    const connected: ConnectedUpstreamLifecycle[] = [];
    const failed: FailedUpstreamLifecycle[] = [];
    for (const [serverName, serverConfig] of Object.entries(this.servers)) {
      try {
        const upstream = await this.connector.connect(serverName, serverConfig);
        this.connections.set(serverName, {
          serverName,
          upstream,
        });
        connected.push({
          serverName,
          transportKind: upstream.transportKind,
          toolCount: upstream.tools.length,
        });
      } catch (error) {
        failed.push({
          serverName,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.warn(`[mcp-slim-guard] Failed to connect to server "${serverName}" (${errorType})`);
      }
    }
    return {
      configured: Object.keys(this.servers).length,
      connected,
      failed,
    };
  }

  /**
   * Return all tools from all connected servers with prefixed names.
   *
   * Tool name format: `{serverName}_{originalToolName}`
   * The server name is also prepended to the description for identification.
   */
  getTools(): Tool[] {
    return this.catalogRoutes().map((route) => ({
      ...route.tool,
      name: route.catalogName,
      description: route.tool.description ? `[${route.serverName}] ${route.tool.description}` : `[${route.serverName}]`,
    }));
  }

  /**
   * Return native Tool definitions while retaining the exact upstream route.
   * Original names are preserved when they are globally unique. Collisions
   * use the existing server-prefixed catalog name plus a deterministic suffix
   * when needed; an ambiguous name is never silently routed.
   */
  getNativeTools(): NativeToolRoute[] {
    const candidates = this.catalogRoutes();
    const counts = new Map<string, number>();
    for (const route of candidates) {
      counts.set(route.originalToolName, (counts.get(route.originalToolName) ?? 0) + 1);
    }

    const uniqueOriginalNames = new Set(
      candidates
        .filter(
          ({ originalToolName }) =>
            originalToolName !== NATIVE_RECOVERY_TOOL_NAME && counts.get(originalToolName) === 1,
        )
        .map(({ originalToolName }) => originalToolName),
    );
    // The recovery Tool is owned by Slim Guard and can never be shadowed by
    // an upstream-native route, including future naming fallbacks.
    const usedNames = new Set<string>([NATIVE_RECOVERY_TOOL_NAME]);

    return candidates.map((candidate) => {
      let exposedName = uniqueOriginalNames.has(candidate.originalToolName)
        ? candidate.originalToolName
        : candidate.catalogName;
      const digest = routeDigest(candidate.serverName, candidate.originalToolName);
      let suffixLength = 8;
      while (
        usedNames.has(exposedName) ||
        (exposedName !== candidate.originalToolName && uniqueOriginalNames.has(exposedName))
      ) {
        exposedName = `${candidate.catalogName}__native_${digest.slice(0, suffixLength)}`;
        if (
          suffixLength === digest.length &&
          (usedNames.has(exposedName) ||
            (exposedName !== candidate.originalToolName && uniqueOriginalNames.has(exposedName)))
        ) {
          throw new Error("Unable to create a unique native Tool name");
        }
        suffixLength = Math.min(digest.length, suffixLength + 4);
      }
      usedNames.add(exposedName);
      return {
        catalogName: candidate.catalogName,
        serverName: candidate.serverName,
        originalToolName: candidate.originalToolName,
        tool: exposedName === candidate.tool.name ? candidate.tool : { ...candidate.tool, name: exposedName },
      };
    });
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
    const route = this.catalogRoutes().find((candidate) => candidate.catalogName === prefixedName);
    return route ? { serverName: route.serverName, originalToolName: route.originalToolName } : null;
  }

  /**
   * Return legacy flattened names that must still participate in deny checks.
   * Allow rules bind only to the current canonical catalog name, while a deny
   * written before a collision appeared must continue to block every route
   * that previously shared that ambiguous name.
   */
  getLegacyCatalogNames(catalogName: string): string[] {
    const route = this.catalogRoutes().find((candidate) => candidate.catalogName === catalogName);
    if (!route || route.legacyName === route.catalogName) return [];
    return [route.legacyName];
  }

  private catalogRoutes(): CatalogRoute[] {
    const candidates: CatalogRoute[] = [];
    const legacyCounts = new Map<string, number>();

    for (const [, connection] of this.connections) {
      for (const tool of connection.upstream.tools) {
        const legacyName = `${connection.serverName}_${tool.name}`;
        candidates.push({
          catalogName: legacyName,
          legacyName,
          serverName: connection.serverName,
          originalToolName: tool.name,
          tool,
        });
        legacyCounts.set(legacyName, (legacyCounts.get(legacyName) ?? 0) + 1);
      }
    }

    const reservedLegacyNames = new Set(candidates.map(({ legacyName }) => legacyName));
    const usedCatalogNames = new Set<string>();
    return candidates.map((route) => {
      if (legacyCounts.get(route.legacyName) === 1 && !route.legacyName.startsWith(INTERNAL_WRAPPER_PREFIX)) {
        usedCatalogNames.add(route.legacyName);
        return route;
      }

      const digest = routeDigest(route.serverName, route.originalToolName);
      let suffixLength = 8;
      let catalogName = `${route.legacyName}__sg_${digest.slice(0, suffixLength)}`;
      while (reservedLegacyNames.has(catalogName) || usedCatalogNames.has(catalogName)) {
        suffixLength = Math.min(digest.length, suffixLength + 4);
        catalogName = `${route.legacyName}__sg_${digest.slice(0, suffixLength)}`;
        if (
          suffixLength === digest.length &&
          (reservedLegacyNames.has(catalogName) || usedCatalogNames.has(catalogName))
        ) {
          throw new Error("Unable to create a unique catalog route");
        }
      }
      usedCatalogNames.add(catalogName);
      return { ...route, catalogName };
    });
  }

  /**
   * Forward a tool call to the correct upstream server.
   *
   * @param serverName - The upstream server name
   * @param toolName - The original (unprefixed) tool name
   * @param args - Tool call arguments, omitted when the Host omitted the field
   * @returns The tool call result from the upstream server
   * @throws If the server is not connected or the upstream call fails
   */
  async callTool(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<CallToolResult> {
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
  async stop(): Promise<ServerManagerStopReport> {
    const closed: string[] = [];
    const failed: FailedUpstreamLifecycle[] = [];
    for (const [, conn] of this.connections) {
      try {
        await conn.upstream.close();
        closed.push(conn.serverName);
      } catch (error) {
        failed.push({
          serverName: conn.serverName,
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        const errorType = error instanceof Error ? error.name : "UnknownError";
        console.warn(`[mcp-slim-guard] Error closing upstream "${conn.serverName}" (${errorType})`);
      }
    }

    this.connections.clear();
    return { closed, failed };
  }
}
