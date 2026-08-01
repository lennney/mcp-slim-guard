import type { InstallationEvidence } from "./installation-transaction.js";
import type { RuntimeProfileReport } from "./profile.js";
import { VERSION } from "./version.js";

const ISSUE_URL = "https://github.com/lennney/mcp-slim-guard/issues/new";
const ISSUE_TEMPLATE_URL = `${ISSUE_URL}?template=compatibility-report.yml`;
const MAX_ISSUE_URL_LENGTH = 6_000;

type ChangeKind = "reduction" | "overhead" | "unchanged" | "unavailable";
type ExactRecovery = "verified" | "partial" | "unavailable" | "not_needed";

export interface ShareReport {
  schemaVersion: 1;
  kind: "mcp-slim-guard/share-report";
  scope: "latest-runtime-segment";
  product: { name: "MCP Slim Guard"; version: string };
  host: InstallationEvidence["host"];
  coverage: RuntimeProfileReport["segment"]["coverage"];
  payload: {
    estimator: "serialized-mcp-result-chars-div-4";
    observedResults: number;
    measuredResults: number;
    upstreamEstimatedTokens: number | null;
    deliveredEstimatedTokens: number | null;
    change: { kind: ChangeKind; percent: number | null };
  };
  calls: RuntimeProfileReport["calls"];
  delivery: {
    projected: number;
    passThrough: number;
    failOpen: number;
    upstreamErrors: number;
  };
  recovery: {
    snapshotVerifiedAtDelivery: number;
    fullyRead: number;
    evicted: number;
    notFullyRead: number;
    exactRecovery: ExactRecovery;
  };
  rollback: InstallationEvidence["rollback"];
  claims: {
    hostModelInput: "not_measured";
    providerBilling: "not_measured";
    responseQuality: "not_measured";
  };
}

export interface IssueDraft {
  url: string;
  fallbackUrl: string;
  fallbackBody: string;
  canOpen: boolean;
}

export interface ShareEvidence {
  report: ShareReport;
  terminal: string;
  issueDraft: IssueDraft;
}

function roundedPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function payloadChange(profile: RuntimeProfileReport): ShareReport["payload"] {
  const { observedResults, measuredResults, upstream, host } = profile.delivery;
  const measured = observedResults > 0 && observedResults === measuredResults && upstream.characters > 0;
  if (!measured) {
    return {
      estimator: "serialized-mcp-result-chars-div-4",
      observedResults,
      measuredResults,
      upstreamEstimatedTokens: null,
      deliveredEstimatedTokens: null,
      change: { kind: "unavailable", percent: null },
    };
  }

  const delta = upstream.characters - host.characters;
  const kind: ChangeKind = delta > 0 ? "reduction" : delta < 0 ? "overhead" : "unchanged";
  return {
    estimator: "serialized-mcp-result-chars-div-4",
    observedResults,
    measuredResults,
    upstreamEstimatedTokens: upstream.estimatedTokens,
    deliveredEstimatedTokens: host.estimatedTokens,
    change: {
      kind,
      percent: kind === "unchanged" ? 0 : roundedPercent((Math.abs(delta) / upstream.characters) * 100),
    },
  };
}

function exactRecovery(profile: RuntimeProfileReport): ExactRecovery {
  const projected = profile.delivery.outcomes.projected;
  if (projected === 0) return "not_needed";
  const recovery = profile.recovery;
  if (recovery.verifiedAtDelivery === projected && recovery.evicted === 0) {
    return "verified";
  }
  if (recovery.fullyRead > 0 || recovery.verifiedAtDelivery > recovery.evicted) return "partial";
  return "unavailable";
}

function hostLabel(host: ShareReport["host"]): string {
  if (host === "codex") return "Codex";
  if (host === "claude-code") return "Claude Code";
  return "Unknown";
}

function formatPayload(report: ShareReport): string[] {
  const payload = report.payload;
  if (payload.change.kind === "unavailable") {
    return [
      "MCP result payload: unavailable",
      `  Measurement coverage: ${payload.measuredResults}/${payload.observedResults} results`,
    ];
  }

  const changeLabel =
    payload.change.kind === "reduction"
      ? "Normal-path reduction"
      : payload.change.kind === "overhead"
        ? "Normal-path overhead"
        : "Normal-path change";
  return [
    "MCP result payload",
    `  Upstream: ${payload.upstreamEstimatedTokens?.toLocaleString("en-US")} estimated tokens`,
    `  Delivered: ${payload.deliveredEstimatedTokens?.toLocaleString("en-US")} estimated tokens`,
    `  ${changeLabel}: ${payload.change.percent?.toFixed(2)}%`,
  ];
}

function renderTerminal(report: ShareReport): string {
  const outcomes = report.delivery;
  return [
    "MCP Slim Guard Report",
    "=====================",
    `Host: ${hostLabel(report.host)}`,
    `Slim Guard: ${report.product.version}`,
    "Scope: latest runtime segment",
    `Coverage: ${report.coverage}`,
    "",
    ...formatPayload(report),
    "",
    "Delivery",
    `  Results: ${report.payload.observedResults} (projected ${outcomes.projected}, pass-through ${outcomes.passThrough}, fail-open ${outcomes.failOpen})`,
    `  Upstream executions: ${report.calls.upstreamExecutions}`,
    `  Recovery page reads: ${report.calls.recoveryPageReads}`,
    `  Exact recovery: ${report.recovery.exactRecovery}`,
    `  Rollback: ${report.rollback}`,
    "",
    "Estimate: serialized MCP result characters / 4.",
    "Report contains no paths, arguments, result content, or result identifiers.",
  ].join("\n");
}

function buildIssueDraft(report: ShareReport): IssueDraft {
  const fallbackBody = JSON.stringify(report, null, 2);
  const params = new URLSearchParams({
    template: "compatibility-report.yml",
    title: `[compat] ${report.host === "unknown" ? "Host" : hostLabel(report.host)} evidence`,
    slim_guard_version: report.product.version,
    host: hostLabel(report.host),
    share_report: fallbackBody,
  });
  const url = `${ISSUE_URL}?${params.toString()}`;
  return {
    url,
    fallbackUrl: ISSUE_TEMPLATE_URL,
    fallbackBody,
    canOpen: url.length <= MAX_ISSUE_URL_LENGTH,
  };
}

/** Build every share artifact from one privacy-safe, deterministic report. */
export function prepareShareEvidence(input: {
  profile: RuntimeProfileReport;
  installation: InstallationEvidence;
}): ShareEvidence {
  const report: ShareReport = {
    schemaVersion: 1,
    kind: "mcp-slim-guard/share-report",
    scope: "latest-runtime-segment",
    product: { name: "MCP Slim Guard", version: VERSION },
    host: input.installation.host,
    coverage: input.profile.segment.coverage,
    payload: payloadChange(input.profile),
    calls: { ...input.profile.calls },
    delivery: {
      projected: input.profile.delivery.outcomes.projected,
      passThrough: input.profile.delivery.outcomes.pass_through,
      failOpen: input.profile.delivery.outcomes.fail_open,
      upstreamErrors: input.profile.delivery.upstreamErrors,
    },
    recovery: {
      snapshotVerifiedAtDelivery: input.profile.recovery.verifiedAtDelivery,
      fullyRead: input.profile.recovery.fullyRead,
      evicted: input.profile.recovery.evicted,
      notFullyRead: input.profile.recovery.unknown,
      exactRecovery: exactRecovery(input.profile),
    },
    rollback: input.installation.rollback,
    claims: {
      hostModelInput: "not_measured",
      providerBilling: "not_measured",
      responseQuality: "not_measured",
    },
  };

  return {
    report,
    terminal: renderTerminal(report),
    issueDraft: buildIssueDraft(report),
  };
}
