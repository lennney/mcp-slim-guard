import { describe, expect, it } from "vitest";
import type { AuditEntry } from "../../src/types.js";
import { buildRuntimeProfile, parseAuditLog } from "../../src/profile.js";

function auditEntry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    timestamp: "2026-07-30T00:00:00.000Z",
    sessionId: "s1",
    requestId: 1,
    toolName: "runtime/ready",
    serverName: "system",
    arguments: {},
    action: "allowed",
    decisionTrail: [],
    ...overrides,
  };
}

describe("runtime profile", () => {
  it("builds a bounded delivery report without exposing result bodies or raw references", () => {
    const entries: AuditEntry[] = [
      auditEntry({ toolName: "runtime/starting", event: "lifecycle", outcome: "success" }),
      auditEntry({
        requestId: 2,
        toolName: "tools/list",
        serverName: "native",
        event: "discovery",
        outcome: "success",
        metadata: {
          directCatalog: { tools: 2, characters: 800 },
          hostFacingCatalog: { tools: 3, characters: 500 },
        },
      }),
      auditEntry({
        requestId: 3,
        traceId: "t_one",
        toolName: "github_read",
        serverName: "github",
        event: "upstream",
        outcome: "success",
        metadata: { resultChars: 400, upstreamToolName: "read" },
      }),
      auditEntry({
        requestId: 4,
        traceId: "t_one",
        toolName: "github_read",
        serverName: "projection",
        event: "projection",
        outcome: "projected",
        metadata: {
          upstreamServerName: "github",
          upstreamToolName: "read",
          upstreamResultChars: 400,
          deliveredResultChars: 120,
          capsule: { phase: "delivery", outcome: "projected", referenceId: "hashed-ref-1" },
        },
      }),
      auditEntry({
        requestId: 5,
        traceId: "t_one",
        toolName: "read_result",
        serverName: "projection",
        event: "recovery",
        outcome: "complete",
        metadata: { capsule: { phase: "recovery", outcome: "complete", referenceId: "hashed-ref-1" } },
      }),
      auditEntry({
        requestId: 6,
        traceId: "t_two",
        toolName: "github_list",
        serverName: "github",
        event: "upstream",
        outcome: "success",
        metadata: { resultChars: 40, upstreamToolName: "list" },
      }),
      auditEntry({ toolName: "runtime/ready", event: "lifecycle", outcome: "success" }),
      auditEntry({ toolName: "runtime/stopping", event: "lifecycle", outcome: "success" }),
      auditEntry({ toolName: "runtime/stopped", event: "lifecycle", outcome: "success" }),
    ];

    const report = buildRuntimeProfile(entries, { parsedLines: 9 });

    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "mcp-slim-guard/profile",
      mode: "read-only",
      estimator: { id: "chars-div-4-v1" },
      segment: { coverage: "complete" },
      catalog: {
        direct: { tools: 2, characters: 800, estimatedTokens: 200 },
        hostFacing: { tools: 3, characters: 500, estimatedTokens: 125 },
      },
      delivery: {
        observedResults: 2,
        measuredResults: 2,
        upstream: { characters: 440, estimatedTokens: 110 },
        host: { characters: 160, estimatedTokens: 40 },
        outcomes: { projected: 1, pass_through: 1, fail_open: 0 },
      },
      recovery: { verifiedAtDelivery: 1, fullyRead: 1, evicted: 0, unknown: 0 },
      audit: { coverage: "complete", parsedLines: 9, malformedLines: 0 },
    });
    expect(report?.delivery.largestSources).toEqual([
      {
        serverName: "github",
        toolName: "read",
        results: 1,
        upstream: { characters: 400, estimatedTokens: 100 },
        host: { characters: 120, estimatedTokens: 30 },
      },
      {
        serverName: "github",
        toolName: "list",
        results: 1,
        upstream: { characters: 40, estimatedTokens: 10 },
        host: { characters: 40, estimatedTokens: 10 },
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("hashed-ref-1");
    expect(JSON.stringify(report)).not.toContain("result body");
  });

  it("marks malformed and unfinished audit evidence as partial", () => {
    const parsed = parseAuditLog(
      [
        JSON.stringify(auditEntry({ toolName: "runtime/starting", event: "lifecycle", outcome: "success" })),
        "not-json",
      ].join("\n"),
    );
    const report = buildRuntimeProfile(parsed.entries, {
      parsedLines: parsed.parsedLines,
      malformedLines: parsed.malformedLines,
      rotatedFiles: 1,
    });

    expect(report?.segment.coverage).toBe("partial");
    expect(report?.audit.reasons).toEqual([
      "malformed_lines",
      "rotated_files_present",
      "missing_catalog_measurement",
      "missing_ready",
      "runtime_not_stopped",
    ]);
  });
});
