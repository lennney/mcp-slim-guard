import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigLoader } from "../../src/config-loader.js";

describe("ConfigLoader", () => {
  const tmpDir = "/tmp/mcp-guard-test";
  const mcpJsonPath = path.join(tmpDir, ".mcp.json");
  const guardYmlPath = path.join(tmpDir, "mcp-guard.yml");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("discoverMCPConfig", () => {
    it("finds .mcp.json", () => {
      fs.writeFileSync(mcpJsonPath, "{}");
      const found = ConfigLoader.discoverMCPConfig(tmpDir);
      expect(found).toBe(mcpJsonPath);
    });

    it("finds mcp.json", () => {
      const altPath = path.join(tmpDir, "mcp.json");
      fs.writeFileSync(altPath, "{}");
      const found = ConfigLoader.discoverMCPConfig(tmpDir);
      expect(found).toBe(altPath);
    });

    it("finds claude_desktop_config.json", () => {
      const altPath = path.join(tmpDir, "claude_desktop_config.json");
      fs.writeFileSync(altPath, "{}");
      const found = ConfigLoader.discoverMCPConfig(tmpDir);
      expect(found).toBe(altPath);
    });

    it("finds .cursor/mcp.json", () => {
      const cursorDir = path.join(tmpDir, ".cursor");
      fs.mkdirSync(cursorDir, { recursive: true });
      const altPath = path.join(cursorDir, "mcp.json");
      fs.writeFileSync(altPath, "{}");
      const found = ConfigLoader.discoverMCPConfig(tmpDir);
      expect(found).toBe(altPath);
    });

    it("returns null when no config found", () => {
      const found = ConfigLoader.discoverMCPConfig(tmpDir);
      expect(found).toBeNull();
    });
  });

  describe("generateGuardConfig", () => {
    it("generates guard config from mcp.json", () => {
      const mcpConfig = {
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          playwright: {
            command: "npx",
            args: ["-y", "@playwright/mcp"],
          },
        },
      };
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig));
      const config = ConfigLoader.generateGuardConfig(mcpJsonPath);

      expect(config.version).toBe(1);
      expect(config.servers.github.command).toBe("npx");
      expect(config.tools.allow).toContain("github_*");
      expect(config.tools.allow).toContain("playwright_*");
      expect(config.tools.deny).toContain("delete_*");
      expect(config.ssrf.mode).toBe("block");
      expect(config.rate_limit.default).toBe("60/min");
    });

    it("handles empty servers", () => {
      fs.writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }));
      const config = ConfigLoader.generateGuardConfig(mcpJsonPath);
      expect(config.servers).toEqual({});
      expect(config.tools.allow).toEqual([]);
    });

    it("handles servers with missing args and env", () => {
      fs.writeFileSync(
        mcpJsonPath,
        JSON.stringify({
          mcpServers: {
            simple: { command: "npx" },
          },
        }),
      );
      const config = ConfigLoader.generateGuardConfig(mcpJsonPath);
      expect(config.servers.simple.args).toEqual([]);
      expect(config.servers.simple.env).toEqual({});
    });
  });

  describe("loadGuardConfig", () => {
    it("loads and validates YAML config", () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const ymlContent = fs.readFileSync(
        path.join(__dirname, "../fixtures/mcp-guard.test.yml"),
        "utf-8",
      );
      fs.writeFileSync(guardYmlPath, ymlContent);
      const config = ConfigLoader.loadGuardConfig(guardYmlPath);
      expect(config.version).toBe(1);
      expect(config.tools.allow).toContain("github_*");
      expect(config.ssrf.mode).toBe("block");
    });

    it("throws on invalid version", () => {
      fs.writeFileSync(
        guardYmlPath,
        "version: 2\ntools: { allow: [], deny: [] }\nssrf: { mode: 'block', block_private_ips: true, allow_domains: [], block_domains: [] }\nrate_limit: { default: '60/min' }\ninjection_detection: { enabled: false, sensitivity: 'medium' }\nservers: {}",
      );
      expect(() => ConfigLoader.loadGuardConfig(guardYmlPath)).toThrow(
        "unsupported version",
      );
    });

    it("throws on missing required sections", () => {
      fs.writeFileSync(guardYmlPath, "version: 1\ntools: { allow: [], deny: [] }\nservers: {}");
      expect(() => ConfigLoader.loadGuardConfig(guardYmlPath)).toThrow(
        "missing required sections",
      );
    });
  });

  describe("findAndLoad", () => {
    it("finds and loads mcp-guard.yml", () => {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const ymlContent = fs.readFileSync(
        path.join(__dirname, "../fixtures/mcp-guard.test.yml"),
        "utf-8",
      );
      fs.writeFileSync(guardYmlPath, ymlContent);
      const config = ConfigLoader.findAndLoad(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.version).toBe(1);
    });

    it("finds and loads mcp-guard.yaml", () => {
      const altPath = path.join(tmpDir, "mcp-guard.yaml");
      fs.writeFileSync(altPath, "version: 1\ntools: { allow: ['*'], deny: [] }\nssrf: { mode: 'off', block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: '60/min' }\ninjection_detection: { enabled: false, sensitivity: 'medium' }\nservers: {}");
      const config = ConfigLoader.findAndLoad(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.version).toBe(1);
    });

    it("returns null when no YAML found", () => {
      const config = ConfigLoader.findAndLoad(tmpDir);
      expect(config).toBeNull();
    });
  });
});
