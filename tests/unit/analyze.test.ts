import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { buildAnalyzeReport } from "../../src/analyze.js";

describe("buildAnalyzeReport", () => {
  it("returns deterministic estimates and orders schemas by size", () => {
    const directTools: Tool[] = [
      {
        name: "server_small",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "server_large",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "A deliberately longer schema description." },
          },
        },
      },
    ];
    const slimTools: Tool[] = [{ name: "find_tool", inputSchema: { type: "object" } }];
    const startReport = {
      configured: 2,
      connected: [
        { serverName: "zeta", transportKind: "stdio" as const, toolCount: 1 },
        { serverName: "alpha", transportKind: "stdio" as const, toolCount: 1 },
      ],
      failed: [],
    };

    const first = buildAnalyzeReport(startReport, directTools, slimTools);
    const second = buildAnalyzeReport(startReport, directTools, slimTools);

    expect(second).toEqual(first);
    expect(first.servers.connected.map((server) => server.serverName)).toEqual(["alpha", "zeta"]);
    expect(first.largestInputSchemas.map((schema) => schema.name)).toEqual(["server_large", "server_small"]);
    expect(first.catalog.direct.tools).toBe(2);
    expect(first.catalog.slimGuard.tools).toBe(1);
    expect(first.catalog.direct.estimatedTokens).toBe(Math.ceil(first.catalog.direct.characters / 4));
    expect(first.operations).toEqual(["tools/list"]);
  });
});
