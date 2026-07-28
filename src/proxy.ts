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
import { Protocol } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ListToolsRequestSchema, CallToolRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { GuardConfig } from "./config-types.js";
import type { AuditOutcome, PolicyContext, PolicyResult } from "./types.js";
import type { CallToolResult, JSONRPCMessage, RequestId, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PolicyPipeline } from "./policies/base.js";
import { AuditLogger } from "./audit.js";
import { ServerManager, type FailedUpstreamLifecycle } from "./server-manager.js";
import { activeWrapperToolNames, generateTools, handleWrapperTool, whitelistFilter } from "./compressor.js";
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
import { ResultCapsuleStore } from "./result-capsule-store.js";
import { NativeToolAdapter, type NativeToolRoute } from "./native-tool-adapter.js";
import { VERSION } from "./version.js";

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
  auditFailed?: boolean;
  outcome?: "success" | "blocked" | "invalid_request" | "cache_hit" | "upstream_error" | "transport_error";
  reason?: string;
}

export type GuardSurface = "generic" | "native";

export interface GuardProxyOptions {
  /** Explicit integration selection; the runtime never infers this from Host identity. */
  surface?: GuardSurface;
}

interface ProxyCallRequest {
  params: {
    name: string;
    arguments?: Record<string, unknown>;
  };
}

type ProxyCallHandler = (request: ProxyCallRequest, extra?: unknown) => Promise<CallToolResult>;

/**
 * Register the call handler on the SDK's base Protocol seam. The SDK Server
 * wrapper parses CallToolResultSchema and strips unknown result extensions;
 * Slim Guard must preserve those fields on the MCP wire. Request validation is
 * retained here, while result validation remains at the upstream Client seam.
 * The fallback keeps the lightweight unit Server mock compatible.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- low-level SDK Server seam is required for wire extensions
function registerCallHandler(server: Server, handler: ProxyCallHandler): void {
  const basePrototype = Protocol.prototype as unknown as {
    setRequestHandler?: (schema: unknown, callback: unknown) => unknown;
  };
  const baseRegister = basePrototype?.setRequestHandler;
  if (server instanceof Protocol && typeof baseRegister === "function") {
    const dispatchSchema = CallToolRequestSchema.pick({ method: true }).loose();
    baseRegister.call(server, dispatchSchema, async (request: unknown, extra: unknown) => {
      const schema = CallToolRequestSchema as unknown as {
        safeParse?: (value: unknown) => { success: boolean };
      };
      const parsed = schema.safeParse?.(request);
      if (parsed && !parsed.success) {
        throw new McpError(ErrorCode.InvalidParams, "Invalid tools/call params");
      }
      return handler(request as ProxyCallRequest, extra);
    });
    return;
  }
  server.setRequestHandler(CallToolRequestSchema, handler as never);
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
  private fallbackTraceCounter = 0;
  /** Cached full tool list (prefixed); refreshed on start() + reload(). */
  private fullTools: Tool[] = [];
  /** Optional request cache (null when cache.enabled=false) */
  private cache: ToolCache | null = null;
  /** Fixed three-tool product surface for newly generated light configs. */
  private projection: SecureProjectionKernel | null = null;
  /** Explicit Host-native surface; null for the generic or legacy adapters. */
  private native: NativeToolAdapter | null = null;
  /** One recovery store shared by whichever public adapter is active. */
  private results = new ResultCapsuleStore();
  private surface: GuardSurface;
  /** Requests admitted by tools/call; reload and stop wait for the next idle boundary. */
  private inFlightToolCalls = 0;
  private idleWaiters = new Set<() => void>();
  private pendingToolResponses = new Map<RequestId, number>();
  private toolResponseSends = new Map<RequestId, number>();
  /** Projected references whose JSON-RPC response is currently crossing the downstream transport. */
  private projectedResponseSends = new Map<RequestId, number>();
  /** Forces the active reload to preserve its generation when a projected response overlaps it. */
  private reloadBlockedByProjectedDelivery = false;
  private runtimeState: "starting" | "running" | "reloading" | "stopping" | "stopped" = "stopped";
  private admissionWaiters = new Set<() => void>();
  private stopPromise: Promise<void> | null = null;

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
    options: GuardProxyOptions = {},
  ) {
    this.config = config;
    this.pipeline = pipeline;
    this.audit = audit;
    this.serverManager = serverManager;
    this.surface = options.surface ?? "generic";
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
    if (this.runtimeState !== "stopped") {
      throw new Error(`Cannot start while runtime is ${this.runtimeState}`);
    }
    this.stopPromise = null;
    const lifecycleStarted = Date.now();
    this.runtimeState = "starting";
    // Generate new session ID
    this.sessionId = this.newAuditSession();
    this.requestCounter = 0;
    this.recordLifecycle("starting", "success", {
      configuredServers: Object.keys(this.config.servers).length,
    });

    let startReport: Awaited<ReturnType<ServerManager["start"]>>;
    try {
      startReport = await this.serverManager.start();

      // Initialize cache if configured
      this.cache = this.config.cache?.enabled ? new ToolCache(this.config.cache) : null;

      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Server exposes the low-level handler seam used above
      this.server = new Server(
        { name: "mcp-slim-guard", version: VERSION },
        { capabilities: { tools: { listChanged: true } } },
      );

      // Full tool list (from upstream, with prefixed names)
      this.fullTools = this.serverManager.getTools();
      this.native =
        this.surface === "native" ? this.buildNativeAdapter(this.config, this.serverManager, this.fullTools) : null;
      this.projection = this.native ? null : this.buildProjection(this.config, this.serverManager, this.fullTools);

      // Register tools/list handler — compressor aware
      this.server.setRequestHandler(ListToolsRequestSchema, async () => {
        try {
          const compressor = this.config.compressor ?? { enabled: false, level: "off" as const };
          const tools = this.native
            ? this.native.listTools()
            : this.projection
              ? this.projection.listTools()
              : generateTools(this.fullTools, compressor, this.config.tools.allow, this.config.tools.deny, (name) =>
                  this.serverManager.getLegacyCatalogNames(name),
                );
          const visibleNames = tools.map((tool) => tool.name);
          this.recordDiscovery(
            this.sessionId,
            ++this.requestCounter,
            this.native ? "native" : "projection",
            tools.length,
            visibleNames,
          );
          return {
            tools,
          };
        } catch (err) {
          this.recordAudit(
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
      const deliverNativeResult = (
        route: NativeToolRoute,
        upstreamResult: CallToolResult,
        ctx: PolicyContext,
        traceId: string,
        upstreamInvoked: boolean,
      ): CallToolResult => {
        if (this.runtimeState === "reloading") {
          this.recordAudit({ ...ctx, arguments: {} }, { allowed: true }, [], this.sessionId, ++this.requestCounter, 0, {
            traceId,
            event: "projection",
            outcome: "pass_through",
            metadata: { upstreamInvoked, reloadRetiring: true },
          });
          return upstreamResult;
        }
        const delivered = this.native?.deliver(route, upstreamResult);
        if (!delivered) return upstreamResult;
        const auditRecorded = this.recordAudit(
          { ...ctx, arguments: {} },
          { allowed: true },
          [],
          this.sessionId,
          ++this.requestCounter,
          0,
          {
            traceId,
            event: "projection",
            outcome: delivered.observation?.outcome ?? "pass_through",
            metadata: delivered.observation ? { capsule: delivered.observation, upstreamInvoked } : { upstreamInvoked },
          },
        );
        if (auditRecorded) return delivered.result;
        this.results.discardProjection(delivered.result);
        return upstreamResult;
      };

      const forwardToolCall = async (
        prefixedName: string,
        args: Record<string, unknown> | undefined,
        traceId: string,
        traceState?: ForwardTraceState,
        nativeRoute?: NativeToolRoute,
      ): Promise<CallToolResult> => {
        const policyArgs = args ?? {};
        const resolved = nativeRoute ?? this.serverManager.resolveTool(prefixedName);
        if (!resolved) {
          if (traceState) {
            traceState.outcome = "invalid_request";
            traceState.reason = "Unknown or ambiguous tool";
          }
          this.recordAudit(
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
          arguments: policyArgs,
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
          this.recordAudit(ctx, { allowed: true }, [], this.sessionId, ++this.requestCounter, Date.now() - startTime, {
            traceId,
            event: "policy",
            outcome: "internal_error",
            metadata: { errorType: error instanceof Error ? error.name : "UnknownError" },
          });
          throw error;
        }
        const durationMs = Date.now() - startTime;
        const reqId = ++this.requestCounter;

        let auditFailed = !this.recordAudit(ctx, result, trail, this.sessionId, reqId, durationMs, {
          traceId,
          event: "policy",
          outcome: result.allowed ? "success" : "blocked",
        });
        if (auditFailed && traceState) traceState.auditFailed = true;

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
          const cached = this.cache.get(prefixedName, policyArgs);
          if (cached) {
            if (traceState) traceState.outcome = "cache_hit";
            // Audit cache hit
            const cacheAuditRecorded = this.recordAudit(
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
            if (!cacheAuditRecorded) {
              auditFailed = true;
              if (traceState) traceState.auditFailed = true;
            }
            if (auditFailed) return cached;
            if (nativeRoute && this.native) return deliverNativeResult(nativeRoute, cached, ctx, traceId, false);
            return cached;
          }
        }

        const upstreamStarted = Date.now();
        let callResult: CallToolResult;
        if (traceState) traceState.upstreamInvoked = true;
        try {
          callResult = await this.serverManager.callTool(serverName, originalToolName, args);
        } catch (error) {
          if (traceState) traceState.outcome = "transport_error";
          this.recordAudit(
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
        const upstreamAuditRecorded = this.recordAudit(
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
        if (!upstreamAuditRecorded) {
          auditFailed = true;
          if (traceState) traceState.auditFailed = true;
        }
        if (auditFailed) return callResult;

        // Cache write — store result for future calls
        if (this.cache && this.cache.isCacheable(prefixedName)) {
          // Upstream ttlMs hint (not yet returned by SDK 1.29.0, but pipeline ready)
          const upstreamTtlMs = (callResult as Record<string, unknown>).ttlMs as number | undefined;
          this.cache.set(prefixedName, policyArgs, callResult, upstreamTtlMs);
        }

        if (nativeRoute && this.native) return deliverNativeResult(nativeRoute, callResult, ctx, traceId, true);
        return callResult;
      };

      // Register tools/call handler — compressor aware, all calls go through policy pipeline
      registerCallHandler(this.server, async (request, extra) => {
        if (this.runtimeState === "starting") {
          await this.waitForAdmission();
        }
        if (this.runtimeState !== "running") {
          return {
            content: [{ type: "text" as const, text: "Slim Guard is not accepting new tool calls." }],
            isError: true,
          };
        }
        const requestId = this.requestIdFromExtra(extra);
        const requestSignal = this.abortSignalFromExtra(extra);
        let handlerSettled = false;
        const releaseCancelledToolCall = (): void => {
          if (
            requestId !== undefined &&
            handlerSettled &&
            requestSignal?.aborted &&
            !this.isToolResponseSending(requestId)
          ) {
            this.endToolCall(requestId);
          }
        };
        requestSignal?.addEventListener("abort", releaseCancelledToolCall, { once: true });
        this.beginToolCall(requestId);
        try {
          const params = request.params;
          const prefixedName = params.name;
          const receivedArgs = params.arguments;
          const args: Record<string, unknown> = receivedArgs ?? {};
          const traceId = this.newAuditTrace();

          if (this.native) {
            if (prefixedName === READ_RESULT) {
              const started = Date.now();
              const recovered = this.native.read(args);
              const observation = recovered.observation;
              this.recordAudit(
                {
                  toolName: prefixedName,
                  arguments: projectionAuditArguments(prefixedName, args),
                  serverName: "native",
                },
                { allowed: true },
                [],
                this.sessionId,
                ++this.requestCounter,
                Date.now() - started,
                {
                  traceId,
                  event: "recovery",
                  outcome:
                    observation?.phase === "recovery"
                      ? observation.outcome
                      : recovered.result.isError
                        ? "rejected"
                        : "complete",
                  metadata: observation ? { capsule: observation, upstreamInvoked: false } : { upstreamInvoked: false },
                },
              );
              return recovered.result;
            }

            const nativeRoute = this.native.resolve(prefixedName);
            if (!nativeRoute) {
              this.recordAudit(
                { toolName: prefixedName, arguments: {}, serverName: "routing" },
                { allowed: false, reason: "Unknown or unauthorized native tool", policy: "routing" },
                [],
                this.sessionId,
                ++this.requestCounter,
                0,
                { traceId, event: "routing", outcome: "invalid_request" },
              );
              return {
                content: [{ type: "text" as const, text: `Unknown tool: ${prefixedName}` }],
                isError: true,
              };
            }

            const traceState: ForwardTraceState = { upstreamInvoked: false };
            return await forwardToolCall(nativeRoute.catalogName, receivedArgs, traceId, traceState, nativeRoute);
          }

          if (this.projection?.handles(prefixedName)) {
            const started = Date.now();
            const traceState: ForwardTraceState = { upstreamInvoked: false };
            let observed: ObservedProjectionCall;
            try {
              observed = await this.projection.callObserved(prefixedName, args, (targetName, targetArgs) =>
                forwardToolCall(targetName, targetArgs, traceId, traceState),
              );
            } catch (error) {
              this.recordAudit(
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
            const reloadPassThrough = this.isReloading() && observed.upstreamResult !== undefined;
            const effectiveOutcome = reloadPassThrough
              ? ("pass_through" as const)
              : traceState.outcome === "blocked" || traceState.outcome === "invalid_request"
                ? traceState.outcome
                : observed.report.outcome;
            const rejected =
              effectiveOutcome === "blocked" ||
              effectiveOutcome === "invalid_request" ||
              effectiveOutcome === "rejected";
            if (traceState.auditFailed && observed.upstreamResult) {
              this.results.discardProjection(observed.result);
              return observed.upstreamResult;
            }
            if (reloadPassThrough) {
              this.results.discardProjection(observed.result);
            }
            const projectionAuditRecorded = this.recordAudit(
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
                metadata: reloadPassThrough
                  ? { upstreamInvoked: observed.report.upstreamInvoked, reloadRetiring: true }
                  : {
                      ...projectionReportMetadata(observed.report),
                      upstreamInvoked:
                        traceState.outcome === undefined ? observed.report.upstreamInvoked : traceState.upstreamInvoked,
                    },
              },
            );
            if (!projectionAuditRecorded && observed.upstreamResult) {
              this.results.discardProjection(observed.result);
              return observed.upstreamResult;
            }
            if (reloadPassThrough && observed.upstreamResult) {
              return observed.upstreamResult;
            }
            return observed.result;
          }

          // mcp__* prefix → wrapper/discovery tools (handleWrapperTool)
          if (this.projection) {
            this.recordAudit(
              { toolName: prefixedName, arguments: {}, serverName: "routing" },
              { allowed: false, reason: "Tool is not on the active projection surface", policy: "routing" },
              [],
              this.sessionId,
              ++this.requestCounter,
              0,
              { traceId, event: "routing", outcome: "invalid_request" },
            );
            return {
              content: [{ type: "text" as const, text: `Unknown tool: ${prefixedName}` }],
              isError: true,
            };
          }

          const compressor = this.config.compressor ?? { enabled: false, level: "off" as const };
          const advertisedNames = new Set(
            generateTools(this.fullTools, compressor, this.config.tools.allow, this.config.tools.deny, (name) =>
              this.serverManager.getLegacyCatalogNames(name),
            ).map((tool) => tool.name),
          );
          if (!advertisedNames.has(prefixedName)) {
            this.recordAudit(
              { toolName: prefixedName, arguments: {}, serverName: "routing" },
              { allowed: false, reason: "Tool is not on the active legacy surface", policy: "routing" },
              [],
              this.sessionId,
              ++this.requestCounter,
              0,
              { traceId, event: "routing", outcome: "invalid_request" },
            );
            return {
              content: [{ type: "text" as const, text: `Unknown tool: ${prefixedName}` }],
              isError: true,
            };
          }

          if (activeWrapperToolNames(compressor).has(prefixedName)) {
            // Whitelist-filter fullTools before passing to handleWrapperTool
            // (pipeline stage 0 logic, applied here for the call path)
            const filteredTools = whitelistFilter(this.config.tools.allow, this.config.tools.deny, (name) =>
              this.serverManager.getLegacyCatalogNames(name),
            )(this.fullTools);
            const wrapperResult = await handleWrapperTool(prefixedName, args, filteredTools, (targetName, targetArgs) =>
              forwardToolCall(targetName, targetArgs, traceId),
            );
            if (wrapperResult) {
              // Audit the wrapper call (for discovery tools that don't go through forwardToolCall)
              const reqId = ++this.requestCounter;
              this.recordAudit(
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
          return await forwardToolCall(prefixedName, receivedArgs, traceId);
        } finally {
          handlerSettled = true;
          if (requestId === undefined) this.endToolCall();
          else releaseCancelledToolCall();
        }
      });

      await this.server.connect(this.trackToolResponses(transport));
    } catch (error) {
      let downstreamCloseErrorType: string | undefined;
      if (this.server) {
        try {
          await this.server.close();
        } catch (closeError) {
          downstreamCloseErrorType = closeError instanceof Error ? closeError.name : "UnknownError";
        }
      }
      let stopReport: { closed: string[]; failed: FailedUpstreamLifecycle[] } = { closed: [], failed: [] };
      let upstreamCloseErrorType: string | undefined;
      try {
        stopReport = await this.serverManager.stop();
      } catch (closeError) {
        upstreamCloseErrorType = closeError instanceof Error ? closeError.name : "UnknownError";
      }
      this.recordLifecycle(
        "start_failed",
        "internal_error",
        {
          errorType: error instanceof Error ? error.name : "UnknownError",
          upstreamClosed: stopReport.closed,
          upstreamCloseFailures: stopReport.failed,
          ...(downstreamCloseErrorType ? { downstreamCloseErrorType } : {}),
          ...(upstreamCloseErrorType ? { upstreamCloseErrorType } : {}),
        },
        Date.now() - lifecycleStarted,
      );
      this.cache?.clear();
      this.cache = null;
      try {
        this.projection?.clear();
        this.native?.clear();
        this.results.clear();
      } catch {
        // A failed optional delivery cleanup cannot trap the runtime in starting.
      }
      this.projection = null;
      this.native = null;
      this.fullTools = [];
      this.server = null;
      this.runtimeState = "stopped";
      this.releaseAdmissionWaiters();
      await this.closeAudit(this.audit);
      throw error;
    }

    this.runtimeState = "running";
    this.releaseAdmissionWaiters();
    this.recordLifecycle(
      startReport.failed.length > 0 ? "ready_degraded" : "ready",
      startReport.failed.length > 0 ? "degraded" : "success",
      {
        configuredServers: startReport.configured,
        connectedUpstreams: startReport.connected,
        failedUpstreams: startReport.failed,
        catalogTools: this.fullTools.length,
        modelFacingTools: this.native ? this.native.listTools().length : this.projection ? 3 : this.fullTools.length,
      },
      Date.now() - lifecycleStarted,
    );
  }

  /**
   * Stop the proxy: close the MCP Server and stop the ServerManager.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopRuntime();
    return this.stopPromise;
  }

  private async stopRuntime(): Promise<void> {
    while (this.runtimeState === "starting" || this.runtimeState === "reloading") {
      await this.waitForAdmission();
    }
    if (this.runtimeState === "stopped") return;
    if (this.runtimeState === "stopping") return;
    this.runtimeState = "stopping";
    this.releaseAdmissionWaiters();
    const lifecycleStarted = Date.now();
    this.recordLifecycle("stopping", "success");
    const drainReport = await this.waitForToolCallsIdle();
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
    const invalidatedResults = this.projection
      ? this.projection.clear().invalidatedResults
      : this.native
        ? this.native.clear()
        : this.results.clear();
    const degraded = downstreamErrorType !== undefined || stopReport.failed.length > 0;
    this.recordLifecycle(
      degraded ? "stopped_degraded" : "stopped",
      degraded ? "degraded" : "success",
      {
        upstreamClosed: stopReport.closed,
        upstreamCloseFailures: stopReport.failed,
        ...(downstreamErrorType ? { downstreamErrorType } : {}),
        invalidatedResults,
        ...drainReport,
      },
      Date.now() - lifecycleStarted,
    );
    this.runtimeState = "stopped";
    this.releaseAdmissionWaiters();
    await this.closeAudit(this.audit);
  }

  /**
   * Hot-reload config and policy pipeline without restarting.
   * Keeps the MCP Server alive — swaps the policy pipeline, audit logger,
   * and server manager (if new ones are provided).
   *
   * @param newConfig - Updated GuardConfig
   * @param newPipeline - New policy pipeline built from the updated config
   * @param newAudit - Optional new audit logger
   * @param newServerManager - Optional new server manager (already started).
   * Ownership transfers only after a successful swap; the caller closes it
   * when reload rejects before the swap.
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
    const nextResults = new ResultCapsuleStore();
    // Prepare every fallible derived object before mutating the active runtime.
    const nextNative =
      this.surface === "native"
        ? this.buildNativeAdapter(newConfig, nextServerManager, nextFullTools, nextResults)
        : null;
    const nextProjection = nextNative
      ? null
      : this.buildProjection(newConfig, nextServerManager, nextFullTools, nextResults);
    const nextCache = newConfig.cache?.enabled ? new ToolCache(newConfig.cache) : null;
    const authorizedCatalogChanged =
      this.toolCatalogSignature(this.authorizedCatalogTools(this.config, this.serverManager, this.fullTools)) !==
      this.toolCatalogSignature(this.authorizedCatalogTools(newConfig, nextServerManager, nextFullTools));
    const modelFacingCatalogChanged =
      this.toolCatalogSignature(
        this.modelFacingTools(this.config, this.serverManager, this.fullTools, this.native, this.projection),
      ) !==
      this.toolCatalogSignature(
        this.modelFacingTools(newConfig, nextServerManager, nextFullTools, nextNative, nextProjection),
      );
    const toolCatalogChanged = authorizedCatalogChanged || modelFacingCatalogChanged;
    if (this.runtimeState !== "running") {
      throw new Error(`Cannot reload while runtime is ${this.runtimeState}`);
    }
    this.runtimeState = "reloading";
    this.reloadBlockedByProjectedDelivery = this.projectedResponseSends.size > 0;
    try {
      const drainReport = await this.waitForToolCallsIdle();
      if (this.reloadBlockedByProjectedDelivery) {
        throw new Error("Cannot reload while projected result response delivery overlaps the reload");
      }
      const previousAudit = this.audit;
      const previousServerManager = this.serverManager;
      const previousProjection = this.projection;
      const previousNative = this.native;
      const previousResults = this.results;
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
      this.results = nextResults;
      this.projection = nextProjection;
      this.native = nextNative;

      let invalidatedResults = 0;
      let invalidationErrorType: string | undefined;
      try {
        invalidatedResults = previousProjection
          ? previousProjection.clear().invalidatedResults
          : previousNative
            ? previousNative.clear()
            : previousResults.clear();
      } catch (error) {
        invalidationErrorType = error instanceof Error ? error.name : "UnknownError";
      }

      let previousUpstreamCloseFailures: FailedUpstreamLifecycle[] = [];
      let previousUpstreamCloseErrorType: string | undefined;
      if (newServerManager && previousServerManager !== nextServerManager) {
        try {
          previousUpstreamCloseFailures = (await previousServerManager.stop()).failed;
        } catch (error) {
          previousUpstreamCloseErrorType = error instanceof Error ? error.name : "UnknownError";
        }
      }
      let listChangedNotificationErrorType: string | undefined;
      if (toolCatalogChanged) {
        try {
          if (!this.server) throw new Error("Downstream MCP server is unavailable");
          await this.server.sendToolListChanged();
        } catch (error) {
          listChangedNotificationErrorType = error instanceof Error ? error.name : "UnknownError";
        }
      }
      const degraded =
        invalidationErrorType !== undefined ||
        previousUpstreamCloseErrorType !== undefined ||
        previousUpstreamCloseFailures.length > 0 ||
        listChangedNotificationErrorType !== undefined;
      this.recordLifecycle(degraded ? "reloaded_degraded" : "reloaded", degraded ? "degraded" : "success", {
        ...lifecycleMetadata,
        catalogTools: this.fullTools.length,
        toolCatalogChanged,
        invalidatedResults,
        ...drainReport,
        upstreamCloseFailures: previousUpstreamCloseFailures,
        ...(invalidationErrorType ? { invalidationErrorType } : {}),
        ...(previousUpstreamCloseErrorType ? { previousUpstreamCloseErrorType } : {}),
        ...(listChangedNotificationErrorType ? { listChangedNotificationErrorType } : {}),
      });
      if (previousAudit !== this.audit) {
        await this.closeAudit(previousAudit);
      }
    } finally {
      this.reloadBlockedByProjectedDelivery = false;
      if (this.runtimeState === "reloading") this.runtimeState = "running";
      this.releaseAdmissionWaiters();
    }
  }

  private newAuditSession(): string {
    try {
      return this.audit.newSession();
    } catch {
      return "s_audit_unavailable";
    }
  }

  private newAuditTrace(): string {
    try {
      return this.audit.newTrace();
    } catch {
      this.fallbackTraceCounter += 1;
      return `t_audit_unavailable_${this.fallbackTraceCounter}`;
    }
  }

  private recordAudit(...args: Parameters<AuditLogger["log"]>): boolean {
    try {
      const [ctx, result, trail, sessionId, requestId, durationMs, details] = args;
      return (
        this.audit.log({ ...ctx, arguments: {} }, result, trail, sessionId, requestId, durationMs, details) !== false
      );
    } catch {
      // Audit adapters are observers. They cannot change routing, execution,
      // delivery, recovery, or the result returned to the Host.
      return false;
    }
  }

  private recordDiscovery(...args: Parameters<AuditLogger["logDiscovery"]>): void {
    try {
      this.audit.logDiscovery(...args);
    } catch {
      // Discovery remains available when an audit adapter fails.
    }
  }

  private async closeAudit(audit: AuditLogger): Promise<void> {
    try {
      await audit.close();
    } catch {
      // Closing an observer is best-effort.
    }
  }

  recordLifecycle(
    state: string,
    outcome: Extract<AuditOutcome, "success" | "degraded" | "internal_error">,
    metadata: Record<string, unknown> = {},
    durationMs = 0,
  ): void {
    this.recordAudit(
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

  private beginToolCall(requestId?: RequestId): void {
    this.inFlightToolCalls += 1;
    if (requestId !== undefined) {
      this.pendingToolResponses.set(requestId, (this.pendingToolResponses.get(requestId) ?? 0) + 1);
    }
  }

  private endToolCall(requestId?: RequestId): void {
    if (requestId !== undefined) {
      const count = this.pendingToolResponses.get(requestId) ?? 0;
      if (count === 0) return;
      if (count === 1) this.pendingToolResponses.delete(requestId);
      else this.pendingToolResponses.set(requestId, count - 1);
    }
    this.inFlightToolCalls = Math.max(0, this.inFlightToolCalls - 1);
    if (this.inFlightToolCalls !== 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private requestIdFromExtra(extra: unknown): RequestId | undefined {
    if (!extra || typeof extra !== "object") return undefined;
    const requestId = (extra as { requestId?: unknown }).requestId;
    return typeof requestId === "string" || typeof requestId === "number" ? requestId : undefined;
  }

  private abortSignalFromExtra(extra: unknown): AbortSignal | undefined {
    if (!extra || typeof extra !== "object") return undefined;
    const signal = (extra as { signal?: unknown }).signal;
    if (!signal || typeof signal !== "object") return undefined;
    const candidate = signal as Partial<AbortSignal>;
    return typeof candidate.aborted === "boolean" && typeof candidate.addEventListener === "function"
      ? (signal as AbortSignal)
      : undefined;
  }

  private beginToolResponseSend(requestId: RequestId): void {
    this.toolResponseSends.set(requestId, (this.toolResponseSends.get(requestId) ?? 0) + 1);
  }

  private endToolResponseSend(requestId: RequestId): void {
    const count = this.toolResponseSends.get(requestId) ?? 0;
    if (count <= 1) this.toolResponseSends.delete(requestId);
    else this.toolResponseSends.set(requestId, count - 1);
  }

  private isToolResponseSending(requestId: RequestId): boolean {
    return (this.toolResponseSends.get(requestId) ?? 0) > 0;
  }

  private beginProjectedResponseSend(requestId: RequestId): void {
    this.projectedResponseSends.set(requestId, (this.projectedResponseSends.get(requestId) ?? 0) + 1);
    if (this.runtimeState === "reloading") {
      this.reloadBlockedByProjectedDelivery = true;
    }
  }

  private endProjectedResponseSend(requestId: RequestId): void {
    const count = this.projectedResponseSends.get(requestId) ?? 0;
    if (count <= 1) this.projectedResponseSends.delete(requestId);
    else this.projectedResponseSends.set(requestId, count - 1);
  }

  private trackToolResponses(transport: Transport): Transport {
    if (typeof transport.send !== "function") return transport;
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      const responseId = this.isResponse(message) ? message.id : undefined;
      const projected = responseId !== undefined && this.isProjectedResultResponse(message);
      if (responseId !== undefined) this.beginToolResponseSend(responseId);
      if (projected) this.beginProjectedResponseSend(responseId);
      try {
        await send(message, options);
      } finally {
        if (responseId !== undefined) {
          if (projected) this.endProjectedResponseSend(responseId);
          this.endToolResponseSend(responseId);
          this.endToolCall(responseId);
        }
      }
    };
    return transport;
  }

  private isResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId } {
    return "id" in message && ("result" in message || "error" in message);
  }

  private isProjectedResultResponse(message: JSONRPCMessage): boolean {
    if (!this.isResponse(message) || !("result" in message)) return false;
    const result = message.result;
    if (!result || typeof result !== "object" || !("structuredContent" in result)) return false;
    const structuredContent = result.structuredContent;
    return (
      structuredContent !== null &&
      typeof structuredContent === "object" &&
      "result_ref" in structuredContent &&
      typeof structuredContent.result_ref === "string"
    );
  }

  private async waitForAdmission(): Promise<void> {
    if (this.runtimeState !== "starting" && this.runtimeState !== "reloading") return;
    await new Promise<void>((resolve) => {
      this.admissionWaiters.add(resolve);
    });
  }

  private isReloading(): boolean {
    return this.runtimeState === "reloading";
  }

  private releaseAdmissionWaiters(): void {
    const waiters = [...this.admissionWaiters];
    this.admissionWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private async waitForToolCallsIdle(): Promise<{
    inFlightAtWait: number;
    drainDurationMs: number;
  }> {
    const started = Date.now();
    const inFlightAtWait = this.inFlightToolCalls;
    if (inFlightAtWait > 0) {
      await new Promise<void>((resolve) => {
        this.idleWaiters.add(resolve);
      });
    }
    return {
      inFlightAtWait,
      drainDurationMs: Date.now() - started,
    };
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

  private modelFacingTools(
    config: GuardConfig,
    serverManager: ServerManager,
    fullTools: Tool[],
    native: NativeToolAdapter | null,
    projection: SecureProjectionKernel | null,
  ): Tool[] {
    if (native) return native.listTools();
    if (projection) return projection.listTools();
    const compressor = config.compressor ?? { enabled: false, level: "off" as const };
    return generateTools(fullTools, compressor, config.tools.allow, config.tools.deny, (name) =>
      serverManager.getLegacyCatalogNames(name),
    );
  }

  private authorizedCatalogTools(config: GuardConfig, serverManager: ServerManager, fullTools: Tool[]): Tool[] {
    return whitelistFilter(config.tools.allow, config.tools.deny, (name) => serverManager.getLegacyCatalogNames(name))(
      fullTools,
    );
  }

  private toolCatalogSignature(tools: Tool[]): string {
    return JSON.stringify([...tools].sort((left, right) => left.name.localeCompare(right.name)));
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
    results: ResultCapsuleStore = this.results,
  ): SecureProjectionKernel | null {
    const compressor = config.compressor ?? { enabled: false, level: "off" as const };
    if (!usesSecureProjection(compressor)) {
      return null;
    }

    const allow = config.tools.allow.filter(Boolean);
    const deny = config.tools.deny.filter(Boolean);
    const authorizedTools =
      allow.length === 0
        ? []
        : whitelistFilter(allow, deny, (name) => serverManager.getLegacyCatalogNames(name))(fullTools);
    // A flattened legacy name can collide when server and tool names both
    // contain underscores. Never advertise a reference that cannot resolve to
    // exactly one catalog route.
    const visibleTools = authorizedTools.filter((tool) => serverManager.resolveTool(tool.name) !== null);
    return new SecureProjectionKernel(visibleTools, results);
  }

  private buildNativeAdapter(
    config: GuardConfig,
    serverManager: ServerManager,
    fullTools: Tool[],
    results: ResultCapsuleStore = this.results,
  ): NativeToolAdapter {
    const authorizedNames = new Set(
      whitelistFilter(config.tools.allow, config.tools.deny, (name) => serverManager.getLegacyCatalogNames(name))(
        fullTools,
      ).map((tool) => tool.name),
    );
    const managerWithNativeTools = serverManager as ServerManager & {
      getNativeTools?: () => NativeToolRoute[];
    };
    const routes = managerWithNativeTools.getNativeTools
      ? managerWithNativeTools.getNativeTools().filter((route) => authorizedNames.has(route.catalogName))
      : fullTools.flatMap((tool) => {
          const resolved = serverManager.resolveTool(tool.name);
          return resolved
            ? [
                {
                  catalogName: tool.name,
                  serverName: resolved.serverName,
                  originalToolName: resolved.originalToolName,
                  tool,
                },
              ]
            : [];
        });
    return new NativeToolAdapter(results, routes);
  }
}
