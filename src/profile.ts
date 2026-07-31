import type { AuditEntry } from "./types.js";

const ESTIMATOR_ID = "chars-div-4-v1" as const;

type Coverage = "complete" | "partial";

interface SizeEstimate {
  characters: number;
  estimatedTokens: number;
}

interface CatalogEstimate extends SizeEstimate {
  tools: number;
}

interface ProfileMetadata {
  coverage: Coverage;
  eventCount: number;
  parsedLines: number;
  malformedLines: number;
  rotatedFiles: number;
  reasons: string[];
}

export interface RuntimeProfileReport {
  schemaVersion: 1;
  kind: "mcp-slim-guard/profile";
  mode: "read-only";
  estimator: {
    id: typeof ESTIMATOR_ID;
    description: "ceil(JSON characters / 4)";
  };
  segment: {
    lifecycle: string[];
    coverage: Coverage;
  };
  catalog: {
    direct: CatalogEstimate | null;
    hostFacing: CatalogEstimate | null;
  };
  delivery: {
    observedResults: number;
    measuredResults: number;
    upstream: SizeEstimate;
    host: SizeEstimate;
    outcomes: {
      projected: number;
      pass_through: number;
      fail_open: number;
    };
    upstreamErrors: number;
    largestSources: Array<{
      serverName: string;
      toolName: string;
      results: number;
      upstream: SizeEstimate;
      host: SizeEstimate;
    }>;
  };
  recovery: {
    verifiedAtDelivery: number;
    fullyRead: number;
    evicted: number;
    unknown: number;
  };
  audit: ProfileMetadata;
  unknown: {
    hostModelInput: "unknown";
    providerBilling: "unknown";
    repeatedPayloadSavings: "unknown";
    durableRecovery: "unknown";
  };
  operations: ["read-audit"];
}

export interface ParsedAuditLog {
  entries: AuditEntry[];
  parsedLines: number;
  malformedLines: number;
}

export interface ProfileBuildOptions {
  parsedLines?: number;
  malformedLines?: number;
  rotatedFiles?: number;
}

interface DeliveryRecord {
  serverName: string;
  toolName: string;
  outcome: keyof RuntimeProfileReport["delivery"]["outcomes"];
  upstreamCharacters?: number;
  hostCharacters?: number;
  projectedReferenceId?: string;
  evictedReferenceId?: string;
  upstreamError: boolean;
}

function estimateTokens(characters: number): number {
  return Math.ceil(characters / 4);
}

function sizeEstimate(characters: number): SizeEstimate {
  return { characters, estimatedTokens: estimateTokens(characters) };
}

function catalogEstimate(metadata: Record<string, unknown>): CatalogEstimate | null {
  const tools = safeInteger(metadata.tools);
  const characters = safeInteger(metadata.characters);
  if (tools === undefined || characters === undefined) return null;
  return { tools, ...sizeEstimate(characters) };
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function deliveryOutcome(value: unknown): DeliveryRecord["outcome"] | undefined {
  return value === "projected" || value === "pass_through" || value === "fail_open" ? value : undefined;
}

function parseEntry(value: unknown): AuditEntry | undefined {
  const entry = record(value);
  if (!entry || typeof entry.sessionId !== "string" || typeof entry.toolName !== "string") return undefined;
  return entry as unknown as AuditEntry;
}

export function parseAuditLog(content: string): ParsedAuditLog {
  const entries: AuditEntry[] = [];
  let parsedLines = 0;
  let malformedLines = 0;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    parsedLines += 1;
    try {
      const entry = parseEntry(JSON.parse(line));
      if (!entry) malformedLines += 1;
      else entries.push(entry);
    } catch {
      malformedLines += 1;
    }
  }

  return { entries, parsedLines, malformedLines };
}

function lifecycleName(entry: AuditEntry): string | undefined {
  if (entry.event !== "lifecycle" || !entry.toolName.startsWith("runtime/")) return undefined;
  return entry.toolName.slice("runtime/".length);
}

function latestSegment(entries: AuditEntry[]): AuditEntry[] {
  const sessionId = [...entries].reverse().find((entry) => entry.sessionId && entry.sessionId !== "?")?.sessionId;
  if (!sessionId) return [];
  return entries.filter((entry) => entry.sessionId === sessionId);
}

function traceUpstreamEntries(entries: AuditEntry[]): Map<string, AuditEntry> {
  const result = new Map<string, AuditEntry>();
  for (const entry of entries) {
    if (entry.event === "upstream" && entry.traceId) result.set(entry.traceId, entry);
  }
  return result;
}

function sourceFor(
  entry: AuditEntry,
  metadata: Record<string, unknown>,
  upstream?: AuditEntry,
): { serverName: string; toolName: string } {
  const upstreamMetadata = record(upstream?.metadata);
  return {
    serverName:
      text(metadata.upstreamServerName) ??
      text(upstreamMetadata?.upstreamServerName) ??
      (upstream && upstream.serverName !== "projection" ? upstream.serverName : entry.serverName),
    toolName:
      text(metadata.upstreamToolName) ??
      text(upstreamMetadata?.upstreamToolName) ??
      upstream?.toolName ??
      entry.toolName,
  };
}

function deliveryRecords(entries: AuditEntry[]): DeliveryRecord[] {
  const upstreamByTrace = traceUpstreamEntries(entries);
  const records: DeliveryRecord[] = [];
  const deliveredTraces = new Set<string>();

  for (const entry of entries) {
    if (entry.event !== "projection") continue;
    const metadata = record(entry.metadata) ?? {};
    const capsule = record(metadata.capsule);
    const capsuleOutcome = capsule?.phase === "delivery" ? deliveryOutcome(capsule.outcome) : undefined;
    const outcome = capsuleOutcome ?? deliveryOutcome(entry.outcome);
    const upstreamCharacters =
      safeInteger(metadata.upstreamResultChars) ?? safeInteger(capsule?.originalChars) ?? undefined;
    const hostCharacters =
      safeInteger(metadata.deliveredResultChars) ??
      (outcome === "pass_through" && upstreamCharacters !== undefined ? upstreamCharacters : undefined);
    if (!outcome || (upstreamCharacters === undefined && hostCharacters === undefined)) continue;

    const upstream = entry.traceId ? upstreamByTrace.get(entry.traceId) : undefined;
    const source = sourceFor(entry, metadata, upstream);
    records.push({
      ...source,
      outcome,
      ...(upstreamCharacters !== undefined ? { upstreamCharacters } : {}),
      ...(hostCharacters !== undefined ? { hostCharacters } : {}),
      ...(text(capsule?.referenceId) ? { projectedReferenceId: text(capsule?.referenceId) } : {}),
      ...(text(capsule?.evictedReferenceId) ? { evictedReferenceId: text(capsule?.evictedReferenceId) } : {}),
      upstreamError: upstream?.outcome === "upstream_error" || entry.outcome === "upstream_error",
    });
    if (entry.traceId) deliveredTraces.add(entry.traceId);
  }

  // The compressor-off path has no projection event. Its upstream event is
  // still a complete pass-through delivery observation.
  for (const entry of entries) {
    if (entry.event !== "upstream") continue;
    const metadata = record(entry.metadata) ?? {};
    const upstreamCharacters = safeInteger(metadata.resultChars);
    if (upstreamCharacters === undefined || (entry.traceId && deliveredTraces.has(entry.traceId))) continue;
    const source = sourceFor(entry, metadata, entry);
    records.push({
      ...source,
      outcome: "pass_through",
      upstreamCharacters,
      hostCharacters: upstreamCharacters,
      upstreamError: entry.outcome === "upstream_error",
    });
  }

  return records;
}

function buildRecovery(entries: AuditEntry[], records: DeliveryRecord[]): RuntimeProfileReport["recovery"] {
  const delivered = new Set(
    records.flatMap((record) => (record.projectedReferenceId ? [record.projectedReferenceId] : [])),
  );
  const evicted = new Set(records.flatMap((record) => (record.evictedReferenceId ? [record.evictedReferenceId] : [])));
  const fullyRead = new Set<string>();

  for (const entry of entries) {
    if (entry.event !== "recovery") continue;
    const metadata = record(entry.metadata);
    const capsule = record(metadata?.capsule);
    const referenceId = text(capsule?.referenceId);
    if (!referenceId) continue;
    if (entry.outcome === "complete" || capsule?.outcome === "complete") fullyRead.add(referenceId);
    if (capsule?.reason === "unknown_result_ref" || capsule?.reason === "expired") evicted.add(referenceId);
  }

  const fullyReadKnown = [...fullyRead].filter((referenceId) => delivered.has(referenceId)).length;
  const evictedKnown = [...evicted].filter(
    (referenceId) => delivered.has(referenceId) && !fullyRead.has(referenceId),
  ).length;
  return {
    verifiedAtDelivery: delivered.size,
    fullyRead: fullyReadKnown,
    evicted: evictedKnown,
    unknown: Math.max(0, delivered.size - fullyReadKnown - evictedKnown),
  };
}

export function buildRuntimeProfile(
  entries: AuditEntry[],
  options: ProfileBuildOptions = {},
): RuntimeProfileReport | null {
  const segmentEntries = latestSegment(entries);
  if (segmentEntries.length === 0) return null;

  const lifecycle = segmentEntries.map(lifecycleName).filter((value): value is string => value !== undefined);
  const discovery = [...segmentEntries]
    .reverse()
    .find((entry) => entry.event === "discovery" && entry.metadata !== undefined);
  const catalogMetadata = record(discovery?.metadata);
  const direct = catalogMetadata ? catalogEstimate(record(catalogMetadata.directCatalog) ?? {}) : null;
  const hostFacing = catalogMetadata ? catalogEstimate(record(catalogMetadata.hostFacingCatalog) ?? {}) : null;

  const records = deliveryRecords(segmentEntries);
  const upstreamCharacters = records.reduce((total, item) => total + (item.upstreamCharacters ?? 0), 0);
  const hostCharacters = records.reduce((total, item) => total + (item.hostCharacters ?? 0), 0);
  const outcomes = {
    projected: records.filter((item) => item.outcome === "projected").length,
    pass_through: records.filter((item) => item.outcome === "pass_through").length,
    fail_open: records.filter((item) => item.outcome === "fail_open").length,
  };
  const bySource = new Map<
    string,
    { serverName: string; toolName: string; results: number; upstream: number; host: number }
  >();
  for (const item of records) {
    const key = `${item.serverName}\u0000${item.toolName}`;
    const current = bySource.get(key) ?? {
      serverName: item.serverName,
      toolName: item.toolName,
      results: 0,
      upstream: 0,
      host: 0,
    };
    current.results += 1;
    current.upstream += item.upstreamCharacters ?? 0;
    current.host += item.hostCharacters ?? 0;
    bySource.set(key, current);
  }
  const largestSources = [...bySource.values()]
    .sort(
      (left, right) =>
        right.upstream - left.upstream ||
        left.serverName.localeCompare(right.serverName) ||
        left.toolName.localeCompare(right.toolName),
    )
    .slice(0, 10)
    .map((source) => ({
      serverName: source.serverName,
      toolName: source.toolName,
      results: source.results,
      upstream: sizeEstimate(source.upstream),
      host: sizeEstimate(source.host),
    }));

  const reasons: string[] = [];
  if ((options.malformedLines ?? 0) > 0) reasons.push("malformed_lines");
  if ((options.rotatedFiles ?? 0) > 0) reasons.push("rotated_files_present");
  if (!direct || !hostFacing) reasons.push("missing_catalog_measurement");
  const missingDeliveryMeasurement = segmentEntries.some((entry) => {
    if (entry.event === "upstream" && (entry.outcome === "success" || entry.outcome === "upstream_error")) {
      return safeInteger(record(entry.metadata)?.resultChars) === undefined;
    }
    if (entry.event !== "projection") return false;
    const metadata = record(entry.metadata) ?? {};
    const capsule = record(metadata.capsule);
    const isDelivery = capsule?.phase === "delivery" || metadata.upstreamResultChars !== undefined;
    return (
      isDelivery &&
      (safeInteger(metadata.upstreamResultChars) === undefined ||
        safeInteger(metadata.deliveredResultChars) === undefined)
    );
  });
  if (missingDeliveryMeasurement) reasons.push("missing_delivery_measurement");
  if (!lifecycle.includes("starting")) reasons.push("missing_start");
  if (!lifecycle.some((state) => state === "ready" || state === "ready_degraded")) reasons.push("missing_ready");
  if (!lifecycle.some((state) => state === "stopped" || state === "stopped_degraded"))
    reasons.push("runtime_not_stopped");
  const coverage: Coverage = reasons.length === 0 ? "complete" : "partial";

  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/profile",
    mode: "read-only",
    estimator: { id: ESTIMATOR_ID, description: "ceil(JSON characters / 4)" },
    segment: { lifecycle, coverage },
    catalog: { direct, hostFacing },
    delivery: {
      observedResults: records.length,
      measuredResults: records.filter(
        (item) => item.upstreamCharacters !== undefined && item.hostCharacters !== undefined,
      ).length,
      upstream: sizeEstimate(upstreamCharacters),
      host: sizeEstimate(hostCharacters),
      outcomes,
      upstreamErrors: records.filter((item) => item.upstreamError).length,
      largestSources,
    },
    recovery: buildRecovery(segmentEntries, records),
    audit: {
      coverage,
      eventCount: segmentEntries.length,
      parsedLines: options.parsedLines ?? entries.length,
      malformedLines: options.malformedLines ?? 0,
      rotatedFiles: options.rotatedFiles ?? 0,
      reasons,
    },
    unknown: {
      hostModelInput: "unknown",
      providerBilling: "unknown",
      repeatedPayloadSavings: "unknown",
      durableRecovery: "unknown",
    },
    operations: ["read-audit"],
  };
}
