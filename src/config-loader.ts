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
import type { GuardConfig, UpstreamServer } from "./config-types.js";
import type { MCPConfig } from "./types.js";
import { validateConfigSchema, formatSchemaErrors } from "./config-schema.js";
import { assertEnvironmentBackedSecrets, importUpstreamServer } from "./upstream-config.js";

/**
 * 配置加载器 — 扫描和解析 MCP Guard 及上游 MCP 配置。
 */
export class ConfigLoader {
  /**
   * 扫描当前目录找到 MCP 配置文件。
   * 按优先级顺序查找：.mcp.json > mcp.json > claude_desktop_config.json >
   * .cursor/mcp.json > .vscode/mcp.json
   */
  static discoverMCPConfig(cwd: string): string | null {
    const candidates = [".mcp.json", "mcp.json", "claude_desktop_config.json", ".cursor/mcp.json", ".vscode/mcp.json"];
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
    if (!mcpConfig || typeof mcpConfig !== "object") {
      throw new Error("Invalid MCP config: expected an object");
    }
    if (mcpConfig.mcpServers !== undefined && mcpConfig.servers !== undefined) {
      throw new Error('Invalid MCP config: use either "mcpServers" or "servers", not both');
    }

    const servers: Record<string, UpstreamServer> = {};
    const toolNames: string[] = [];
    const sourceServers = mcpConfig.mcpServers ?? mcpConfig.servers ?? {};
    const configDir = path.dirname(path.resolve(mcpConfigPath));
    const workspaceRoot = [".vscode", ".cursor"].includes(path.basename(configDir))
      ? path.dirname(configDir)
      : configDir;

    for (const [name, entry] of Object.entries(sourceServers)) {
      servers[name] = importUpstreamServer(name, entry, workspaceRoot);
      toolNames.push(`${name}_*`);
    }

    return {
      version: 2,
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
        enabled: true,
        sensitivity: "medium",
        mode: "block",
      },
      cache: {
        enabled: false,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      },
      audit: {
        output: "file",
        filePath: "mcp-slim-guard-audit.log",
        maxSize: "10MB",
        maxFiles: 5,
        compress: false,
      },
      servers,
    };
  }

  /**
   * Render the generated user configuration without repeating defaults that
   * loadGuardConfig restores byte-for-byte in effective configuration.
   */
  static serializeGeneratedConfig(config: GuardConfig): string {
    const rendered: Record<string, unknown> = {
      version: config.version,
      tools: config.tools,
      ssrf: config.ssrf,
      rate_limit: config.rate_limit,
      injection_detection: config.injection_detection,
      servers: config.servers,
    };

    const defaultCache =
      config.cache?.enabled === false &&
      config.cache.ttl === 30 &&
      config.cache.max_entries === 500 &&
      config.cache.allow.length === 0 &&
      config.cache.deny.length === 0 &&
      config.cache.ttl_per_tool === undefined;
    if (!defaultCache && config.cache) rendered.cache = config.cache;

    const defaultAudit =
      config.audit.output === "file" &&
      config.audit.filePath === "mcp-slim-guard-audit.log" &&
      config.audit.maxSize === "10MB" &&
      config.audit.maxFiles === 5 &&
      config.audit.compress === false &&
      config.audit.maxMemoryEntries === undefined;
    if (!defaultAudit) rendered.audit = config.audit;

    return yaml.dump(rendered);
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
    if ((config as GuardConfig).version !== 2) {
      throw new Error(`Invalid config: unsupported version ${(config as GuardConfig).version}`);
    }
    if (!config.tools || !config.ssrf || !config.rate_limit) {
      throw new Error("Invalid config: missing required sections (tools, ssrf, rate_limit)");
    }

    // JSON Schema 校验
    const schemaErrors = validateConfigSchema(config as unknown as Record<string, unknown>);
    if (schemaErrors.length > 0) {
      const msg = formatSchemaErrors(schemaErrors);
      throw new Error(msg);
    }

    for (const [name, server] of Object.entries(config.servers)) {
      assertEnvironmentBackedSecrets(name, server);
    }

    // Fill defaults for optional sections
    if (!config.audit) {
      config.audit = {
        output: "file",
        filePath: "mcp-slim-guard-audit.log",
        maxSize: "10MB",
        maxFiles: 5,
        compress: false,
      };
    }

    // Fill cache defaults
    if (!config.cache) {
      config.cache = {
        enabled: false,
        ttl: 30,
        max_entries: 500,
        allow: [],
        deny: [],
      };
    }

    return config;
  }

  /**
   * 查找并加载 mcp-slim-guard.yml。
   * 搜索文件名变体：mcp-slim-guard.yml, mcp-slim-guard.yaml, .mcp-slim-guard.yml
   */
  static findAndLoad(cwd: string): GuardConfig | null {
    const yamlPaths = ["mcp-slim-guard.yml", "mcp-slim-guard.yaml", ".mcp-slim-guard.yml"];
    for (const name of yamlPaths) {
      const fullPath = path.join(cwd, name);
      if (fs.existsSync(fullPath)) {
        return ConfigLoader.loadGuardConfig(fullPath);
      }
    }
    return null;
  }
}
