/**
 * 配置文件 JSON Schema 校验测试
 */

import { describe, it, expect } from "vitest";
import { validateConfigSchema } from "../../src/config-schema.js";

function validConfig(): Record<string, unknown> {
  return {
    version: 1,
    tools: {
      allow: ["github_*"],
      deny: ["*_delete_*"],
    },
    ssrf: {
      mode: "block",
      block_private_ips: true,
      allow_domains: ["*.github.com"],
      block_domains: ["10.*"],
    },
    rate_limit: {
      default: "60/min",
      per_agent: {
        claude: "120/min",
      },
    },
    injection_detection: {
      enabled: false,
      sensitivity: "medium",
      mode: "block",
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
    servers: {
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: {},
      },
    },
  };
}

describe("validateConfigSchema", () => {
  it("accepts a valid config", () => {
    const errors = validateConfigSchema(validConfig());
    expect(errors).toHaveLength(0);
  });

  it("rejects missing required top-level fields", () => {
    const c = validConfig();
    delete (c as Record<string, unknown>).servers;
    const errors = validateConfigSchema(c);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path === "$.servers")).toBe(true);
  });

  it("rejects invalid enum values", () => {
    const c = validConfig();
    (c.ssrf as Record<string, unknown>).mode = "invalid";
    const errors = validateConfigSchema(c);
    expect(errors.some((e) => e.path === "$.ssrf.mode")).toBe(true);
  });

  it("rejects invalid rate_limit.default type", () => {
    const c = validConfig();
    (c.rate_limit as Record<string, unknown>).default = true;
    const errors = validateConfigSchema(c);
    expect(errors.some((e) => e.path === "$.rate_limit.default")).toBe(true);
  });

  it("accepts rate_limit.default as number", () => {
    const c = validConfig();
    (c.rate_limit as Record<string, unknown>).default = 10;
    const errors = validateConfigSchema(c);
    expect(errors).toHaveLength(0);
  });

  it("accepts rate_limit.default as object", () => {
    const c = validConfig();
    (c.rate_limit as Record<string, unknown>).default = { window_ms: 60000, max_requests: 60 };
    const errors = validateConfigSchema(c);
    expect(errors).toHaveLength(0);
  });

  it("allows extra top-level fields (YAML anchor aliases)", () => {
    const c = validConfig();
    c.tools_copy = { allow: ["*"], deny: [] };
    const errors = validateConfigSchema(c);
    expect(errors).toHaveLength(0);
  });

  it("rejects missing required nested fields", () => {
    const c = validConfig();
    (c.servers as Record<string, Record<string, unknown>>).github.command = undefined;
    const errors = validateConfigSchema(c);
    expect(errors.some((e) => e.path === "$.servers.github.command")).toBe(true);
  });
});
