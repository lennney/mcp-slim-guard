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
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import type { GuardConfig } from "./config-types.js";
import type { AuditOutcome, PolicyContext, PolicyResult } from "./types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PolicyPipeline } from "./policies/base.js";
import { AuditLogger } from "./audit.js";
import { ServerManager } from "./server-manager.js";
import { generateTools, handleWrapperTool, whitelistFilter, PREFIX } from "./compressor.js";
import { ToolCache } from "./cache.js";
import {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  SecureProjectionKernel,
  usesSecureProjection,
  type ObservedProjectionCall,
  type ProjectionCallReport,
} from "./secure-projection.js";
import { VERSION } from "./index.js";

function projectionAuditArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  if (toolName === CALL_TOOL) {
    return { tool_ref: args.tool_ref };
  }
  if (toolName === READ_RESULT) {
    return { result_ref: args.result_ref, cursor: args.cursor };
  }
  if (toolName === FIND_TOOL) {
    return { query: args.query };
  }
  return {};
}

function projectionReportMetadata(report: ProjectionCallReport): Record<string, unknown> {
  return {
    upstreamInvoked: report.upstreamInvoked,
    ...(report.upstreamToolName ? { upstreamToolName: report.upstreamToolName } : {}),
    ...(report.upstreamIsError !== undefined ? { upstreamIsError: report.upstreamIsError } : {}),
    ...(report.capsule ? { capsule: report.capsule } : {}),
  };
}

interface ForwardTraceState {
  upstreamInvoked: boolean;
  outcome?: "success" | "blocked" | "invalid_request" | "cache_hit" | "upstream_error" | "transport_error";
  reason?: string;
}

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
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- McpServer lacks setRequestHandler (needed for dynamic tools/list/call routing)
  private server: Server | null = null;
  private sessionId = "?";
  private requestCounter = 0;
  /** Cached full tool list (prefixed); refreshed on start() + reload(). */
  private fullTools: Tool[] = [];
  /** Optional request cache (null when cache.enabled=false) */
  private cache: ToolCache | null = null;
  /** Fixed three-tool product surface for newly generated light configs. */
  private projection: SecureProjectionKernel | null = null;

  /**
   * @param config - Guard configuration
   * @param pipeline - Policy pipeline for tools/call enforcement
   * @param audit - Audit logger for recording each tool call
   * @param serverManager - Manager for upstream MCP server connections
   */
  constructor(config: GuardConfig, pipeline: PolicyPipeline, audit: AuditLogger, serverManager: ServerManager) {
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
    const lifecycleStarted = Date.now();
    // Generate new session ID
    this.sessionId = this.audit.newSession();
    this.requestCounter = 0;
    this.recordLifecycle("starting", "success", {
      configuredServers: Object.keys(this.config.servers).length,
    });

    const startReport = await this.serverManager.start();

    // Initialize cache if configured
    this.cache = this.config.cache?.enabled ? new ToolCache(this.config.cache) : null;

    this.server = new Server({ name: "mcp-slim-guard", version: VERSION }, { capabilities: { tools: {} } });

    // Full tool list (from upstream, with prefixed names)
    this.fullTools = this.serverManager.getTools();
    this.projection = this.buildProjection(this.config, this.serverManager, this.fullTools);

    // Register tools/list handler — compressor aware
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      try {
        const compressor = this.config.compressor ?? { enabled: false, level: "off" as const };
        const tools = this.projection
          ? this.projection.listTools()
          : generateTools(this.fullTools, compressor, this.config.tools.allow, this.config.tools.deny);
        const visibleNames = tools.map((tool) => tool.name);
        this.audit.logDiscovery(this.sessionId, ++this.requestCounter, "projection", tools.length, visibleNames);
        return {
          tools,
        };
      } catch (err) {
        this.audit.log(
          { toolName: "tools/list", arguments: {}, serverName: "projection" },
          { allowed: true },
          [],
          this.sessionId,
          ++this.requestCounter,
          0,
          {
            event: "discovery",
            outcome: "internal_error",
            metadata: { errorType: err instanceof Error ? err.name : "UnknownError" },
          },
        );
        console.error("[proxy] tools/list handler error:", err instanceof Error ? err.name : "UnknownError");
        return { tools: [] };
      }
    });

    // Core tool call logic: resolve → policy → audit → forward
    const forwardToolCall = async (
      prefixedName: string,
      args: Record<string, unknown>,
      traceId: string,
      traceState?: ForwardTraceState,
    ): Promise<CallToolResult> => {
      const resolved = this.serverManager.resolveTool(prefixedName);
      if (!resolved) {
        if (traceState) {
          traceState.outcome = "invalid_request";
          traceState.reason = "Unknown or ambiguous tool";
        }
        this.audit.log(
          { toolName: prefixedName, arguments: {}, serverName: "routing" },
          { allowed: false, reason: "Unknown or ambiguous tool", policy: "routing" },
          [],
          this.sessionId,
          ++this.requestCounter,
          0,
          { traceId, event: "routing", outcome: "invalid_request" },
        );
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${prefixedName}` }],
          isError: true,
          resultType: "complete" as const,
        };
      }

      const { serverName, originalToolName } = resolved;
      const ctx: PolicyContext = {
        toolName: prefixedName,
        arguments: args,
        serverName,
        // Surface the connection session id as agentId so per_agent rate
        // limits can actually target individual callers. Without this the
        // ratelimit policy always falls back to serverName and per_agent
        // overrides never take effect.
        agentId: this.sessionId,
      };

      const startTime = Date.now();
      let result: PolicyResult;
      let trail: Awaited<ReturnType<PolicyPipeline["executeWithTrail"]>>["trail"];
      try {
        ({ result, trail } = await this.pipeline.executeWithTrail(ctx));
      } catch (error) {
        this.audit.log(ctx, { allowed: true }, [], this.sessionId, ++this.requestCounter, Date.now() - startTime, {
          traceId,
          event: "policy",
          outcome: "internal_error",
          metadata: { errorType: error instanceof Error ? error.name : "UnknownError" },
        });
        throw error;
      }
      const durationMs = Date.now() - startTime;
      const reqId = ++this.requestCounter;

      this.audit.log(ctx, result, trail, this.sessionId, reqId, durationMs, {
        traceId,
        event: "policy",
        outcome: result.allowed ? "success" : "blocked",
      });

      if (!result.allowed) {
        if (traceState) {
          traceState.outcome = "blocked";
          traceState.reason = result.reason;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: (result as Extract<PolicyResult, { allowed: false }>).reason ?? "Blocked by policy",
            },
          ],
          isError: true,
          resultType: "complete" as const,
        };
      }

      // Cache check — return cached result if hit
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        const cached = this.cache.get(prefixedName, args);
        if (cached) {
          if (traceState) traceState.outcome = "cache_hit";
          // Audit cache hit
          this.audit.log(
            { ...ctx, arguments: {} },
            { allowed: true },
            [{ policy: "cache", result: "pass" }],
            this.sessionId,
            ++this.requestCounter,
            Date.now() - startTime,
            {
              traceId,
              event: "cache",
              outcome: "cache_hit",
              metadata: { upstreamInvoked: false },
            },
          );
          return { ...cached, resultType: "complete" as const };
        }
      }

      const upstreamStarted = Date.now();
      let callResult: CallToolResult;
      if (traceState) traceState.upstreamInvoked = true;
      try {
        callResult = await this.serverManager.callTool(serverName, originalToolName, args);
      } catch (error) {
        if (traceState) traceState.outcome = "transport_error";
        this.audit.log(
          { ...ctx, arguments: {} },
          { allowed: true },
          [],
          this.sessionId,
          ++this.requestCounter,
          Date.now() - upstreamStarted,
          {
            traceId,
            event: "upstream",
            outcome: "transport_error",
            metadata: {
              upstreamInvoked: true,
              errorType: error instanceof Error ? error.name : "UnknownError",
            },
          },
        );
        throw error;
      }
      if (traceState) traceState.outcome = callResult.isError ? "upstream_error" : "success";
      this.audit.log(
        { ...ctx, arguments: {} },
        { allowed: true },
        [],
        this.sessionId,
        ++this.requestCounter,
        Date.now() - upstreamStarted,
        {
          traceId,
          event: "upstream",
          outcome: callResult.isError ? "upstream_error" : "success",
          metadata: {
            upstreamInvoked: true,
            isError: callResult.isError === true,
            contentBlocks: callResult.content.length,
          },
        },
      );

      // Cache write — store result for future calls
      if (this.cache && this.cache.isCacheable(prefixedName)) {
        // Upstream ttlMs hint (not yet returned by SDK 1.29.0, but pipeline ready)
        const upstreamTtlMs = (callResult as Record<string, unknown>).ttlMs as number | undefined;
        this.cache.set(prefixedName, args, callResult, upstreamTtlMs);
      }

      return { ...callResult, resultType: "complete" as const };
    };

    // Register tools/call handler — compressor aware, all calls go through policy pipeline
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const params = request.params;
      const prefixedName = params.name;
      const args: Record<string, unknown> = params.arguments ?? {};
      const traceId = this.audit.newTrace();

      if (this.projection?.handles(prefixedName)) {
        const started = Date.now();
        const traceState: ForwardTraceState = { upstreamInvoked: false };
        let observed: ObservedProjectionCall;
        try {
          observed = await this.projection.callObserved(prefixedName, args, (targetName, targetArgs) =>
            forwardToolCall(targetName, targetArgs, traceId, traceState),
          );
        } catch (error) {
          this.audit.log(
            {
              toolName: prefixedName,
              arguments: projectionAuditArguments(prefixedName, args),
              serverName: "projection",
            },
            { allowed: true },
            [],
            this.sessionId,
            ++this.requestCounter,
            Date.now() - started,
            {
              traceId,
              event: prefixedName === READ_RESULT ? "recovery" : "projection",
              outcome: traceState.outcome === "transport_error" ? "transport_error" : "internal_error",
              metadata: {
                upstreamInvoked: traceState.upstreamInvoked,
                errorType: error instanceof Error ? error.name : "UnknownError",
              },
            },
          );
          throw error;
        }
        const effectiveOutcome =
          traceState.outcome === "blocked" || traceState.outcome === "invalid_request"
            ? traceState.outcome
            : observed.report.outcome;
        const rejected =
          effectiveOutcome === "blocked" || effectiveOutcome === "invalid_request" || effectiveOutcome === "rejected";
        this.audit.log(
          {
            toolName: prefixedName,
            arguments: projectionAuditArguments(prefixedName, args),
            serverName: "projection",
          },
          rejected
            ? {
                allowed: false,
                reason: traceState.reason ?? "Projection request rejected",
                policy: "projection",
              }
            : { allowed: true },
          [],
          this.sessionId,
          ++this.requestCounter,
          Date.now() - started,
          {
            traceId,
            event: prefixedName === READ_RESULT ? "recovery" : "projection",
            outcome: effectiveOutcome,
            metadata: {
              ...projectionReportMetadata(observed.report),
              upstreamInvoked:
                traceState.outcome === undefined ? observed.report.upstreamInvoked : traceState.upstreamInvoked,
            },
          },
        );
        return observed.result;
      }

      // mcp__* prefix → wrapper/discovery tools (handleWrapperTool)
      if (prefixedName.startsWith(PREFIX)) {
        // Whitelist-filter fullTools before passing to handleWrapperTool
        // (pipeline stage 0 logic, applied here for the call path)
        const filteredTools = whitelistFilter(this.config.tools.allow, this.config.tools.deny)(this.fullTools);
        const wrapperResult = await handleWrapperTool(prefixedName, args, filteredTools, (targetName, targetArgs) =>
          forwardToolCall(targetName, targetArgs, traceId),
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
            { traceId, event: "projection", outcome: "success" },
          );
          return wrapperResult;
        }
      }

      // Real tool → security pipeline
      return forwardToolCall(prefixedName, args, traceId);
    });

    try {
      await this.server.connect(transport);
    } catch (error) {
      let downstreamCloseErrorType: string | undefined;
      try {
        await this.server.close();
      } catch (closeError) {
        downstreamCloseErrorType = closeError instanceof Error ? closeError.name : "UnknownError";
      }
      const stopReport = await this.serverManager.stop();
      this.recordLifecycle(
        "start_failed",
        "internal_error",
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
          upstreamClosed: stopReport.closed,
          upstreamCloseFailures: stopReport.failed,
          ...(downstreamCloseErrorType ? { downstreamCloseErrorType } : {}),
        },
        Date.now() - lifecycleStarted,
      );
      this.server = null;
      await this.audit.close();
      throw error;
    }

    this.recordLifecycle(
      startReport.failed.length > 0 ? "ready_degraded" : "ready",
      startReport.failed.length > 0 ? "degraded" : "success",
      {
        configuredServers: startReport.configured,
        connectedUpstreams: startReport.connected,
        failedUpstreams: startReport.failed,
        catalogTools: this.fullTools.length,
        modelFacingTools: this.projection ? 3 : this.fullTools.length,
      },
      Date.now() - lifecycleStarted,
    );
  }

  /**
   * Stop the proxy: close the MCP Server and stop the ServerManager.
   */
  async stop(): Promise<void> {
    const lifecycleStarted = Date.now();
    this.recordLifecycle("stopping", "success");
    let downstreamErrorType: string | undefined;
    if (this.server) {
      try {
        await this.server.close();
      } catch (error) {
        downstreamErrorType = error instanceof Error ? error.name : "UnknownError";
      }
      this.server = null;
    }
    const stopReport = await this.serverManager.stop();
    this.cache?.clear();
    const invalidatedResults = this.projection?.clear().invalidatedResults ?? 0;
    const degraded = downstreamErrorType !== undefined || stopReport.failed.length > 0;
    this.recordLifecycle(
      degraded ? "stopped_degraded" : "stopped",
      degraded ? "degraded" : "success",
      {
        upstreamClosed: stopReport.closed,
        upstreamCloseFailures: stopReport.failed,
        ...(downstreamErrorType ? { downstreamErrorType } : {}),
        invalidatedResults,
      },
      Date.now() - lifecycleStarted,
    );
    await this.audit.close();
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
  async reload(
    newConfig: GuardConfig,
    newPipeline: PolicyPipeline,
    newAudit?: AuditLogger,
    newServerManager?: ServerManager,
    lifecycleMetadata: Record<string, unknown> = {},
  ): Promise<void> {
    const nextServerManager = newServerManager ?? this.serverManager;
    const nextFullTools = newServerManager ? nextServerManager.getTools() : this.fullTools;
    // Prepare every fallible derived object before mutating the active runtime.
    const nextProjection = this.buildProjection(newConfig, nextServerManager, nextFullTools);
    const nextCache = newConfig.cache?.enabled ? new ToolCache(newConfig.cache) : null;

    const previousAudit = this.audit;
    const previousProjection = this.projection;
    this.config = newConfig;
    this.pipeline = newPipeline;
    this.cache = nextCache;
    if (newAudit) {
      this.audit = newAudit;
    }
    if (newServerManager) {
      this.serverManager = nextServerManager;
      this.fullTools = nextFullTools;
    }
    this.projection = nextProjection;
    let invalidatedResults = 0;
    let invalidationErrorType: string | undefined;
    try {
      invalidatedResults = previousProjection?.clear().invalidatedResults ?? 0;
    } catch (error) {
      invalidationErrorType = error instanceof Error ? error.name : "UnknownError";
    }
    this.recordLifecycle(
      invalidationErrorType ? "reloaded_degraded" : "reloaded",
      invalidationErrorType ? "degraded" : "success",
      {
        ...lifecycleMetadata,
        catalogTools: this.fullTools.length,
        invalidatedResults,
        ...(invalidationErrorType ? { invalidationErrorType } : {}),
      },
    );
    if (previousAudit !== this.audit) {
      await previousAudit.close();
    }
  }

  recordLifecycle(
    state: string,
    outcome: Extract<AuditOutcome, "success" | "degraded" | "internal_error">,
    metadata: Record<string, unknown> = {},
    durationMs = 0,
  ): void {
    this.audit.log(
      { toolName: `runtime/${state}`, arguments: {}, serverName: "system" },
      { allowed: true },
      [],
      this.sessionId,
      ++this.requestCounter,
      durationMs,
      {
        event: "lifecycle",
        outcome,
        metadata,
      },
    );
  }

  /**
   * Return the underlying MCP Server instance.
   *
   * @returns The Server instance
   * @throws If the server has not been started yet
   */
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- McpServer lacks setRequestHandler (needed for dynamic tools/list/call routing)
  getServer(): Server {
    if (!this.server) {
      throw new Error("Server not started");
    }
    return this.server;
  }

  /**
   * Rebuild the fixed product projection from the one authorized catalog.
   * The legacy compressor remains available for old configs and unadvertised
   * mcp__* aliases, but newly generated light configs use this kernel.
   */
  private buildProjection(
    config: GuardConfig,
    serverManager: ServerManager,
    fullTools: Tool[],
  ): SecureProjectionKernel | null {
    const compressor = config.compressor ?? { enabled: false, level: "off" as const };
    if (!usesSecureProjection(compressor)) {
      return null;
    }

    const allow = config.tools.allow.filter(Boolean);
    const deny = config.tools.deny.filter(Boolean);
    const authorizedTools = allow.length === 0 ? [] : whitelistFilter(allow, deny)(fullTools);
    // A flattened legacy name can collide when server and tool names both
    // contain underscores. Never advertise a reference that cannot resolve to
    // exactly one catalog route.
    const visibleTools = authorizedTools.filter((tool) => serverManager.resolveTool(tool.name) !== null);
    return new SecureProjectionKernel(visibleTools);
  }
}
