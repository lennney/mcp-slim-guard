#!/usr/bin/env node

/**
 * MCP Guard — CLI entry point
 *
 * Commander-based CLI for mcp-guard.
 * Supports: init, start, status, log, uninit
 *
 * @module cli
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { ConfigLoader } from "./config-loader.js";
import { VERSION } from "./index.js";
import type { GuardConfig } from "./config-types.js";
import type { Policy, PolicyContext, PolicyResult } from "./types.js";
import { validateConfigSchema, formatSchemaErrors } from "./config-schema.js";
import { PolicyPipeline } from "./policies/base.js";
import { WhitelistPolicy } from "./policies/whitelist.js";
import { SSRFPolicy } from "./policies/ssrf.js";
import { RateLimitPolicy } from "./policies/ratelimit.js";
import { InjectionPolicy } from "./policies/injection.js";
import { AuditLogger } from "./audit.js";
import { ServerManager } from "./server-manager.js";
import { GuardProxy } from "./proxy.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as http from "node:http";
import micromatch from "micromatch";

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
    list.push(`compressor:${config.compressor.level}`);
  }
  return list;
}

/**
 * Create policy instances from guard config.
 */
function createPolicies(config: GuardConfig): Policy[] {
  const policies: Policy[] = [];

  if (config.tools.allow.length > 0 || config.tools.deny.length > 0) {
    policies.push(new WhitelistPolicy(config.tools));
  }

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
 * CLI entry point. Parses argv and executes the appropriate command.
 *
 * @param argv - Command-line arguments (defaults to process.argv)
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = new Command();

  program
    .name("mcp-guard")
    .version(VERSION)
    .description("轻量 MCP 安全代理 — SSRF 防护 + 工具白名单 + 审计 + 限速");

  program
    .command("init")
    .description("Auto-discover MCP config and generate mcp-guard.yml")
    .option("--compressor [level]", "Enable schema compression (lossless). Levels: light (recommended), tight", "off")
    .action((options: { compressor?: string }) => {
      const cwd = process.cwd();
      const mcpConfigPath = ConfigLoader.discoverMCPConfig(cwd);

      if (!mcpConfigPath) {
        console.error("Error: No MCP configuration file found.");
        console.error(
          "Expected one of: .mcp.json, mcp.json, claude_desktop_config.json, .cursor/mcp.json",
        );
        process.exit(1);
        return;
      }

      const guardConfig = ConfigLoader.generateGuardConfig(mcpConfigPath);
      
      // Apply compressor setting
      if (options.compressor && options.compressor !== "off") {
        const level = options.compressor as "light" | "tight";
        guardConfig.compressor = { enabled: true, level };
      }

      const ymlPath = path.join(cwd, "mcp-guard.yml");
      const ymlContent = yaml.dump(guardConfig as unknown as Record<string, unknown>);
      fs.writeFileSync(ymlPath, ymlContent, "utf-8");

      const serverCount = Object.keys(guardConfig.servers).length;
      const policyList = buildPolicyList(guardConfig);

      console.log("✅ Generated mcp-guard.yml");
      console.log(`   Servers: ${serverCount}`);
      console.log(`   Policies: ${policyList.join(", ")}`);
      console.log(`   SSRF: ${guardConfig.ssrf.mode}`);
      console.log(`   Rate limit: ${guardConfig.rate_limit.default}`);
      const auditOut = guardConfig.audit?.output ?? "file";
      const auditPath = guardConfig.audit?.filePath ?? "mcp-guard-audit.log";
      const auditMax = guardConfig.audit?.maxSize ?? "10MB";
      const auditFiles = guardConfig.audit?.maxFiles ?? 5;
      const auditGzip = guardConfig.audit?.compress ? ", gzip" : "";
      console.log(`   Audit: ${auditOut}${auditOut === "file" ? ` (${auditPath}, maxSize: ${auditMax}, maxFiles: ${auditFiles}${auditGzip})` : ""}`);
    });

  program
    .command("start")
    .description("Start the guard proxy")
    .option("--http", "Use HTTP transport instead of STDIO")
    .option("--port <port>", "HTTP port (default: 3000)", "3000")
    .action(async (options: { http?: boolean; port: string }) => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-guard.yml not found. Run 'mcp-guard init' first.");
        process.exit(1);
        return;
      }

      // Use config.audit with defaults
      const auditCfg = config.audit ?? { output: "file" as const, filePath: "mcp-guard-audit.log" };
      const auditOpts: { output: "stdout" | "file"; filePath?: string } = {
        output: auditCfg.output,
      };
      if (auditCfg.output === "file") {
        auditOpts.filePath = auditCfg.filePath ?? path.join(cwd, "mcp-guard-audit.log");
      }
      const audit = new AuditLogger(auditOpts);
      let serverManager = new ServerManager(config.servers);
      const policies = createPolicies(config);
      const pipeline = new PolicyPipeline(policies);
      const proxy = new GuardProxy(config, pipeline, audit, serverManager);

      // Choose transport
      const transport = options.http
        ? new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // let the SDK handle it
          })
        : new StdioServerTransport();

      await proxy.start(transport);

      console.log("🛡️ mcp-guard started");
      if (options.http) {
        const port = parseInt(options.port, 10);
        const httpTransport = transport as StreamableHTTPServerTransport;
        // Create HTTP server to handle incoming requests
        const httpServer = http.createServer(async (req, res) => {
          // Only handle POST /mcp
          if (req.method !== "POST" || req.url !== "/mcp") {
            res.writeHead(405).end("Method Not Allowed");
            return;
          }
          // Collect body
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          try {
            await (httpTransport as StreamableHTTPServerTransport).handleRequest(req, res, body);
          } catch (err) {
            console.error("HTTP handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500).end("Internal Server Error");
            }
          }
        });
        httpServer.listen(port, () => {
          console.log(`   HTTP transport: http://localhost:${port}/mcp`);
          console.log("   Use this URL in your MCP client config");
        });
      } else {
        console.log("   Listening on STDIO transport");
      }
      console.log(`   Audit log: ${auditOpts.output === "file" ? auditOpts.filePath : "stdout"}`);
      console.log("   Send SIGHUP to reload config (kill -HUP <pid>)");

      // SIGHUP → hot reload mcp-guard.yml (rebuilds pipeline + audit + serverManager)
      process.on("SIGHUP", async () => {
        try {
          const newConfig = ConfigLoader.findAndLoad(cwd);
          if (!newConfig) {
            console.error("⚠️ [reload] mcp-guard.yml not found — keeping old config");
            return;
          }
          // Stop old server manager connections
          await serverManager.stop();
          // Create new ones
          serverManager = new ServerManager(newConfig.servers);
          await serverManager.start();
          const newPolicies = createPolicies(newConfig);
          const newPipeline = new PolicyPipeline(newPolicies);
          // Rebuild audit logger
          const newAuditCfg = newConfig.audit ?? { output: "file" as const, filePath: "mcp-guard-audit.log" };
          const newAuditOpts: { output: "stdout" | "file"; filePath?: string } = {
            output: newAuditCfg.output,
          };
          if (newAuditCfg.output === "file") {
            newAuditOpts.filePath = newAuditCfg.filePath ?? path.join(cwd, "mcp-guard-audit.log");
          }
          const newAudit = new AuditLogger(newAuditOpts);
          proxy.reload(newConfig, newPipeline, newAudit);
          console.log("✅ [reload] Config reloaded — new policies + servers + audit active");
        } catch (err) {
          console.error("⚠️ [reload] Failed:", err instanceof Error ? err.message : String(err));
        }
      });
    });

  program
    .command("status")
    .description("Show running status")
    .action(() => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-guard.yml not found. Run 'mcp-guard init' first.");
        process.exit(1);
        return;
      }

      const serverCount = Object.keys(config.servers).length;

      console.log("🛡️ mcp-guard status");
      console.log(`   Config: mcp-guard.yml`);
      console.log(`   Servers: ${serverCount}`);
      for (const [name, server] of Object.entries(config.servers)) {
        console.log(`     - ${name}: ${server.command}`);
      }

      const policyList = buildPolicyList(config);
      console.log(`   Policies: ${policyList.join(", ")}`);
      console.log(`   SSRF: ${config.ssrf.mode}`);
      console.log(`   Rate limit: ${config.rate_limit.default}`);
      console.log(
        `   Injection detection: ${config.injection_detection.enabled ? "enabled" : "disabled"}`,
      );
      console.log(
        `   Compressor: ${config.compressor?.enabled ? config.compressor.level : "off (use --compressor to enable)"}`,
      );
      const auditOut = config.audit?.output ?? "file";
      const auditPath = config.audit?.filePath ?? "mcp-guard-audit.log";
      const auditMax = config.audit?.maxSize ?? "10MB";
      const auditFiles = config.audit?.maxFiles ?? 5;
      const auditGzip = config.audit?.compress ? ", gzip" : "";
      console.log(`   Audit: ${auditOut}${auditOut === "file" ? ` (${auditPath}, maxSize: ${auditMax}, maxFiles: ${auditFiles}${auditGzip})` : ""}`);
    });

  program
    .command("doctor")
    .description("Diagnose upstream server connectivity and config validity")
    .action(async () => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-guard.yml not found. Run 'mcp-guard init' first.");
        process.exit(1);
      }

      console.log("🩺 mcp-guard doctor\n");
      console.log(`Config: mcp-guard.yml (version ${config.version})`);
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
        console.log("   Add servers to mcp-guard.yml or run 'mcp-guard init'.");
      }

      let okCount = 0;
      let failCount = 0;

      for (const name of serverNames) {
        const server = config.servers[name];
        process.stdout.write(`  ${name} ... `);
        try {
          const manager = new ServerManager({ [name]: server });
          await manager.start();
          const tools = manager.getTools();
          await manager.stop();

          console.log(`✅ OK (${tools.length} tools: ${tools.map(t => t.name).join(", ")})`);
          okCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`❌ FAIL — ${msg}`);
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
      if (config.compressor?.enabled) {
        console.log(`  📦 Schema compressor: ${config.compressor.level} (lossless — tool schemas on demand)`);
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
        console.error("Error: mcp-guard.yml not found. Run 'mcp-guard init' first.");
        process.exit(1);
      }

      console.log("🔍 mcp-guard validate — dry-run policy check\n");

      const serverNames = Object.keys(config.servers);
      if (serverNames.length === 0) {
        console.log("⚠️  No upstream servers configured.");
        return;
      }

      interface ToolInfo {
        prefixedName: string; serverName: string;
        originalName: string; description: string;
      }
      const allTools: ToolInfo[] = [];

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
          }
        } catch (err) {
          console.log(`❌ ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (allTools.length === 0) {
        console.log("\n❌ No tools found. Check connectivity with 'mcp-guard doctor'.");
        process.exit(1);
      }

      const pipeline = new PolicyPipeline(createPolicies(config));
      const allowed: ToolInfo[] = [], denied: ToolInfo[] = [], unmatched: ToolInfo[] = [];

      for (const tool of allTools) {
        const result = await pipeline.execute({
          toolName: tool.prefixedName, arguments: {}, serverName: tool.serverName,
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
      const pct = (n: number) => `${Math.round(n / total * 100)}%`;

      console.log(`\n📊 Policy coverage: ${total} tools from ${serverNames.length} server(s)\n`);
      console.log(`  ✅ Allowed:   ${allowed.length} (${pct(allowed.length)})`);
      console.log(`  🚫 Denied:    ${denied.length} (${pct(denied.length)})`);
      console.log(`  ⚠️  No match:  ${unmatched.length} (${pct(unmatched.length)}) — fail-closed`);

      if (denied.length > 0) {
        console.log(`\n🚫 Denied by policy:`);
        for (const t of denied) {
          const matching = config.tools.deny.find(p => {
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

      console.log(`\n🔒 SSRF: ${config.ssrf.mode === "off" ? "OFF ⚠️" : `${config.ssrf.mode}${config.ssrf.block_private_ips ? " + private IP blocking" : ""}`}`);

      const exitCode = denied.length + unmatched.length === total ? 1 : 0;
      console.log(exitCode ? `\n❌ ALL tools blocked — check mcp-guard.yml` : `\n✅ All tools pass policy`);
      process.exit(exitCode);
    });

  program
    .command("log")
    .description("View audit log")
    .option("--tail", "Follow log output in real-time")
    .option("--file <path>", "Log file path", "mcp-guard-audit.log")
    .action((options: { tail?: boolean; file: string }) => {
      const logFile = options.file;

      if (!fs.existsSync(logFile)) {
        console.log(`No audit log found at: ${logFile}`);
        console.log("Start mcp-guard first: mcp-guard start");
        return;
      }

      if (options.tail) {
        console.log(`Tailing ${logFile}...\n`);
        // Show last 20 lines first
        const initial = fs.readFileSync(logFile, "utf-8").trim().split("\n").slice(-20);
        for (const line of initial) {
          try {
            const entry = JSON.parse(line);
            const icon = entry.action === "blocked" ? "🚫" : "✅";
            console.log(`${icon} [${entry.timestamp?.slice(11, 19) ?? "?"}] ${entry.toolName}: ${entry.action}${entry.reason ? ` (${entry.reason})` : ""}`);
          } catch { /* skip non-JSON */ }
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
                const entry = JSON.parse(line);
                const icon = entry.action === "blocked" ? "🚫" : "✅";
                console.log(`${icon} [${entry.timestamp?.slice(11, 19) ?? "?"}] ${entry.toolName}: ${entry.action}${entry.reason ? ` (${entry.reason})` : ""}`);
              } catch { /* skip */ }
            }
          } catch { /* fs race */ }
        });

        // Keep process alive
        process.on("SIGINT", () => { watcher.close(); process.exit(0); });
        setInterval(() => {}, 60000); // keepalive
      } else {
        console.log("Audit log (last 20 entries):\n");
        const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n").slice(-20);
        if (lines.length === 0) {
          console.log("  (empty)");
        }
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const icon = entry.action === "blocked" ? "🚫" : "✅";
            const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : "";
            console.log(`${icon} [${entry.timestamp?.slice(0, 19) ?? "?"}] ${entry.serverName}:${entry.toolName} → ${entry.action}${dur}${entry.reason ? ` — ${entry.reason}` : ""}`);
          } catch { console.log(`  ${line.slice(0, 80)}...`); }
        }
      }
    });

  program
    .command("uninit")
    .description("Remove mcp-guard config and cleanup")
    .option("--force", "Actually delete mcp-guard.yml")
    .action((options: { force?: boolean }) => {
      const cwd = process.cwd();
      const ymlPath = path.join(cwd, "mcp-guard.yml");

      if (options.force) {
        if (fs.existsSync(ymlPath)) {
          fs.unlinkSync(ymlPath);
          console.log("✅ Deleted mcp-guard.yml");
        }
        // Also remove audit log if exists
        const auditPath = path.join(cwd, "mcp-guard-audit.log");
        if (fs.existsSync(auditPath)) {
          fs.unlinkSync(auditPath);
          console.log("✅ Deleted mcp-guard-audit.log");
        }
        console.log("\nNext steps:");
        console.log("  1. Point your MCP client config back to original servers");
        console.log("  2. Restart your MCP client");
        console.log("  3. Run 'mcp-guard init' to re-enable guard");
      } else {
        console.log("To remove mcp-guard:");
        console.log(`  1. Run: mcp-guard uninit --force  (deletes ${ymlPath})`);
        console.log("  2. Point your MCP client config back to original servers");
        console.log("  3. Restart your MCP client");
      }
    });

  await program.parseAsync(argv);
}

// Auto-run when executed directly (not when imported in tests)
const __filename = fileURLToPath(import.meta.url);
if (
  process.argv[1] &&
  (process.argv[1] === __filename ||
    path.resolve(process.argv[1]) === __filename)
) {
  main();
}
