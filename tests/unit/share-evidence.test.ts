import { describe, expect, it } from "vitest";
import type { InstallationEvidence } from "../../src/installation-transaction.js";
import type { RuntimeProfileReport } from "../../src/profile.js";
import { prepareShareEvidence } from "../../src/share-evidence.js";

function profile(overrides: Partial<RuntimeProfileReport> = {}): RuntimeProfileReport {
  const base: RuntimeProfileReport = {
    schemaVersion: 1,
    kind: "mcp-slim-guard/profile",
    mode: "read-only",
    estimator: { id: "chars-div-4-v1", description: "ceil(JSON characters / 4)" },
    segment: { lifecycle: ["starting", "ready", "stopping", "stopped"], coverage: "complete" },
    catalog: { direct: null, hostFacing: null },
    delivery: {
      observedResults: 1,
      measuredResults: 1,
      upstream: { characters: 400, estimatedTokens: 100 },
      host: { characters: 120, estimatedTokens: 30 },
      outcomes: { projected: 1, pass_through: 0, fail_open: 0 },
      upstreamErrors: 0,
      largestSources: [
        {
          serverName: "SECRET_SERVER",
          toolName: "SECRET_TOOL_C:/private/result-ref-123",
          results: 1,
          upstream: { characters: 400, estimatedTokens: 100 },
          host: { characters: 120, estimatedTokens: 30 },
        },
      ],
    },
    calls: { upstreamExecutions: 1, recoveryPageReads: 1 },
    recovery: { verifiedAtDelivery: 1, fullyRead: 1, evicted: 0, unknown: 0 },
    audit: {
      coverage: "complete",
      eventCount: 5,
      parsedLines: 5,
      malformedLines: 0,
      rotatedFiles: 0,
      reasons: [],
    },
    unknown: {
      hostModelInput: "unknown",
      providerBilling: "unknown",
      repeatedPayloadSavings: "unknown",
      durableRecovery: "unknown",
    },
    operations: ["read-audit"],
  };
  return { ...base, ...overrides };
}

const installation: InstallationEvidence = { host: "codex", rollback: "available" };

describe("share evidence", () => {
  it("builds terminal, JSON, and issue evidence from one safe report", () => {
    const evidence = prepareShareEvidence({ profile: profile(), installation });
    const combined = JSON.stringify(evidence);

    expect(evidence.report).toMatchObject({
      schemaVersion: 1,
      kind: "mcp-slim-guard/share-report",
      host: "codex",
      coverage: "complete",
      payload: {
        upstreamEstimatedTokens: 100,
        deliveredEstimatedTokens: 30,
        change: { kind: "reduction", percent: 70 },
      },
      calls: { upstreamExecutions: 1, recoveryPageReads: 1 },
      delivery: { projected: 1, passThrough: 0, failOpen: 0 },
      recovery: { exactRecovery: "verified" },
      rollback: "available",
    });
    expect(evidence.terminal).toContain("Normal-path reduction: 70.00%");
    expect(evidence.issueDraft.canOpen).toBe(true);
    expect(new URL(evidence.issueDraft.url).searchParams.get("share_report")).toBe(evidence.issueDraft.fallbackBody);
    for (const forbidden of ["SECRET_SERVER", "SECRET_TOOL", "C:/private", "result-ref-123"]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it.each([
    {
      name: "partial measurement",
      delivery: {
        observedResults: 2,
        measuredResults: 1,
        upstream: { characters: 400, estimatedTokens: 100 },
        host: { characters: 120, estimatedTokens: 30 },
        outcomes: { projected: 1, pass_through: 1, fail_open: 0 },
        upstreamErrors: 0,
        largestSources: [],
      },
      kind: "unavailable",
      recovery: "verified",
    },
    {
      name: "pass-through",
      delivery: {
        observedResults: 1,
        measuredResults: 1,
        upstream: { characters: 100, estimatedTokens: 25 },
        host: { characters: 100, estimatedTokens: 25 },
        outcomes: { projected: 0, pass_through: 1, fail_open: 0 },
        upstreamErrors: 0,
        largestSources: [],
      },
      kind: "unchanged",
      recovery: "not_needed",
    },
    {
      name: "fail-open overhead",
      delivery: {
        observedResults: 1,
        measuredResults: 1,
        upstream: { characters: 100, estimatedTokens: 25 },
        host: { characters: 120, estimatedTokens: 30 },
        outcomes: { projected: 0, pass_through: 0, fail_open: 1 },
        upstreamErrors: 1,
        largestSources: [],
      },
      kind: "overhead",
      recovery: "not_needed",
    },
  ])("handles $name without making unsupported claims", ({ delivery, kind, recovery }) => {
    const evidence = prepareShareEvidence({ profile: profile({ delivery }), installation });
    expect(evidence.report.payload.change.kind).toBe(kind);
    expect(evidence.report.recovery.exactRecovery).toBe(recovery);
    expect(evidence.report.claims).toEqual({
      hostModelInput: "not_measured",
      providerBilling: "not_measured",
      responseQuality: "not_measured",
    });
  });

  it("distinguishes partial and unavailable recovery", () => {
    const partial = prepareShareEvidence({
      profile: profile({
        delivery: {
          ...profile().delivery,
          observedResults: 2,
          measuredResults: 2,
          outcomes: { projected: 2, pass_through: 0, fail_open: 0 },
        },
        recovery: { verifiedAtDelivery: 1, fullyRead: 1, evicted: 0, unknown: 0 },
      }),
      installation,
    });
    const unavailable = prepareShareEvidence({
      profile: profile({ recovery: { verifiedAtDelivery: 1, fullyRead: 0, evicted: 1, unknown: 0 } }),
      installation,
    });
    expect(partial.report.recovery.exactRecovery).toBe("partial");
    expect(unavailable.report.recovery.exactRecovery).toBe("unavailable");
  });

  it("reports exact recovery as verified before a recovery page is read", () => {
    const evidence = prepareShareEvidence({
      profile: profile({ recovery: { verifiedAtDelivery: 1, fullyRead: 0, evicted: 0, unknown: 1 } }),
      installation,
    });
    expect(evidence.report.recovery).toMatchObject({
      snapshotVerifiedAtDelivery: 1,
      fullyRead: 0,
      notFullyRead: 1,
      exactRecovery: "verified",
    });
  });
});
