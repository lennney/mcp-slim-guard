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
import { PolicyPipeline, type DecisionStep } from "./policies/base.js";
import { AuditLogger } from "./audit.js";
import { ServerManager } from "./server-manager.js";
import { getCompressedTools, handleWrapperTool, LIST_TOOLS, GET_SCHEMA, INVOKE, PREFIX } from "./compressor.js";

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
  private sessionId = "?";
  private requestCounter = 0;

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

    // Generate new session ID
    this.sessionId = this.audit.newSession();
    this.requestCounter = 0;

    this.server = new Server(
      { name: "tinymcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    // Full tool list (from upstream, with prefixed names)
    const fullTools = this.serverManager.getTools();

    // Register tools/list handler — compressor aware
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Log discovery event
      const allNames = fullTools.map(t => t.name);
      this.audit.logDiscovery(this.sessionId, ++this.requestCounter, "all", fullTools.length, allNames);

      if (this.config.compressor?.enabled) {
        return { tools: getCompressedTools(fullTools, this.config.compressor) };
      }
      return { tools: fullTools };
    });

    // Core tool call logic: resolve → policy → audit → forward
    const forwardToolCall = async (
      prefixedName: string,
      args: Record<string, unknown>,
    ) => {
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
      const ctx: PolicyContext = {
        toolName: prefixedName,
        arguments: args,
        serverName,
      };

      const startTime = Date.now();
      const { result, trail } = await this.pipeline.executeWithTrail(ctx);
      const durationMs = Date.now() - startTime;
      const reqId = ++this.requestCounter;

      this.audit.log(ctx, result, trail, this.sessionId, reqId, durationMs);

      if (!result.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: (result as Extract<PolicyResult, { allowed: false }>).reason ?? "Blocked by policy",
            },
          ],
          isError: true,
        };
      }

      return await this.serverManager.callTool(
        serverName,
        originalToolName,
        args,
      );
    };

    // Register tools/call handler — compressor aware, all calls go through policy pipeline
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        const params = request.params;
        const prefixedName = params.name;
        const args: Record<string, unknown> = params.arguments ?? {};

        // Compressor wrapper tools: handle directly but with whitelist filtering + audit.
        // mcp__list_tools / mcp__get_tool_schema → handled by compressor (discovery).
        // mcp__invoke_tool → handleWrapperTool delegates to forwardToolCall internally.
        // In all cases we audit the wrapper call and return wrapperResult directly.
        if (this.config.compressor?.enabled && prefixedName.startsWith(PREFIX)) {
          const wrapperResult = await handleWrapperTool(
            prefixedName,
            args,
            fullTools,
            (targetName, targetArgs) => forwardToolCall(targetName, targetArgs),
            this.config.tools.allow,
            this.config.tools.deny,
          );
          if (wrapperResult) {
            // Audit the wrapper call (for discovery tools that don't go through forwardToolCall)
            const reqId = ++this.requestCounter;
            this.audit.log(
              { toolName: prefixedName, arguments: args, serverName: "compressor" },
              { allowed: true },
              [],
              this.sessionId,
              reqId,
              0,
            );
            return wrapperResult;
          }
        }

        // Normal tool call
        return forwardToolCall(prefixedName, args);
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
   * Hot-reload config and policy pipeline without restarting.
   * Keeps the MCP Server alive — swaps the policy pipeline, audit logger,
   * and server manager (if new ones are provided).
   *
   * @param newConfig - Updated GuardConfig
   * @param newPipeline - New policy pipeline built from the updated config
   * @param newAudit - Optional new audit logger
   * @param newServerManager - Optional new server manager (already started)
   */
  reload(
    newConfig: GuardConfig,
    newPipeline: PolicyPipeline,
    newAudit?: AuditLogger,
    newServerManager?: ServerManager,
  ): void {
    this.config = newConfig;
    this.pipeline = newPipeline;
    if (newAudit) {
      this.audit = newAudit;
    }
    if (newServerManager) {
      this.serverManager = newServerManager;
      // Refresh the cached tool list used by compressor handlers
      this.serverManager = newServerManager;
    }
    this.audit.log(
      { toolName: "<reload>", arguments: {}, serverName: "system" },
      { allowed: true },
      [],
      this.sessionId,
      ++this.requestCounter,
      0,
    );
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
