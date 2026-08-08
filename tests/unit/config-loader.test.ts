import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigLoader } from "../../src/config-loader.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slim-guard-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function write(directory: string, name: string, value: string): string {
  const target = path.join(directory, name);
  fs.writeFileSync(target, value, "utf8");
  return target;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("ConfigLoader v2", () => {
  it("initializes v2 security and upstream configuration without a mode or compressor", () => {
    const directory = temporaryDirectory();
    const source = write(
      directory,
      ".mcp.json",
      JSON.stringify({ mcpServers: { search: { command: "node", args: ["server.mjs"] } } }),
    );

    const config = ConfigLoader.generateGuardConfig(source);

    expect(config.version).toBe(2);
    expect(config.tools.allow).toEqual(["search_*"]);
    expect(config).not.toHaveProperty("compressor");
    expect(ConfigLoader.serializeGeneratedConfig(config)).not.toContain("compressor:");
  });

  it("loads a v2 file and restores optional cache and audit defaults", () => {
    const directory = temporaryDirectory();
    const configPath = write(
      directory,
      "mcp-slim-guard.yml",
      [
        "version: 2",
        'tools: { allow: ["search_*"], deny: [] }',
        'ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }',
        'rate_limit: { default: "60/min" }',
        "injection_detection: { enabled: false }",
        "servers: {}",
      ].join("\n"),
    );

    const config = ConfigLoader.loadGuardConfig(configPath);

    expect(config.cache).toMatchObject({ enabled: false, ttl: 30, max_entries: 500 });
    expect(config.audit).toMatchObject({ output: "file", filePath: "mcp-slim-guard-audit.log" });
  });

  it("rejects v1 rather than migrating it", () => {
    const directory = temporaryDirectory();
    const configPath = write(
      directory,
      "mcp-slim-guard.yml",
      'version: 1\ntools: { allow: [], deny: [] }\nssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: "" }\ninjection_detection: { enabled: false }\nservers: {}',
    );

    expect(() => ConfigLoader.loadGuardConfig(configPath)).toThrow("unsupported version 1");
  });

  it("rejects a removed compressor block in v2", () => {
    const directory = temporaryDirectory();
    const configPath = write(
      directory,
      "mcp-slim-guard.yml",
      'version: 2\ntools: { allow: [], deny: [] }\nssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: "" }\ninjection_detection: { enabled: false }\ncompressor: { enabled: true, level: light }\nservers: {}',
    );

    expect(() => ConfigLoader.loadGuardConfig(configPath)).toThrow("removed in configuration version 2");
  });

  it("rejects a Host mode stored in YAML", () => {
    const directory = temporaryDirectory();
    const configPath = write(
      directory,
      "mcp-slim-guard.yml",
      'version: 2\ntools: { allow: [], deny: [] }\nssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] }\nrate_limit: { default: "" }\ninjection_detection: { enabled: false }\nmode: extreme\nservers: {}',
    );

    expect(() => ConfigLoader.loadGuardConfig(configPath)).toThrow("do not store it in YAML");
  });
});
