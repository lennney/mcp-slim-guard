/**
 * MCP Guard — GuardProxy
 *
 * Core proxy engine that ties together ServerManager, PolicyPipeline, and
 * AuditLogger into a single MCP Server. Handles tools/list and tools/call
 * by enforcing policies and auditing each call.
 *
 * @module proxy
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { GuardConfig } from "./config-types.js";
import type { PolicyContext, PolicyResult } from "./types.js";
import { PolicyPipeline } from "./policies/base.js";
import { AuditLogger } from "./audit.js";
import { ServerManager } from "./server-manager.js";

/**
 * Core proxy engine that wraps an MCP Server with policy enforcement and
 * auditing. Created with injected dependencies, then started with a transport
 * to begin accepting requests.
 */
export class GuardProxy {
  private config: GuardConfig;
  private pipeline: PolicyPipeline;
  private audit: AuditLogger;
  private serverManager: ServerManager;
  private server: Server | null = null;

  /**
   * @param config - Guard configuration
   * @param pipeline - Policy pipeline for tools/call enforcement
   * @param audit - Audit logger for recording each tool call
   * @param serverManager - Manager for upstream MCP server connections
   */
  constructor(
    config: GuardConfig,
    pipeline: PolicyPipeline,
    audit: AuditLogger,
    serverManager: ServerManager,
  ) {
    this.config = config;
    this.pipeline = pipeline;
    this.audit = audit;
    this.serverManager = serverManager;
  }

  /**
   * Start the proxy: connect to upstream servers, create the MCP Server,
   * register handlers, and connect to the given transport.
   *
   * 1. Starts the ServerManager (connects to all upstream servers)
   * 2. Creates the MCP Server with implementation info
   * 3. Registers tools/list handler → returns ServerManager.getTools()
   * 4. Registers tools/call handler → resolve → pipeline → audit → forward
   * 5. Connects the Server to the transport
   *
   * @param transport - The transport to listen on
   */
  async start(transport: Transport): Promise<void> {
    await this.serverManager.start();

    this.server = new Server(
      { name: "mcp-guard", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    // Register tools/list handler — passthrough to ServerManager
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.serverManager.getTools() };
    });

    // Register tools/call handler — resolve → policy check → audit → forward
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        const params = request.params;
        const prefixedName = params.name;
        const args: Record<string, unknown> = params.arguments ?? {};

        // Step 2: Resolve prefixed tool name
        const resolved = this.serverManager.resolveTool(prefixedName);
        if (!resolved) {
          return {
            content: [
              { type: "text" as const, text: `Unknown tool: ${prefixedName}` },
            ],
            isError: true,
          };
        }

        const { serverName, originalToolName } = resolved;

        // Step 4: Build PolicyContext
        const ctx: PolicyContext = {
          toolName: originalToolName,
          arguments: args,
          serverName,
        };

        // Step 5: Run policy pipeline
        const startTime = Date.now();
        const result: PolicyResult = await this.pipeline.execute(ctx);
        const durationMs = Date.now() - startTime;

        // Step 6: Audit log
        this.audit.log(ctx, result, durationMs);

        // Step 7: Blocked by policy
        if (!result.allowed) {
          return {
            content: [
              {
                type: "text" as const,
                text: result.reason ?? "Blocked by policy",
              },
            ],
            isError: true,
          };
        }

        // Step 8-9: Forward to upstream server and return result
        return await this.serverManager.callTool(
          serverName,
          originalToolName,
          args,
        );
      },
    );

    await this.server.connect(transport);
  }

  /**
   * Stop the proxy: close the MCP Server and stop the ServerManager.
   */
  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
    await this.serverManager.stop();
  }

  /**
   * Return the underlying MCP Server instance.
   *
   * @returns The Server instance
   * @throws If the server has not been started yet
   */
  getServer(): Server {
    if (!this.server) {
      throw new Error("Server not started");
    }
    return this.server;
  }
}
