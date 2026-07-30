#!/usr/bin/env node

/**
 * MCP Guard — CLI entry point
 *
 * Commander-based CLI for mcp-slim-guard.
 * Supports: init, start, status, log, uninit
 *
 * @module cli
 */

import { Command, Option } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { ConfigLoader } from "./config-loader.js";
import { VERSION } from "./version.js";
import type { GuardConfig } from "./config-types.js";
import type { Policy, PolicyResult } from "./types.js";
import { PolicyPipeline } from "./policies/base.js";
import { WhitelistPolicy } from "./policies/whitelist.js";
import { SSRFPolicy } from "./policies/ssrf.js";
import { RateLimitPolicy } from "./policies/ratelimit.js";
import { InjectionPolicy } from "./policies/injection.js";
import { AuditLogger, type AuditLoggerOptions } from "./audit.js";
import { ServerManager } from "./server-manager.js";
import { GuardProxy } from "./proxy.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as http from "node:http";
import micromatch from "micromatch";
import { generateTools, whitelistFilter } from "./compressor.js";
import {
  CALL_TOOL,
  FIND_TOOL,
  READ_RESULT,
  SecureProjectionKernel,
  usesSecureProjection,
} from "./secure-projection.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildAnalyzeReport } from "./analyze.js";
import { buildCodexConfigPlan } from "./codex-config-plan.js";
import { buildClaudeConfigPlan } from "./claude-config-plan.js";
import { buildRuntimeProfile, parseAuditLog, type RuntimeProfileReport } from "./profile.js";
import { buildHostInstallationSpec } from "./host-installation.js";
import {
  installTransaction,
  rollbackTransaction,
  type InstallationHost,
  type InstallationTransactionRecord,
} from "./installation-transaction.js";

interface AuditDisplayEntry {
  timestamp?: string;
  traceId?: string;
  requestId?: number;
  toolName?: string;
  serverName?: string;
  action?: string;
  event?: string;
  outcome?: string;
  reason?: string;
  durationMs?: number;
}

function auditIcon(entry: AuditDisplayEntry): string {
  if (["upstream_error", "fail_open", "degraded"].includes(entry.outcome ?? "")) return "⚠️";
  if (entry.outcome === "projected") return "📦";
  if (entry.event === "recovery" && ["chunk", "complete"].includes(entry.outcome ?? "")) return "📖";
  if (entry.outcome === "cache_hit") return "♻️";
  if (entry.event === "discovery") return "🔎";
  if (
    entry.action === "blocked" ||
    ["blocked", "invalid_request", "transport_error", "internal_error", "rejected"].includes(entry.outcome ?? "")
  ) {
    return "🚫";
  }
  return "✅";
}

function formatAuditEntry(entry: AuditDisplayEntry, compact = false): string {
  const timestamp = compact ? entry.timestamp?.slice(11, 19) : entry.timestamp?.slice(0, 19);
  const location = compact ? entry.toolName : `${entry.serverName ?? "?"}:${entry.toolName ?? "?"}`;
  const stage = entry.event ?? entry.action ?? "event";
  const outcome = entry.outcome ? `/${entry.outcome}` : "";
  const trace = entry.traceId ? ` [${entry.traceId.slice(0, 10)}]` : "";
  const request = entry.requestId !== undefined ? ` #${entry.requestId}` : "";
  const duration = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : "";
  const reason = entry.reason ? ` — ${entry.reason}` : "";
  return `${auditIcon(entry)} [${timestamp ?? "?"}]${trace}${request} ${location ?? "?"} → ${stage}${outcome}${duration}${reason}`;
}

function formatProfileSize(label: string, value: { characters: number; estimatedTokens: number }): void {
  console.log(
    `  ${label}: ${value.characters.toLocaleString()} chars (~${value.estimatedTokens.toLocaleString()} est. tokens)`,
  );
}

function displayRuntimeProfile(report: RuntimeProfileReport): void {
  console.log("Slim Guard runtime profile (latest segment)\n");
  console.log(`  Coverage: ${report.segment.coverage}`);
  console.log(`  Lifecycle: ${report.segment.lifecycle.join(" -> ") || "unknown"}`);
  if (report.catalog.direct) {
    formatProfileSize("Direct catalog", report.catalog.direct);
    console.log(`    Tools: ${report.catalog.direct.tools}`);
  } else {
    console.log("  Direct catalog: unknown");
  }
  if (report.catalog.hostFacing) {
    formatProfileSize("Host-facing catalog", report.catalog.hostFacing);
    console.log(`    Tools: ${report.catalog.hostFacing.tools}`);
  } else {
    console.log("  Host-facing catalog: unknown");
  }
  console.log(
    `  Results observed: ${report.delivery.observedResults} (${report.delivery.measuredResults} fully measured)`,
  );
  formatProfileSize("Upstream result payload", report.delivery.upstream);
  formatProfileSize("Host-delivered result payload", report.delivery.host);
  console.log(
    `  Outcomes: projected ${report.delivery.outcomes.projected}, pass-through ${report.delivery.outcomes.pass_through}, fail-open ${report.delivery.outcomes.fail_open}`,
  );
  console.log(
    `  Recovery: verified at delivery ${report.recovery.verifiedAtDelivery}, fully read ${report.recovery.fullyRead}, evicted ${report.recovery.evicted}, unknown ${report.recovery.unknown}`,
  );
  if (report.delivery.largestSources.length > 0) {
    console.log("  Largest result sources:");
    for (const source of report.delivery.largestSources) {
      console.log(
        `    ${source.serverName}:${source.toolName} (${source.results} result(s), ${source.upstream.characters.toLocaleString()} -> ${source.host.characters.toLocaleString()} chars)`,
      );
    }
  }
  console.log("  Unknown: Host-to-model input, provider billing, repeated-payload savings, durable recovery");
  if (report.audit.reasons.length > 0) console.log(`  Coverage notes: ${report.audit.reasons.join(", ")}`);
}

function installationSummary(
  record: InstallationTransactionRecord,
  mode: "installed" | "rolled_back",
  status: "installed" | "rolled_back" | "already_rolled_back" = mode,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/installation",
    mode,
    status,
    host: record.host,
    targetPath: record.targetPath,
    transactionId: record.transactionId,
    transactionRecord: record.recordPath,
    backup: record.backupPath
      ? { created: true, path: record.backupPath }
      : { created: false, reason: "target_absent" },
    beforeSha256: record.beforeSha256,
    afterSha256: record.afterSha256,
    validation: mode === "installed" ? "passed" : "restored_exact_before_sha256",
    writesPerformed: mode === "installed" || status === "rolled_back" ? 1 : 0,
  };
}

function displayInstallation(summary: Record<string, unknown>): void {
  const mode = summary.mode === "installed" ? "Installed" : "Rolled back";
  console.log(`✓ ${mode} ${String(summary.host)} configuration`);
  console.log(`  Target: ${String(summary.targetPath)}`);
  console.log(`  Transaction: ${String(summary.transactionRecord)}`);
  const backup = summary.backup as { created?: boolean; path?: string; reason?: string };
  console.log(`  Backup: ${backup.created ? backup.path : (backup.reason ?? "not created")}`);
  if (summary.status === "already_rolled_back") console.log("  Status: already rolled back");
  else console.log(`  Validation: ${String(summary.validation)}`);
}

/**
 * Build a human-readable list of enabled policy names from config.
 */
function buildPolicyList(config: GuardConfig): string[] {
  const list: string[] = [];
  if (config.tools.allow.length > 0 || config.tools.deny.length > 0) {
    list.push("whitelist");
  }
  if (config.ssrf.mode !== "off") {
    list.push("ssrf");
  }
  list.push("ratelimit");
  if (config.injection_detection.enabled) {
    list.push(`injection:${config.injection_detection.sensitivity ?? "medium"}`);
  }
  if (config.compressor?.enabled) {
    if (usesSecureProjection(config.compressor)) {
      list.push("compact-tools");
    } else {
      const lazy = config.compressor.lazy_loading ? "+lazy" : "";
      list.push(`legacy-compressor:${config.compressor.level}${lazy}`);
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// Schema stats — real MCP data + transparent token estimation
// ---------------------------------------------------------------------------

interface SchemaStats {
  totalTools: number;
  fullSchemaTools: number;
  slimSchemaTools: number;
  compactTools: number;
  rawChars: number;
  compressedChars: number;
  reductionPct: number;
}

function computeSchemaStats(rawTools: Tool[], compressedTools: Tool[]): SchemaStats {
  const compactNames = new Set([FIND_TOOL, CALL_TOOL, READ_RESULT]);
  const compactTools = compressedTools.filter((tool) => compactNames.has(tool.name)).length;
  const slimTools = compressedTools.filter(
    (t) =>
      !compactNames.has(t.name) &&
      !t.name.startsWith("mcp__") &&
      (!t.inputSchema?.properties || Object.keys(t.inputSchema.properties).length === 0),
  ).length;
  const fullTools = compressedTools.length - compactTools - slimTools;

  const rawChars = rawTools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
  const compressedChars = compressedTools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
  const reductionPct = rawChars > 0 ? Math.round((1 - compressedChars / rawChars) * 100) : 0;

  return {
    totalTools: compressedTools.length,
    fullSchemaTools: fullTools,
    slimSchemaTools: slimTools,
    compactTools,
    rawChars,
    compressedChars,
    reductionPct,
  };
}

function displaySchemaStats(stats: SchemaStats): void {
  console.log(`\n📊 MCP tool schema:`);
  console.log(`  Tools: ${stats.totalTools} total`);
  if (stats.fullSchemaTools > 0) console.log(`    ├─ Full schema:  ${stats.fullSchemaTools} (complete inputSchema)`);
  if (stats.slimSchemaTools > 0)
    console.log(`    ├─ Slim schema:  ${stats.slimSchemaTools} (name + desc, schema on demand)`);
  if (stats.compactTools > 0)
    console.log(`    └─ Compact:      ${stats.compactTools} (${FIND_TOOL}, ${CALL_TOOL}, ${READ_RESULT})`);
  const estTokens = (chars: number) => Math.ceil(chars / 4);
  console.log(
    `\n  Characters: ${stats.rawChars.toLocaleString()} → ${stats.compressedChars.toLocaleString()} (${stats.reductionPct}% reduction)`,
  );
  console.log(
    `  Est. tokens: ~${estTokens(stats.rawChars).toLocaleString()} → ~${estTokens(stats.compressedChars).toLocaleString()} (${stats.reductionPct}% reduction)`,
  );
}

function projectToolsForDisplay(rawTools: Tool[], config: GuardConfig): Tool[] {
  const compressor = config.compressor ?? { enabled: false, level: "off" as const };
  if (usesSecureProjection(compressor)) {
    const visible =
      config.tools.allow.length === 0 ? [] : whitelistFilter(config.tools.allow, config.tools.deny)(rawTools);
    return new SecureProjectionKernel(visible).listTools();
  }
  return generateTools(rawTools, compressor, config.tools.allow, config.tools.deny);
}

/**
 * Create policy instances from guard config.
 */
function createPolicies(config: GuardConfig): Policy[] {
  const policies: Policy[] = [new WhitelistPolicy(config.tools)];

  if (config.ssrf.mode !== "off") {
    policies.push(new SSRFPolicy(config.ssrf));
  }

  if (config.injection_detection.enabled) {
    policies.push(new InjectionPolicy(config.injection_detection));
  }

  policies.push(new RateLimitPolicy(config.rate_limit));

  return policies;
}

/**
 * Build AuditLogger options from the audit config, forwarding ALL options
 * (maxSize/maxFiles/compress/maxMemoryEntries) — previously only output and
 * filePath were passed, so rotation settings in the config were silently dead.
 */
export function buildAuditOptions(auditCfg: NonNullable<GuardConfig["audit"]>, cwd: string): AuditLoggerOptions {
  const opts: AuditLoggerOptions = {
    output: auditCfg.output,
  };
  if (auditCfg.output === "file") {
    opts.filePath = auditCfg.filePath ?? path.join(cwd, "mcp-slim-guard-audit.log");
    if (auditCfg.maxSize) opts.maxSize = auditCfg.maxSize;
    if (auditCfg.maxFiles !== undefined) opts.maxFiles = auditCfg.maxFiles;
    if (auditCfg.compress !== undefined) opts.compress = auditCfg.compress;
  }
  if ((auditCfg as { maxMemoryEntries?: number }).maxMemoryEntries !== undefined) {
    opts.maxMemoryEntries = (auditCfg as { maxMemoryEntries?: number }).maxMemoryEntries;
  }
  return opts;
}

/**
 * CLI entry point. Parses argv and executes the appropriate command.
 *
 * @param argv - Command-line arguments (defaults to process.argv)
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("mcp-slim-guard")
    .version(VERSION)
    .description("MCP context compression runtime — compress what agents see, preserve what tools do");

  program
    .command("plan")
    .description("Generate a Host configuration plan without writing it")
    .addOption(new Option("--host <host>", "Target Host").choices(["codex", "claude-code"]).makeOptionMandatory())
    .action((options: { host: "codex" | "claude-code" }) => {
      const plan =
        options.host === "codex" ? buildCodexConfigPlan(process.cwd()) : buildClaudeConfigPlan(process.cwd());
      console.log(JSON.stringify(plan, null, 2));
    });

  program
    .command("install")
    .description("Apply one bounded Host configuration transaction with a pre-write backup")
    .addOption(new Option("--host <host>", "Target Host").choices(["codex", "claude-code"]).makeOptionMandatory())
    .option("--json", "Emit machine-readable transaction evidence")
    .action((options: { host: InstallationHost; json?: boolean }) => {
      const cwd = process.cwd();
      try {
        const spec = buildHostInstallationSpec(cwd, options.host);
        if (!spec.plan.preconditions.guardConfigExists) {
          throw new Error(
            `Guard configuration not found at ${spec.plan.preconditions.guardConfigPath}. Run 'mcp-slim-guard init' first.`,
          );
        }
        const result = installTransaction(spec);
        const summary = installationSummary(result.record, "installed");
        if (options.json) console.log(JSON.stringify(summary, null, 2));
        else displayInstallation(summary);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Installation failed."}`);
        process.exit(1);
      }
    });

  program
    .command("rollback")
    .description("Restore the recorded Host configuration if it has not changed")
    .addOption(new Option("--host <host>", "Expected recorded Host").choices(["codex", "claude-code"]))
    .option("--json", "Emit machine-readable transaction evidence")
    .action((options: { host?: InstallationHost; json?: boolean }) => {
      try {
        const result = rollbackTransaction(process.cwd(), options.host);
        const summary = installationSummary(result.record, "rolled_back", result.status);
        if (options.json) console.log(JSON.stringify(summary, null, 2));
        else displayInstallation(summary);
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : "Rollback failed."}`);
        process.exit(1);
      }
    });

  program
    .command("analyze")
    .description("Inspect an MCP catalog without changing configuration or invoking Tools")
    .action(async () => {
      const cwd = process.cwd();
      const mcpConfigPath = ConfigLoader.discoverMCPConfig(cwd);
      if (!mcpConfigPath) {
        console.error("Error: No MCP configuration file found.");
        process.exit(1);
        return;
      }

      const config = ConfigLoader.generateGuardConfig(mcpConfigPath);
      const manager = new ServerManager(config.servers);
      try {
        const startReport = await manager.start();
        const directTools = manager.getTools();
        const slimGuardTools = projectToolsForDisplay(directTools, config);
        console.log(JSON.stringify(buildAnalyzeReport(startReport, directTools, slimGuardTools), null, 2));
      } finally {
        await manager.stop();
      }
    });

  program
    .command("profile")
    .description("Read bounded runtime delivery evidence without invoking Tools")
    .option("--last", "Read the latest runtime segment")
    .option("--json", "Emit deterministic machine-readable JSON")
    .action((options: { last?: boolean; json?: boolean }) => {
      if (!options.last) {
        console.error("Error: profile requires --last.");
        process.exit(1);
        return;
      }

      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-slim-guard.yml not found. Run 'mcp-slim-guard init' first.");
        process.exit(1);
        return;
      }
      const auditConfig = config.audit;
      if (!auditConfig || auditConfig.output !== "file") {
        console.error("Error: profile requires audit output configured as a local file.");
        process.exit(1);
        return;
      }

      const logFile = path.resolve(cwd, auditConfig.filePath ?? "mcp-slim-guard-audit.log");
      if (!fs.existsSync(logFile)) {
        console.error(`Error: No audit log found at ${logFile}`);
        process.exit(1);
        return;
      }

      const parsed = parseAuditLog(fs.readFileSync(logFile, "utf-8"));
      const maxFiles = auditConfig.maxFiles ?? 5;
      const rotatedFiles = Array.from({ length: Math.max(0, maxFiles) }, (_, index) => index + 1).filter(
        (index) => fs.existsSync(`${logFile}.${index}`) || fs.existsSync(`${logFile}.${index}.gz`),
      ).length;
      const report = buildRuntimeProfile(parsed.entries, {
        parsedLines: parsed.parsedLines,
        malformedLines: parsed.malformedLines,
        rotatedFiles,
      });
      if (!report) {
        console.error("Error: No runtime segment found in the audit log.");
        process.exit(1);
        return;
      }

      if (options.json) console.log(JSON.stringify(report, null, 2));
      else displayRuntimeProfile(report);
    });

  program
    .command("init")
    .description("Auto-discover MCP config and generate mcp-slim-guard.yml")
    .addOption(
      new Option("--compressor [level]", "Legacy compatibility: override the automatic compact interface").hideHelp(),
    )
    .addOption(new Option("--lazy", "Legacy compatibility: enable lazy schema loading").hideHelp())
    .addOption(new Option("--lazy-budget <n>", "Legacy compatibility: lazy schema budget").default("8").hideHelp())
    .action((options: { compressor?: string; lazy?: boolean; lazyBudget?: string }) => {
      const cwd = process.cwd();
      const mcpConfigPath = ConfigLoader.discoverMCPConfig(cwd);

      if (!mcpConfigPath) {
        console.error("Error: No MCP configuration file found.");
        console.error(
          "Expected one of: .mcp.json, mcp.json, claude_desktop_config.json, .cursor/mcp.json, .vscode/mcp.json",
        );
        process.exit(1);
        return;
      }

      const guardConfig = ConfigLoader.generateGuardConfig(mcpConfigPath);

      // Apply compressor setting
      if (options.compressor) {
        if (options.compressor === "off") {
          guardConfig.compressor = { enabled: false, level: "off" };
        } else {
          const level = options.compressor as "light" | "normal" | "extreme" | "maximum";
          guardConfig.compressor = { enabled: true, level };
        }
      }

      // Apply lazy loading
      if (options.lazy) {
        guardConfig.compressor.lazy_loading = true;
        const budget = parseInt(options.lazyBudget ?? "8", 10);
        if (!isNaN(budget)) guardConfig.compressor.lazy_budget = budget;
      }

      const ymlPath = path.join(cwd, "mcp-slim-guard.yml");
      const ymlContent = yaml.dump(guardConfig as unknown as Record<string, unknown>);
      fs.writeFileSync(ymlPath, ymlContent, "utf-8");

      const serverCount = Object.keys(guardConfig.servers).length;
      const policyList = buildPolicyList(guardConfig);

      console.log("✅ Generated mcp-slim-guard.yml");
      console.log(`   Servers: ${serverCount}`);
      console.log(`   Policies: ${policyList.join(", ")}`);
      console.log(`   SSRF: ${guardConfig.ssrf.mode}`);
      console.log(`   Rate limit: ${guardConfig.rate_limit.default}`);
      const auditOut = guardConfig.audit?.output ?? "file";
      const auditPath = guardConfig.audit?.filePath ?? "mcp-slim-guard-audit.log";
      const auditMax = guardConfig.audit?.maxSize ?? "10MB";
      const auditFiles = guardConfig.audit?.maxFiles ?? 5;
      const auditGzip = guardConfig.audit?.compress ? ", gzip" : "";
      console.log(
        `   Audit: ${auditOut}${auditOut === "file" ? ` (${auditPath}, maxSize: ${auditMax}, maxFiles: ${auditFiles}${auditGzip})` : ""}`,
      );

      if (usesSecureProjection(guardConfig.compressor)) {
        console.log(`   Model interface: ${FIND_TOOL}, ${CALL_TOOL}, ${READ_RESULT}`);
      } else {
        console.log(`   Legacy compressor: ${guardConfig.compressor.level}`);
      }
    });

  program
    .command("start")
    .description("Start the guard proxy")
    .option("--http", "Use HTTP transport instead of STDIO")
    .option("--port <port>", "HTTP port (default: 3000)", "3000")
    .addOption(
      new Option("--surface <surface>", "Model-facing Tool surface").choices(["generic", "native"]).default("generic"),
    )
    .action(async (options: { http?: boolean; port: string; surface: "generic" | "native" }) => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-slim-guard.yml not found. Run 'mcp-slim-guard init' first.");
        process.exit(1);
        return;
      }

      // Use config.audit with defaults; forward ALL rotation/memory options
      const auditCfg = config.audit ?? { output: "file" as const, filePath: "mcp-slim-guard-audit.log" };
      const configuredAuditOptions = buildAuditOptions(auditCfg, cwd);
      const auditOptions: AuditLoggerOptions =
        !options.http && configuredAuditOptions.output === "stdout"
          ? { ...configuredAuditOptions, output: "stderr" }
          : configuredAuditOptions;
      const audit = new AuditLogger(auditOptions);
      let serverManager = new ServerManager(config.servers);
      const policies = createPolicies(config);
      const pipeline = new PolicyPipeline(policies);
      const proxy = new GuardProxy(config, pipeline, audit, serverManager, {
        surface: options.surface,
      });

      // Choose transport
      const transport = options.http
        ? new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // let the SDK handle it
          })
        : new StdioServerTransport();

      await proxy.start(transport);

      const runtimeLog = options.http ? console.log : console.error;
      runtimeLog("🛡️ mcp-slim-guard started");

      const serverCount = Object.keys(config.servers).length;
      // Get tools for schema stats (serverManager already started by proxy.start)
      try {
        const startTools = serverManager.getTools();
        if (startTools && startTools.length > 0 && config.compressor?.enabled && config.compressor.level !== "off") {
          const compressed = projectToolsForDisplay(startTools, config);
          const stats = computeSchemaStats(startTools, compressed);
          const estTokens = (chars: number) => Math.ceil(chars / 4);
          runtimeLog(
            `   ${serverCount} servers, ${stats.totalTools} tools (${estTokens(stats.compressedChars)} est. tokens, ${stats.reductionPct}% saved)`,
          );
        }
      } catch {
        // Schema stats unavailable — skip (e.g., mock or server not connected)
      }

      let httpServer: http.Server | undefined;
      if (options.http) {
        const port = parseInt(options.port, 10);
        const httpTransport = transport as StreamableHTTPServerTransport;
        // Create HTTP server to handle incoming requests
        httpServer = http.createServer((req, res) => {
          // Only handle POST /mcp
          if (req.method !== "POST" || req.url !== "/mcp") {
            res.writeHead(405).end("Method Not Allowed");
            return;
          }
          // Collect body
          const chunks: Buffer[] = [];
          void (async () => {
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const body = Buffer.concat(chunks);
            try {
              await (httpTransport as StreamableHTTPServerTransport).handleRequest(req, res, body);
            } catch (err) {
              console.error("HTTP handler error:", err instanceof Error ? err.name : "UnknownError");
              if (!res.headersSent) {
                res.writeHead(500).end("Internal Server Error");
              }
            }
          })();
        });
        httpServer.listen(port, "127.0.0.1", () => {
          runtimeLog(`   HTTP transport: http://127.0.0.1:${port}/mcp`);
          runtimeLog("   Use this URL in your MCP client config");
        });
      } else {
        runtimeLog("   Listening on STDIO transport");
      }
      runtimeLog(
        `   Audit log: ${
          auditCfg.output === "file"
            ? (auditCfg.filePath ?? path.join(cwd, "mcp-guard-audit.log"))
            : options.http
              ? "stdout"
              : "stderr"
        }`,
      );
      runtimeLog("   Send SIGHUP to reload config (kill -HUP <pid>)");

      let reloadInFlight = false;
      let reloadTask: Promise<void> | undefined;
      let shuttingDown = false;
      const monitorFatal = (error: Error, origin: NodeJS.UncaughtExceptionOrigin): void => {
        proxy.recordLifecycle("fatal_error", "internal_error", {
          errorType: error.name,
          origin,
        });
      };
      process.on("uncaughtExceptionMonitor", monitorFatal);

      // SIGHUP → hot reload mcp-slim-guard.yml (rebuilds pipeline + audit + serverManager)
      process.on("SIGHUP", () => {
        if (reloadInFlight || shuttingDown) {
          proxy.recordLifecycle("reload_skipped", "degraded", {
            reason: shuttingDown ? "shutdown_in_progress" : "reload_in_progress",
          });
          return;
        }
        reloadInFlight = true;
        const task = (async () => {
          const reloadStarted = Date.now();
          proxy.recordLifecycle("reloading", "success");
          let candidateManager: ServerManager | undefined;
          let candidateAudit: AuditLogger | undefined;
          try {
            const newConfig = ConfigLoader.findAndLoad(cwd);
            if (!newConfig) {
              proxy.recordLifecycle("reload_failed", "internal_error", {
                errorType: "ConfigNotFound",
              });
              console.error("⚠️ [reload] mcp-slim-guard.yml not found — keeping old config");
              return;
            }
            // Connect the candidate runtime before touching the active one.
            candidateManager = new ServerManager(newConfig.servers);
            const startReport = await candidateManager.start();
            if (startReport.configured > 0 && startReport.connected.length === 0) {
              await candidateManager.stop();
              candidateManager = undefined;
              throw new Error("No configured upstream server connected");
            }
            if (shuttingDown) {
              await candidateManager.stop();
              candidateManager = undefined;
              proxy.recordLifecycle("reload_skipped", "degraded", {
                reason: "shutdown_in_progress",
              });
              return;
            }
            const newPolicies = createPolicies(newConfig);
            const newPipeline = new PolicyPipeline(newPolicies);
            // Rebuild audit logger — forward ALL rotation/memory options
            const newAuditCfg = newConfig.audit ?? { output: "file" as const, filePath: "mcp-slim-guard-audit.log" };
            const configuredNewAuditOptions = buildAuditOptions(newAuditCfg, cwd);
            const newAuditOptions: AuditLoggerOptions =
              !options.http && configuredNewAuditOptions.output === "stdout"
                ? { ...configuredNewAuditOptions, output: "stderr" }
                : configuredNewAuditOptions;
            candidateAudit = new AuditLogger(newAuditOptions);
            await proxy.reload(newConfig, newPipeline, candidateAudit, candidateManager, {
              configuredServers: startReport.configured,
              connectedUpstreams: startReport.connected,
              failedUpstreams: startReport.failed,
              reloadDurationMs: Date.now() - reloadStarted,
            });
            candidateAudit = undefined;
            serverManager = candidateManager;
            candidateManager = undefined;
            runtimeLog("✅ [reload] Config reloaded — new policies + servers + audit active");
          } catch (err) {
            await candidateManager?.stop();
            await candidateAudit?.close();
            proxy.recordLifecycle("reload_failed", "internal_error", {
              errorType: err instanceof Error ? err.name : "UnknownError",
            });
            console.error("⚠️ [reload] Failed:", err instanceof Error ? err.name : "UnknownError");
          } finally {
            reloadInFlight = false;
          }
        })();
        reloadTask = task;
        void task.finally(() => {
          if (reloadTask === task) reloadTask = undefined;
        });
      });

      type ShutdownTrigger = "SIGINT" | "SIGTERM" | "STDIN_END";
      const shutdown = async (signal: ShutdownTrigger): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        runtimeLog(`   ${signal} received — shutting down`);
        await reloadTask;
        const activeHttpServer = httpServer;
        if (activeHttpServer?.listening) {
          await new Promise<void>((resolve) => {
            activeHttpServer.close(() => resolve());
          });
        }
        await proxy.stop();
        process.off("uncaughtExceptionMonitor", monitorFatal);
      };
      const requestShutdown = (signal: ShutdownTrigger): void => {
        void shutdown(signal).catch((error) => {
          proxy.recordLifecycle("shutdown_failed", "internal_error", {
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
          console.error("⚠️ [shutdown] Failed:", error instanceof Error ? error.name : "UnknownError");
          process.exitCode = 1;
        });
      };
      process.once("SIGINT", () => requestShutdown("SIGINT"));
      process.once("SIGTERM", () => requestShutdown("SIGTERM"));
      if (!options.http) {
        process.stdin.once("end", () => requestShutdown("STDIN_END"));
      }
    });

  program
    .command("status")
    .description("Show resolved configuration")
    .action(() => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-slim-guard.yml not found. Run 'mcp-slim-guard init' first.");
        process.exit(1);
        return;
      }

      const serverCount = Object.keys(config.servers).length;

      console.log("🛡️ mcp-slim-guard configuration");
      console.log(`   Config: mcp-slim-guard.yml`);
      console.log(`   Servers: ${serverCount}`);
      for (const [name, server] of Object.entries(config.servers)) {
        if ("command" in server) {
          console.log(`     - ${name}: stdio (${server.command})`);
        } else {
          console.log(`     - ${name}: ${server.type === "sse" ? "legacy SSE" : "Streamable HTTP"}`);
        }
      }

      const policyList = buildPolicyList(config);
      console.log(`   Policies: ${policyList.join(", ")}`);
      console.log(`   SSRF: ${config.ssrf.mode}`);
      console.log(`   Rate limit: ${config.rate_limit.default}`);
      console.log(`   Injection detection: ${config.injection_detection.enabled ? "enabled" : "disabled"}`);
      if (usesSecureProjection(config.compressor)) {
        console.log(`   Model interface: ${FIND_TOOL}, ${CALL_TOOL}, ${READ_RESULT}`);
      } else if (config.compressor?.enabled && config.compressor.level !== "off") {
        console.log(`   Legacy compressor: ${config.compressor.level}`);
      } else {
        console.log("   Compact interface: disabled by legacy config");
      }
      const auditOut = config.audit?.output ?? "file";
      const auditPath = config.audit?.filePath ?? "mcp-slim-guard-audit.log";
      const auditMax = config.audit?.maxSize ?? "10MB";
      const auditFiles = config.audit?.maxFiles ?? 5;
      const auditGzip = config.audit?.compress ? ", gzip" : "";
      console.log(
        `   Audit: ${auditOut}${auditOut === "file" ? ` (${auditPath}, maxSize: ${auditMax}, maxFiles: ${auditFiles}${auditGzip})` : ""}`,
      );
    });

  program
    .command("doctor")
    .description("Diagnose upstream server connectivity and config validity")
    .action(async () => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-slim-guard.yml not found. Run 'mcp-slim-guard init' first.");
        process.exit(1);
      }

      console.log("🩺 mcp-slim-guard doctor\n");
      console.log(`Config: mcp-slim-guard.yml (version ${config.version})`);
      console.log(`Servers: ${Object.keys(config.servers).length}`);
      console.log(`SSRF mode: ${config.ssrf.mode}`);
      console.log(`Rate limit: ${config.rate_limit.default}\n`);

      const policyList = buildPolicyList(config);
      console.log("Policies:", policyList.join(" → "));
      console.log("");

      // Check each upstream server
      const serverNames = Object.keys(config.servers);
      if (serverNames.length === 0) {
        console.log("⚠️  No upstream servers configured.");
        console.log("   Add servers to mcp-slim-guard.yml or run 'mcp-slim-guard init'.");
      }

      let okCount = 0;
      let failCount = 0;

      for (const name of serverNames) {
        const server = config.servers[name];
        process.stdout.write(`  ${name} ... `);
        const manager = new ServerManager({ [name]: server });
        try {
          const startReport = await manager.start();
          if (startReport.connected.length === 0) {
            const errorType = startReport.failed[0]?.errorType ?? "NoConnection";
            await manager.stop();
            console.log(`❌ FAIL — ${errorType}`);
            failCount++;
            continue;
          }

          const tools = manager.getTools();
          const stopReport = await manager.stop();
          if (stopReport.failed.length > 0) {
            console.log(`❌ FAIL — CloseError`);
            failCount++;
            continue;
          }

          const stats = computeSchemaStats(
            tools,
            config.compressor?.enabled && config.compressor.level !== "off"
              ? projectToolsForDisplay(tools, config)
              : tools,
          );
          const estTokens = (chars: number) => Math.ceil(chars / 4);
          const tokenInfo =
            config.compressor?.enabled && config.compressor.level !== "off"
              ? `, ${estTokens(stats.compressedChars)} est. tokens (${stats.reductionPct}% saved)`
              : "";
          console.log(`✅ OK (${tools.length} tools${tokenInfo}: ${tools.map((t) => t.name).join(", ")})`);
          okCount++;
        } catch (err) {
          await manager.stop();
          console.log(`❌ FAIL — ${err instanceof Error ? err.name : "UnknownError"}`);
          failCount++;
        }
      }

      // Config sanity checks
      console.log("\n--- Config checks ---");

      // Check allow patterns
      if (config.tools.allow.length === 0) {
        console.log("  ⚠️  tools.allow is empty — ALL tools will be blocked (fail-closed)");
      } else {
        console.log(`  ✅ tools.allow: ${config.tools.allow.length} pattern(s)`);
      }

      if (config.tools.deny.length > 0) {
        console.log(`  📋 tools.deny: ${config.tools.deny.length} pattern(s) (${config.tools.deny.join(", ")})`);
      }

      // Check SSRF consistency
      if (config.ssrf.mode === "block" && !config.ssrf.block_private_ips) {
        console.log("  ⚠️  SSRF mode is 'block' but block_private_ips is false");
      }

      if (config.ssrf.mode !== "off" && config.ssrf.block_private_ips) {
        console.log("  ✅ SSRF: block mode + private IP blocking active");
      }

      // Check injection detection
      if (config.injection_detection.enabled) {
        console.log(`  📋 Injection detection: enabled (${config.injection_detection.sensitivity})`);
      } else {
        console.log("  ℹ️  Injection detection: disabled");
      }

      // Compressor status
      if (usesSecureProjection(config.compressor)) {
        console.log(`  📦 Model interface: ${FIND_TOOL} → ${CALL_TOOL} → ${READ_RESULT}`);
      } else if (config.compressor?.enabled && config.compressor.level !== "off") {
        const lazyTag = config.compressor.lazy_loading ? " +lazy" : "";
        const mode =
          config.compressor.level === "extreme" || config.compressor.level === "maximum"
            ? "schema transformation"
            : "wrapper tools";
        console.log(`  📦 Schema compressor: ${config.compressor.level}${lazyTag} (${mode})`);
        if (config.compressor.lazy_loading) {
          console.log(`     Lazy loading: budget=${config.compressor.lazy_budget ?? 8}`);
        }
      } else {
        console.log("  ℹ️  Schema compressor: off");
      }

      console.log(`\n🏁 Result: ${okCount} server(s) OK, ${failCount} failed`);

      if (failCount > 0) {
        process.exit(1);
      }
    });

  program
    .command("validate")
    .description("Dry-run: check which tools would be allowed/blocked by current policies")
    .action(async () => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-slim-guard.yml not found. Run 'mcp-slim-guard init' first.");
        process.exit(1);
      }

      console.log("🔍 mcp-slim-guard validate — dry-run policy check\n");

      const serverNames = Object.keys(config.servers);
      if (serverNames.length === 0) {
        console.log("⚠️  No upstream servers configured.");
        return;
      }

      interface ToolInfo {
        prefixedName: string;
        serverName: string;
        originalName: string;
        description: string;
      }
      const allTools: ToolInfo[] = [];
      const allToolsRaw: Tool[] = []; // Store full Tool objects for token computation

      for (const name of serverNames) {
        const server = config.servers[name];
        process.stdout.write(`  Connecting to ${name} ... `);
        try {
          const manager = new ServerManager({ [name]: server });
          await manager.start();
          const tools = manager.getTools();
          await manager.stop();
          console.log(`OK (${tools.length} tools)`);
          for (const t of tools) {
            allTools.push({
              prefixedName: t.name,
              serverName: name,
              originalName: t.name.replace(`${name}_`, ""),
              description: t.description || "(no description)",
            });
            allToolsRaw.push(t);
          }
        } catch (err) {
          console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (allTools.length === 0) {
        console.log("\n❌ No tools found. Check connectivity with 'mcp-slim-guard doctor'.");
        process.exit(1);
      }

      const pipeline = new PolicyPipeline(createPolicies(config));
      const allowed: ToolInfo[] = [],
        denied: ToolInfo[] = [],
        unmatched: ToolInfo[] = [];

      for (const tool of allTools) {
        const result = await pipeline.execute({
          toolName: tool.prefixedName,
          arguments: {},
          serverName: tool.serverName,
        });
        if (result.allowed) {
          allowed.push(tool);
        } else {
          const deniedResult = result as Extract<PolicyResult, { allowed: false }>;
          if (deniedResult.policy === "whitelist" && deniedResult.reason?.includes("not in allow list")) {
            unmatched.push(tool);
          } else {
            denied.push(tool);
          }
        }
      }

      const total = allTools.length;
      const pct = (n: number) => `${Math.round((n / total) * 100)}%`;

      console.log(`\n📊 Policy coverage: ${total} tools from ${serverNames.length} server(s)\n`);
      console.log(`  ✅ Allowed:   ${allowed.length} (${pct(allowed.length)})`);
      console.log(`  🚫 Denied:    ${denied.length} (${pct(denied.length)})`);
      console.log(`  ⚠️  No match:  ${unmatched.length} (${pct(unmatched.length)}) — fail-closed`);

      if (denied.length > 0) {
        console.log(`\n🚫 Denied by policy:`);
        for (const t of denied) {
          const matching =
            config.tools.deny.find((p) => {
              return micromatch.isMatch(t.prefixedName, p);
            }) ?? "?";
          console.log(`   ${t.prefixedName} → matches "${matching}"`);
        }
      }

      if (unmatched.length > 0) {
        console.log(`\n⚠️  No allow match (fail-closed):`);
        console.log(`   Allow patterns: ${config.tools.allow.join(", ") || "(empty → all blocked)"}`);
        for (const t of unmatched) console.log(`   ${t.prefixedName}`);
        console.log(`   💡 Add "${unmatched[0]?.serverName}_*" to allow`);
      }

      if (allowed.length > 0) {
        console.log(`\n✅ Allowed tools:`);
        for (const t of allowed) console.log(`   ${t.prefixedName}`);
      }

      // Schema stats (only when compressor is enabled)
      if (config.compressor?.enabled && config.compressor.level !== "off" && allToolsRaw.length > 0) {
        const compressedTools = projectToolsForDisplay(allToolsRaw, config);
        const schemaStats = computeSchemaStats(allToolsRaw, compressedTools);
        displaySchemaStats(schemaStats);
      }

      console.log(
        `\n🔒 SSRF: ${config.ssrf.mode === "off" ? "OFF ⚠️" : `${config.ssrf.mode}${config.ssrf.block_private_ips ? " + private IP blocking" : ""}`}`,
      );

      const exitCode = denied.length + unmatched.length === total ? 1 : 0;
      console.log(exitCode ? `\n❌ ALL tools blocked — check mcp-slim-guard.yml` : `\n✅ All tools pass policy`);
      process.exit(exitCode);
    });

  program
    .command("log")
    .description("View audit log")
    .option("--tail", "Follow log output in real-time")
    .option("--file <path>", "Log file path", "mcp-slim-guard-audit.log")
    .action((options: { tail?: boolean; file: string }) => {
      const logFile = options.file;

      if (!fs.existsSync(logFile)) {
        console.log(`No audit log found at: ${logFile}`);
        console.log("Start mcp-slim-guard first: mcp-slim-guard start");
        return;
      }

      if (options.tail) {
        console.log(`Tailing ${logFile}...\n`);
        // Show last 20 lines first
        const initial = fs.readFileSync(logFile, "utf-8").trim().split("\n").slice(-20);
        for (const line of initial) {
          try {
            const entry = JSON.parse(line) as AuditDisplayEntry;
            console.log(formatAuditEntry(entry, true));
          } catch {
            /* skip non-JSON */
          }
        }

        // Watch for new entries
        let lastSize = fs.statSync(logFile).size;
        const watcher = fs.watch(logFile, () => {
          try {
            const newSize = fs.statSync(logFile).size;
            if (newSize <= lastSize) return;
            const fd = fs.openSync(logFile, "r");
            fs.readSync(fd, Buffer.alloc(0), 0, 0, lastSize);
            const newContent = fs.readFileSync(logFile, "utf-8").slice(lastSize);
            fs.closeSync(fd);
            lastSize = newSize;
            for (const line of newContent.trim().split("\n")) {
              if (!line) continue;
              try {
                const entry = JSON.parse(line) as AuditDisplayEntry;
                console.log(formatAuditEntry(entry, true));
              } catch {
                /* skip */
              }
            }
          } catch {
            /* fs race */
          }
        });

        // Keep process alive
        process.on("SIGINT", () => {
          watcher.close();
          process.exit(0);
        });
        setInterval(() => {}, 60000); // keepalive
      } else {
        console.log("Audit log (last 20 entries):\n");
        const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").slice(-20);
        if (lines.length === 0) {
          console.log("  (empty)");
        }
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as AuditDisplayEntry;
            console.log(formatAuditEntry(entry));
          } catch {
            console.log(`  ${line.slice(0, 80)}...`);
          }
        }
      }
    });

  program
    .command("uninit")
    .description("Remove mcp-slim-guard config and cleanup")
    .option("--force", "Actually delete mcp-slim-guard.yml")
    .action((options: { force?: boolean }) => {
      const cwd = process.cwd();
      const ymlPath = path.join(cwd, "mcp-slim-guard.yml");

      if (options.force) {
        if (fs.existsSync(ymlPath)) {
          fs.unlinkSync(ymlPath);
          console.log("✅ Deleted mcp-slim-guard.yml");
        }
        // Also remove audit log if exists
        const auditPath = path.join(cwd, "mcp-slim-guard-audit.log");
        if (fs.existsSync(auditPath)) {
          fs.unlinkSync(auditPath);
          console.log("✅ Deleted mcp-slim-guard-audit.log");
        }
        console.log("\nNext steps:");
        console.log("  1. Point your MCP client config back to original servers");
        console.log("  2. Restart your MCP client");
        console.log("  3. Run 'mcp-slim-guard init' to re-enable guard");
      } else {
        console.log("To remove mcp-slim-guard:");
        console.log(`  1. Run: mcp-slim-guard uninit --force  (deletes ${ymlPath})`);
        console.log("  2. Point your MCP client config back to original servers");
        console.log("  3. Restart your MCP client");
      }
    });

  await program.parseAsync(argv);
}

// Auto-run when executed directly (not when imported in tests)
const __filename = fileURLToPath(import.meta.url);
const __entrypoint = process.argv[1];
if (__entrypoint) {
  try {
    // npm installs the bin as a POSIX symlink. Compare canonical paths so the
    // CLI runs through that symlink as well as when invoked by its real path.
    const realModulePath = fs.realpathSync(__filename);
    const realEntrypointPath = fs.realpathSync(path.resolve(__entrypoint));
    if (realEntrypointPath === realModulePath) main();
  } catch {
    // A missing or unreadable argv[1] cannot be this module's entrypoint.
  }
}
