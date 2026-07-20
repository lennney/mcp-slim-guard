/**
 * MCP Guard 配置加载器
 *
 * 扫描目录发现 MCP 配置、从 .mcp.json 生成 GuardConfig、从 YAML 加载配置。
 *
 * @module config-loader
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import type { GuardConfig, UpstreamServer, AuditConfig } from "./config-types.js";
import type { MCPConfig } from "./types.js";
import { validateConfigSchema, formatSchemaErrors } from "./config-schema.js";

/**
 * 配置加载器 — 扫描和解析 MCP Guard 及上游 MCP 配置。
 */
export class ConfigLoader {
  /**
   * 扫描当前目录找到 MCP 配置文件。
   * 按优先级顺序查找：.mcp.json > mcp.json > claude_desktop_config.json > .cursor/mcp.json
   */
  static discoverMCPConfig(cwd: string): string | null {
    const candidates = [
      ".mcp.json",
      "mcp.json",
      "claude_desktop_config.json",
      ".cursor/mcp.json",
    ];
    for (const candidate of candidates) {
      const fullPath = path.join(cwd, candidate);
      if (fs.existsSync(fullPath)) return fullPath;
    }
    return null;
  }

  /**
   * 从 MCP 配置路径生成 GuardConfig。
   * 自动从 mcpServers 列表生成工具白名单（默认仅阻止高危模式）。
   */
  static generateGuardConfig(mcpConfigPath: string): GuardConfig {
    const raw = fs.readFileSync(mcpConfigPath, "utf-8");
    const mcpConfig = JSON.parse(raw) as MCPConfig;

    const servers: Record<string, UpstreamServer> = {};
    const toolNames: string[] = [];

    for (const [name, entry] of Object.entries(mcpConfig.mcpServers ?? {})) {
      servers[name] = {
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ?? {},
      };
      toolNames.push(`${name}_*`);
    }

    return {
      version: 1,
      tools: {
        allow: toolNames,
        deny: ["*_delete_*", "*_drop_*", "*_admin_*"],
      },
      ssrf: {
        mode: "block",
        block_private_ips: true,
        allow_domains: ["*.github.com", "api.*.com"],
        block_domains: ["10.*", "192.168.*", "169.254.*"],
      },
      rate_limit: {
        default: "60/min",
      },
      injection_detection: {
        enabled: false,
        sensitivity: "medium",
      },
      compressor: {
        enabled: false,
        level: "light",
      },
      audit: {
        output: "file",
        filePath: "mcp-guard-audit.log",
        maxSize: "10MB",
        maxFiles: 5,
        compress: false,
      },
      servers,
    };
  }

  /**
   * 从 YAML 文件加载 GuardConfig。
   * 执行基础校验：必须是对象、版本必须为 1、必需字段存在。
   */
  static loadGuardConfig(configPath: string): GuardConfig {
    const content = fs.readFileSync(configPath, "utf-8");
    const config = yaml.load(content) as GuardConfig;

    // 基础校验
    if (!config || typeof config !== "object") {
      throw new Error("Invalid config: expected an object");
    }
    if ((config as GuardConfig).version !== 1) {
      throw new Error(
        `Invalid config: unsupported version ${(config as GuardConfig).version}`,
      );
    }
    if (!config.tools || !config.ssrf || !config.rate_limit) {
      throw new Error(
        "Invalid config: missing required sections (tools, ssrf, rate_limit)",
      );
    }

    // JSON Schema 校验
    const schemaErrors = validateConfigSchema(config as unknown as Record<string, unknown>);
    if (schemaErrors.length > 0) {
      const msg = formatSchemaErrors(schemaErrors);
      throw new Error(msg);
    }

    // Fill defaults for optional sections
    if (!config.audit) {
      config.audit = {
        output: "file",
        filePath: "mcp-guard-audit.log",
        maxSize: "10MB",
        maxFiles: 5,
        compress: false,
      };
    }

    return config;
  }

  /**
   * 查找并加载 mcp-guard.yml。
   * 搜索文件名变体：mcp-guard.yml, mcp-guard.yaml, .mcp-guard.yml
   */
  static findAndLoad(cwd: string): GuardConfig | null {
    const yamlPaths = ["mcp-guard.yml", "mcp-guard.yaml", ".mcp-guard.yml"];
    for (const name of yamlPaths) {
      const fullPath = path.join(cwd, name);
      if (fs.existsSync(fullPath)) {
        return ConfigLoader.loadGuardConfig(fullPath);
      }
    }
    return null;
  }
}
