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
import type { Policy } from "./types.js";
import { PolicyPipeline } from "./policies/base.js";
import { WhitelistPolicy } from "./policies/whitelist.js";
import { SSRFPolicy } from "./policies/ssrf.js";
import { RateLimitPolicy } from "./policies/ratelimit.js";
import { AuditLogger } from "./audit.js";
import { ServerManager } from "./server-manager.js";
import { GuardProxy } from "./proxy.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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
    .action(() => {
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
    });

  program
    .command("start")
    .description("Start the guard proxy")
    .action(async () => {
      const cwd = process.cwd();
      const config = ConfigLoader.findAndLoad(cwd);
      if (!config) {
        console.error("Error: mcp-guard.yml not found. Run 'mcp-guard init' first.");
        process.exit(1);
        return;
      }

      const policies = createPolicies(config);
      const pipeline = new PolicyPipeline(policies);
      const audit = new AuditLogger();
      const serverManager = new ServerManager(config.servers);
      const proxy = new GuardProxy(config, pipeline, audit, serverManager);
      const transport = new StdioServerTransport();

      await proxy.start(transport);

      console.log("🛡️ mcp-guard started");
      console.log("   Listening on STDIO transport");
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
    });

  program
    .command("log")
    .description("View audit log")
    .option("--tail", "Follow log output in real-time")
    .action((options: { tail?: boolean }) => {
      if (options.tail) {
        console.log("Tailing audit log...");
      } else {
        console.log("Audit log entries:");
        console.log("   (Use --tail to follow in real-time)");
      }
    });

  program
    .command("uninit")
    .description("Remove guard wrapper from MCP config")
    .action(() => {
      console.log("To remove mcp-guard:");
      console.log("  1. Delete mcp-guard.yml");
      console.log("  2. Restore your original MCP config");
      console.log("  3. Restart your MCP client");
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
