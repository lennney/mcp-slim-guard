import { describe, expect, it } from "vitest";
import { validateConfigSchema } from "../../src/config-schema.js";

function validConfig(): Record<string, unknown> {
  return {
    version: 2,
    tools: { allow: ["search_*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
    rate_limit: { default: "60/min" },
    injection_detection: { enabled: false },
    audit: { output: "file", filePath: "audit.log" },
    servers: { search: { command: "node", args: ["server.mjs"] } },
  };
}

describe("validateConfigSchema", () => {
  it("accepts a v2 security and upstream configuration", () => {
    expect(validateConfigSchema(validConfig())).toEqual([]);
  });

  it("rejects v1 and the removed compressor section", () => {
    const v1 = validConfig();
    v1.version = 1;
    expect(validateConfigSchema(v1).some((error) => error.path === "$.version")).toBe(true);

    const legacy = validConfig();
    legacy.compressor = { enabled: true, level: "light" };
    expect(validateConfigSchema(legacy).some((error) => error.path === "$.compressor")).toBe(true);
  });

  it("keeps known policy fields typed", () => {
    const invalid = validConfig();
    invalid.tools = { allow: [], deny: "not-an-array" };
    expect(validateConfigSchema(invalid).some((error) => error.path === "$.tools.deny")).toBe(true);
  });

  it("rejects a Host mode in configuration", () => {
    const invalid = validConfig();
    invalid.mode = "compact";
    expect(validateConfigSchema(invalid).some((error) => error.path === "$.mode")).toBe(true);
  });
});
