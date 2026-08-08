import { describe, expect, it } from "vitest";
import { AuditLogger } from "../../src/audit.js";
import type { GuardConfig } from "../../src/config-types.js";
import { verifyModeAcceptance } from "../../src/mode-acceptance.js";
import type { GuardMode } from "../../src/modes.js";
import { PolicyPipeline } from "../../src/policies/base.js";
import { ServerManager } from "../../src/server-manager.js";
import { WhitelistPolicy } from "../../src/policies/whitelist.js";
import { InMemoryUpstreamConnector } from "../helpers/in-memory-upstream.js";

function config(): GuardConfig {
  return {
    version: 2,
    tools: { allow: ["fixture_*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
    rate_limit: { default: "" },
    injection_detection: { enabled: false },
    audit: { output: "file", filePath: "audit.log" },
    servers: { fixture: { command: "test-fixture" } },
  };
}

function dependencies(currentConfig: GuardConfig, connector: InMemoryUpstreamConnector) {
  return {
    manager: new ServerManager(currentConfig.servers, connector),
    pipeline: new PolicyPipeline([new WhitelistPolicy(currentConfig.tools)]),
    audit: new AuditLogger({ output: "stderr", level: "silent" }),
  };
}

describe("mode acceptance", () => {
  it.each(["native", "compact", "extreme"] as const)(
    "checks the %s surface and exact schema without invoking an upstream Tool",
    async (mode: GuardMode) => {
      const currentConfig = config();
      const nestedSchema = {
        type: "object" as const,
        properties: {
          target: {
            type: "object",
            properties: { scope: { type: "string", enum: ["project", "user"] } },
            required: ["scope"],
            additionalProperties: false,
          },
        },
        required: ["target"],
        additionalProperties: false,
      };
      const connector = new InMemoryUpstreamConnector({
        fixture: {
          tools: [
            {
              name: "inspect",
              description: "Inspect a fixture with a nested enum.",
              inputSchema: nestedSchema,
            },
          ],
          call: async () => ({ content: [{ type: "text", text: "must not run" }] }),
        },
      });

      const report = await verifyModeAcceptance(currentConfig, mode, dependencies(currentConfig, connector));

      expect(report).toMatchObject({
        status: "passed",
        mode,
        upstream: { catalogTools: 1, authorizedTools: 1 },
        host: {
          tools: mode === "native" ? ["inspect", "read_result"] : ["find_tool", "call_tool", "read_result"],
          schemaCheck: "exact",
        },
        safety: {
          hostConfigurationWrites: 0,
          upstreamToolCalls: 0,
          resultRecovery: "not_run",
        },
      });
      expect(connector.state("fixture").calls).toEqual([]);
    },
  );

  it("fails closed when no upstream Tool is authorized, without invoking one", async () => {
    const currentConfig: GuardConfig = { ...config(), tools: { allow: ["other_*"], deny: [] } };
    const connector = new InMemoryUpstreamConnector({
      fixture: {
        tools: [
          {
            name: "inspect",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
    });

    await expect(
      verifyModeAcceptance(currentConfig, "compact", dependencies(currentConfig, connector)),
    ).rejects.toThrow("No upstream Tools are authorized");
    expect(connector.state("fixture").calls).toEqual([]);
  });
});
