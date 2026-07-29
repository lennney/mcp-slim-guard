/**
 * Deterministic, recoverable delivery for oversized MCP tool results.
 *
 * This deep module owns content classification, model-facing projection,
 * immutable snapshots, adaptive chunking, expiry, capacity, and recovery
 * references. Callers only capture and read.
 *
 * @module result-capsule-store
 */

import { createHash, randomBytes } from "node:crypto";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ResultSecurityInspector, type ResultSecurityAssessment } from "./result-security.js";

const RESULT_BUDGET_CHARS = 12_000;
const RESULT_PROJECTION_WEIGHT = 1_200;
const RESULT_CHUNK_WEIGHT = 24_000;
const RESULT_CHUNK_MAX_CHARS = 24_000;
const RESULT_TTL_MS = 5 * 60 * 1000;
const MAX_STORED_RESULTS = 64;
const MAX_RESULT_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MAX_STORED_PAYLOAD_BYTES = 16 * 1024 * 1024;
const CAPSULE_META_KEY = "io.github.lennney/slim-guard";

type ResultContentKind = "plain-text" | "uniform-json" | "log-like" | "opaque-result";
type ResultEncoding = "single-text-v1" | "call-tool-result-json-v1";
type ProjectionName = "head-tail-v1" | "json-table-v1" | "log-summary-v1" | "json-prefix-v1";

interface ResultSnapshot {
  payload: string;
  encoding: ResultEncoding;
  contentKind: ResultContentKind;
  originalChars: number;
  resultShape?: Record<string, unknown>;
}

interface PreviewRange {
  start: number;
  end: number;
}

interface ResultProjection {
  name: ProjectionName;
  preview: string;
  previewRanges: PreviewRange[];
  nextCursor: number;
}

interface ResultContentClassifier {
  classify(result: CallToolResult, snapshot: ResultSnapshot): ResultContentKind;
}

interface ResultProjectionStrategy {
  readonly kind: ResultContentKind;
  project(snapshot: ResultSnapshot): ResultProjection;
}

interface StoredResult extends ResultSnapshot {
  expiresAt: number;
  payloadBytes: number;
}

interface ResultCapsuleMetadata extends Record<string, unknown> {
  result_ref: string;
  encoding: ResultEncoding;
  content_kind: ResultContentKind;
  projection: ProjectionName;
  result_shape?: Record<string, unknown>;
  original_chars: number;
  payload_chars: number;
  preview_chars: number;
  preview_ranges: PreviewRange[];
  replay_cursor: 0;
  next_cursor: number;
  delivery_verified: true;
  security: ResultSecurityAssessment;
}

interface ResultChunkMetadata extends Record<string, unknown> {
  result_ref: string;
  encoding: ResultEncoding;
  content_kind: ResultContentKind;
  cursor: number;
  next_cursor: number | null;
  done: boolean;
}

export type ResultDeliveryReason =
  | "within_budget"
  | "source_like"
  | "schema_bound"
  | "structured_result"
  | "upstream_error"
  | "metadata_bound"
  | "mixed_or_uncertain"
  | "capacity_exceeded"
  | "snapshot_verification_failed"
  | "delivery_verification_failed"
  | "internal_error";

export interface ResultDeliveryObservation {
  phase: "delivery";
  outcome: "pass_through" | "projected" | "fail_open";
  reason?: ResultDeliveryReason;
  referenceId?: string;
  encoding?: ResultEncoding;
  contentKind?: ResultContentKind;
  projection?: ProjectionName;
  originalChars?: number;
  payloadChars?: number;
  previewChars?: number;
  securityFindings?: number;
  evictedReferenceId?: string;
}

export interface ResultRecoveryObservation {
  phase: "recovery";
  outcome: "chunk" | "complete" | "rejected";
  reason?:
    | "missing_result_ref"
    | "invalid_cursor"
    | "unknown_result_ref"
    | "expired"
    | "cursor_out_of_range"
    | "unicode_boundary";
  referenceId?: string;
  encoding?: ResultEncoding;
  contentKind?: ResultContentKind;
  cursor?: number;
  nextCursor?: number | null;
  chunkChars?: number;
}

export type ResultCapsuleObservation = ResultDeliveryObservation | ResultRecoveryObservation;
export type ResultCapsuleObserver = (observation: ResultCapsuleObservation) => void;

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function referenceId(resultRef: string): string {
  return createHash("sha256").update(resultRef).digest("hex").slice(0, 16);
}

function emit(observer: ResultCapsuleObserver | undefined, observation: ResultCapsuleObservation): boolean {
  try {
    observer?.(observation);
    return true;
  } catch {
    return false;
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isSafeBoundary(value: string, cursor: number): boolean {
  if (cursor <= 0 || cursor >= value.length) return true;
  return !(isHighSurrogate(value.charCodeAt(cursor - 1)) && isLowSurrogate(value.charCodeAt(cursor)));
}

function codePointWidth(value: string, cursor: number): number {
  return (value.codePointAt(cursor) ?? 0) > 0xffff ? 2 : 1;
}

function codePointWeight(value: string, cursor: number): number {
  return (value.codePointAt(cursor) ?? 0) <= 0x7f ? 1 : 2;
}

function weightedEnd(value: string, cursor: number, budget: number, maxChars = Number.POSITIVE_INFINITY): number {
  let end = cursor;
  let weight = 0;
  while (end < value.length && end - cursor < maxChars) {
    const width = codePointWidth(value, end);
    const nextWeight = codePointWeight(value, end);
    if (weight + nextWeight > budget || end - cursor + width > maxChars) break;
    weight += nextWeight;
    end += width;
  }
  return end;
}

function weightedStart(value: string, end: number, budget: number): number {
  let start = end;
  let weight = 0;
  while (start > 0) {
    let candidate = start - 1;
    if (
      candidate > 0 &&
      isLowSurrogate(value.charCodeAt(candidate)) &&
      isHighSurrogate(value.charCodeAt(candidate - 1))
    ) {
      candidate -= 1;
    }
    const nextWeight = codePointWeight(value, candidate);
    if (weight + nextWeight > budget) break;
    weight += nextWeight;
    start = candidate;
  }
  return start;
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function simpleTextPayload(result: CallToolResult): { text: string; resultShape: Record<string, unknown> } | null {
  if (!hasOnlyKeys(result, ["content", "isError", "resultType"])) return null;
  if (result.isError === true) return null;
  const resultType = (result as Record<string, unknown>).resultType;
  if (resultType !== undefined && resultType !== "complete") return null;
  if (result.content.length !== 1) return null;
  const block = result.content[0];
  if (!block || block.type !== "text" || !hasOnlyKeys(block, ["type", "text"])) return null;
  const resultShape: Record<string, unknown> = {};
  for (const key of Object.keys(result)) {
    if (key !== "content") resultShape[key] = (result as Record<string, unknown>)[key];
  }
  return { text: block.text, resultShape };
}

/**
 * Native Tool delivery is deliberately narrower than the generic projection.
 * A lossy envelope cannot replace an advertised output contract or a result
 * whose shape the Host may interpret beyond one plain text block.
 */
function nativePassThroughReason(result: CallToolResult, tool: Tool): ResultDeliveryReason | null {
  const toolRecord = tool as Tool & Record<string, unknown>;
  if (toolRecord.outputSchema !== undefined) return "schema_bound";
  if (result.isError === true) return "upstream_error";
  if (result.structuredContent !== undefined) return "structured_result";
  if (result._meta !== undefined) return "metadata_bound";
  if (!hasOnlyKeys(result, ["content", "isError", "resultType"])) return "mixed_or_uncertain";
  if (
    (result as Record<string, unknown>).resultType !== undefined &&
    (result as Record<string, unknown>).resultType !== "complete"
  ) {
    return "mixed_or_uncertain";
  }
  return simpleTextPayload(result) === null ? "mixed_or_uncertain" : null;
}

function isPrimitive(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function parseUniformArray(value: string): Array<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return null;
  const rows = parsed as unknown[];
  if (
    rows.some(
      (row) =>
        row === null ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.values(row as Record<string, unknown>).some((cell) => !isPrimitive(cell)),
    )
  ) {
    return null;
  }
  const firstKeys = Object.keys(rows[0] as Record<string, unknown>);
  if (firstKeys.length === 0) return null;
  const keySignature = JSON.stringify(firstKeys);
  if (rows.some((row) => JSON.stringify(Object.keys(row as Record<string, unknown>)) !== keySignature)) return null;
  return rows as Array<Record<string, unknown>>;
}

const LOG_SIGNAL = /(?:^|\s)(?:trace|debug|info|warn(?:ing)?|error|fatal|failed?|exception)(?:\s|:|\]|$)/iu;
const CODE_SIGNAL =
  /(?:^|\n)\s*(?:diff --git|@@\s|[+-]{3}\s|(?:export\s+)?(?:class|function|interface)\s|(?:async\s+)?def\s+\w+\s*\(|(?:pub\s+)?fn\s+\w+\s*\(|func\s+\w+\s*\(|#include\s*[<"]|(?:public|private|protected)\s+(?:class|interface)\s|\w+\s*=>)/u;
const ANSI_PATTERN = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "gu");
const ANSI_SIGNAL = new RegExp(String.raw`\x1b\[[0-?]*[ -/]*[@-~]`, "u");

class DeterministicResultContentClassifier implements ResultContentClassifier {
  classify(_result: CallToolResult, snapshot: ResultSnapshot): ResultContentKind {
    if (snapshot.encoding !== "single-text-v1") return "opaque-result";
    if (parseUniformArray(snapshot.payload)) return "uniform-json";
    if (!CODE_SIGNAL.test(snapshot.payload)) {
      const lines = snapshot.payload.split(/\r?\n/u);
      const signals = lines.reduce((count, line) => count + (LOG_SIGNAL.test(line) ? 1 : 0), 0);
      if (
        lines.length >= 8 &&
        (signals >= 2 || ANSI_SIGNAL.test(snapshot.payload) || snapshot.payload.includes("\r"))
      ) {
        return "log-like";
      }
    }
    return "plain-text";
  }
}

function headTailProjection(snapshot: ResultSnapshot, name: ProjectionName = "head-tail-v1"): ResultProjection {
  const sideBudget = Math.floor((RESULT_PROJECTION_WEIGHT - 160) / 2);
  const headEnd = weightedEnd(snapshot.payload, 0, sideBudget);
  const tailStart = weightedStart(snapshot.payload, snapshot.payload.length, sideBudget);
  if (headEnd >= tailStart) {
    return {
      name,
      preview: snapshot.payload,
      previewRanges: [{ start: 0, end: snapshot.payload.length }],
      nextCursor: snapshot.payload.length,
    };
  }
  const omitted = tailStart - headEnd;
  return {
    name,
    preview: `${snapshot.payload.slice(0, headEnd)}\n[... ${omitted} chars omitted; exact result available via read_result ...]\n${snapshot.payload.slice(tailStart)}`,
    previewRanges: [
      { start: 0, end: headEnd },
      { start: tailStart, end: snapshot.payload.length },
    ],
    nextCursor: headEnd,
  };
}

class PlainTextProjectionStrategy implements ResultProjectionStrategy {
  readonly kind = "plain-text" as const;

  project(snapshot: ResultSnapshot): ResultProjection {
    return headTailProjection(snapshot);
  }
}

class UniformJsonProjectionStrategy implements ResultProjectionStrategy {
  readonly kind = "uniform-json" as const;

  project(snapshot: ResultSnapshot): ResultProjection {
    const rows = parseUniformArray(snapshot.payload);
    if (!rows) return headTailProjection(snapshot);
    const fields = Object.keys(rows[0]);
    const header = `JSON table (${rows.length} rows) fields=${JSON.stringify(fields)}\n`;
    let preview = header;
    let included = 0;
    for (const row of rows) {
      const line = `${fields.map((field) => JSON.stringify(row[field])).join("\t")}\n`;
      if (weightedEnd(preview + line, 0, RESULT_PROJECTION_WEIGHT) < preview.length + line.length) break;
      preview += line;
      included += 1;
    }
    if (included === rows.length || included === 0 || preview.length >= snapshot.payload.length) {
      return headTailProjection(snapshot);
    }
    preview += `[${rows.length - included} rows omitted; exact JSON available via read_result]`;
    return {
      name: "json-table-v1",
      preview,
      previewRanges: [],
      nextCursor: 0,
    };
  }
}

function normalizeLogLines(value: string): string[] {
  return value.split(/\n/u).map((physicalLine) => {
    const frames = physicalLine.split("\r").filter((frame) => frame.length > 0);
    return (frames.at(-1) ?? "").replace(ANSI_PATTERN, "");
  });
}

function collapseRepeatedLines(lines: string[]): Array<{ index: number; end: number; text: string }> {
  const collapsed: Array<{ index: number; end: number; text: string }> = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end += 1;
    const repeats = end - index;
    collapsed.push({
      index,
      end,
      text: repeats > 1 ? `${lines[index]} [repeated ${repeats} times]` : lines[index],
    });
    index = end;
  }
  return collapsed;
}

class LogProjectionStrategy implements ResultProjectionStrategy {
  readonly kind = "log-like" as const;

  project(snapshot: ResultSnapshot): ResultProjection {
    const collapsed = collapseRepeatedLines(normalizeLogLines(snapshot.payload));
    const selected = new Set<number>();
    for (const entry of collapsed.slice(0, 3)) selected.add(entry.index);
    for (const entry of collapsed.slice(-3)) selected.add(entry.index);
    for (const entry of collapsed) {
      if (LOG_SIGNAL.test(entry.text) && /warn|error|fatal|fail|exception/iu.test(entry.text))
        selected.add(entry.index);
    }

    const chosen = collapsed.filter((entry) => selected.has(entry.index));
    const output: string[] = ["Log projection (lossy; exact result available via read_result):"];
    let previousEnd = -1;
    for (const entry of chosen) {
      if (previousEnd >= 0 && entry.index > previousEnd) {
        output.push(`[${entry.index - previousEnd} lines omitted]`);
      }
      output.push(entry.text);
      previousEnd = entry.end;
    }
    const preview = output.join("\n");
    if (
      weightedEnd(preview, 0, RESULT_PROJECTION_WEIGHT) < preview.length ||
      preview.length >= snapshot.payload.length
    ) {
      return headTailProjection(snapshot);
    }
    return {
      name: "log-summary-v1",
      preview,
      previewRanges: [],
      nextCursor: 0,
    };
  }
}

class OpaqueProjectionStrategy implements ResultProjectionStrategy {
  readonly kind = "opaque-result" as const;

  project(snapshot: ResultSnapshot): ResultProjection {
    const end = weightedEnd(snapshot.payload, 0, RESULT_PROJECTION_WEIGHT);
    return {
      name: "json-prefix-v1",
      preview: snapshot.payload.slice(0, end),
      previewRanges: [{ start: 0, end }],
      nextCursor: end,
    };
  }
}

function createSnapshot(result: CallToolResult): ResultSnapshot {
  const serialized = JSON.stringify(result);
  const simpleText = simpleTextPayload(result);
  if (simpleText !== null) {
    return {
      payload: simpleText.text,
      encoding: "single-text-v1",
      contentKind: "plain-text",
      originalChars: serialized.length,
      resultShape: simpleText.resultShape,
    };
  }
  return {
    payload: serialized,
    encoding: "call-tool-result-json-v1",
    contentKind: "opaque-result",
    originalChars: serialized.length,
  };
}

function isSourceLikeSnapshot(snapshot: ResultSnapshot): boolean {
  return snapshot.encoding === "single-text-v1" && CODE_SIGNAL.test(snapshot.payload);
}

function verifySnapshot(snapshot: ResultSnapshot, serialized: string): boolean {
  if (snapshot.encoding === "call-tool-result-json-v1") return snapshot.payload === serialized;
  return (
    JSON.stringify({
      content: [{ type: "text", text: snapshot.payload }],
      ...snapshot.resultShape,
    }) === serialized
  );
}

function verifyCapsuleDelivery(
  delivered: CallToolResult,
  snapshot: ResultSnapshot,
  projection: ResultProjection,
  metadata: ResultCapsuleMetadata,
): boolean {
  const text = delivered.content[0];
  if (!text || text.type !== "text") return false;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text.text) as Record<string, unknown>;
  } catch {
    return false;
  }
  return (
    metadata.original_chars === snapshot.originalChars &&
    metadata.payload_chars === snapshot.payload.length &&
    metadata.encoding === snapshot.encoding &&
    metadata.content_kind === snapshot.contentKind &&
    metadata.projection === projection.name &&
    JSON.stringify(metadata.result_shape ?? {}) === JSON.stringify(snapshot.resultShape ?? {}) &&
    envelope.result_ref === metadata.result_ref &&
    envelope.preview === projection.preview &&
    delivered.structuredContent === metadata &&
    delivered._meta?.[CAPSULE_META_KEY] === metadata
  );
}

/**
 * Deep in-process module for fixed-policy, recoverable result compression.
 *
 * Oversized results are inspected and captured once. Simple text snapshots are
 * paged without JSON escaping; complex MCP results retain the exact serialized
 * object. Initial projections are deterministic and every lossy projection
 * points back to the immutable snapshot.
 */
export class ResultCapsuleStore {
  private results = new Map<string, StoredResult>();
  private resultOrder: string[] = [];
  private storedPayloadBytes = 0;
  private security = new ResultSecurityInspector();
  private classifier: ResultContentClassifier = new DeterministicResultContentClassifier();
  private strategies: Record<ResultContentKind, ResultProjectionStrategy> = {
    "plain-text": new PlainTextProjectionStrategy(),
    "uniform-json": new UniformJsonProjectionStrategy(),
    "log-like": new LogProjectionStrategy(),
    "opaque-result": new OpaqueProjectionStrategy(),
  };

  capture(result: CallToolResult, observer?: ResultCapsuleObserver): CallToolResult {
    try {
      return this.captureVerified(result, observer);
    } catch {
      // Result compression is post-invocation delivery optimization. An
      // internal classifier, projection, verification, or storage failure
      // must never turn a successful upstream tool call into a failed call.
      emit(observer, {
        phase: "delivery",
        outcome: "fail_open",
        reason: "internal_error",
      });
      return result;
    }
  }

  /**
   * Capture a result for the native Tool surface. Only a verified plain text
   * result may be projected; schema-bound, structured, mixed, error, source,
   * and uncertain results stay byte-for-byte on the original path.
   */
  captureNative(result: CallToolResult, tool: Tool, observer?: ResultCapsuleObserver): CallToolResult {
    const passThroughReason = nativePassThroughReason(result, tool);
    if (passThroughReason) {
      emit(observer, {
        phase: "delivery",
        outcome: "pass_through",
        reason: passThroughReason,
      });
      return result;
    }
    return this.capture(result, observer);
  }

  private captureVerified(result: CallToolResult, observer?: ResultCapsuleObserver): CallToolResult {
    const security = this.security.inspect(result);
    const serialized = JSON.stringify(result);
    if (serialized.length <= RESULT_BUDGET_CHARS) {
      emit(observer, {
        phase: "delivery",
        outcome: "pass_through",
        reason: "within_budget",
        originalChars: serialized.length,
        securityFindings: security.findings.length,
      });
      return result;
    }

    const snapshot = createSnapshot(result);
    if (!verifySnapshot(snapshot, serialized)) {
      emit(observer, {
        phase: "delivery",
        outcome: "fail_open",
        reason: "snapshot_verification_failed",
        originalChars: serialized.length,
        securityFindings: security.findings.length,
      });
      return result;
    }
    if (isSourceLikeSnapshot(snapshot)) {
      emit(observer, {
        phase: "delivery",
        outcome: "pass_through",
        reason: "source_like",
        encoding: snapshot.encoding,
        contentKind: snapshot.contentKind,
        originalChars: snapshot.originalChars,
        payloadChars: snapshot.payload.length,
        securityFindings: security.findings.length,
      });
      return result;
    }
    if (Buffer.byteLength(snapshot.payload, "utf8") > MAX_RESULT_PAYLOAD_BYTES) {
      emit(observer, {
        phase: "delivery",
        outcome: "fail_open",
        reason: "capacity_exceeded",
        encoding: snapshot.encoding,
        contentKind: snapshot.contentKind,
        originalChars: snapshot.originalChars,
        payloadChars: snapshot.payload.length,
        securityFindings: security.findings.length,
      });
      return result;
    }
    snapshot.contentKind = this.classifier.classify(result, snapshot);

    const projection = this.strategies[snapshot.contentKind].project(snapshot);

    const resultRef = `result_${randomBytes(16).toString("hex")}`;
    const metadata: ResultCapsuleMetadata = {
      result_ref: resultRef,
      encoding: snapshot.encoding,
      content_kind: snapshot.contentKind,
      projection: projection.name,
      ...(snapshot.resultShape && Object.keys(snapshot.resultShape).length > 0
        ? { result_shape: snapshot.resultShape }
        : {}),
      original_chars: snapshot.originalChars,
      payload_chars: snapshot.payload.length,
      preview_chars: projection.preview.length,
      preview_ranges: projection.previewRanges,
      replay_cursor: 0,
      next_cursor: projection.nextCursor,
      delivery_verified: true,
      security,
    };

    const delivered: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...metadata,
            preview: projection.preview,
            message: "Large result projected. Use read_result for the exact captured snapshot.",
          }),
        },
      ],
      isError: result.isError,
      structuredContent: metadata,
      _meta: {
        [CAPSULE_META_KEY]: metadata,
      },
    };
    if (snapshot.resultShape?.resultType !== undefined) {
      (delivered as CallToolResult & Record<string, unknown>).resultType = snapshot.resultShape.resultType;
    }
    if (!verifyCapsuleDelivery(delivered, snapshot, projection, metadata)) {
      emit(observer, {
        phase: "delivery",
        outcome: "fail_open",
        reason: "delivery_verification_failed",
        encoding: snapshot.encoding,
        contentKind: snapshot.contentKind,
        projection: projection.name,
        originalChars: snapshot.originalChars,
        payloadChars: snapshot.payload.length,
        previewChars: projection.preview.length,
        securityFindings: security.findings.length,
      });
      return result;
    }
    const evictedReferenceId = this.store(resultRef, snapshot);
    const observed = emit(observer, {
      phase: "delivery",
      outcome: "projected",
      referenceId: referenceId(resultRef),
      encoding: snapshot.encoding,
      contentKind: snapshot.contentKind,
      projection: projection.name,
      originalChars: snapshot.originalChars,
      payloadChars: snapshot.payload.length,
      previewChars: projection.preview.length,
      securityFindings: security.findings.length,
      ...(evictedReferenceId ? { evictedReferenceId } : {}),
    });
    if (!observed) {
      this.delete(resultRef);
      return result;
    }
    return delivered;
  }

  read(args: Record<string, unknown>, observer?: ResultCapsuleObserver): CallToolResult {
    const resultRef = typeof args.result_ref === "string" ? args.result_ref : "";
    const cursor = args.cursor === undefined ? 0 : args.cursor;
    if (!resultRef) {
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "missing_result_ref",
      });
      return errorResult("Missing required parameter: result_ref");
    }
    const resultReferenceId = referenceId(resultRef);
    if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "invalid_cursor",
        referenceId: resultReferenceId,
      });
      return errorResult("cursor must be a non-negative integer");
    }

    const stored = this.results.get(resultRef);
    if (!stored) {
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "unknown_result_ref",
        referenceId: resultReferenceId,
      });
      return errorResult("Unknown or expired result_ref.");
    }
    if (stored.expiresAt <= Date.now()) {
      this.delete(resultRef);
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "expired",
        referenceId: resultReferenceId,
      });
      return errorResult("Unknown or expired result_ref.");
    }
    if (cursor > stored.payload.length) {
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "cursor_out_of_range",
        referenceId: resultReferenceId,
        cursor,
      });
      return errorResult("cursor is beyond the captured result.");
    }
    if (!isSafeBoundary(stored.payload, cursor)) {
      emit(observer, {
        phase: "recovery",
        outcome: "rejected",
        reason: "unicode_boundary",
        referenceId: resultReferenceId,
        cursor,
      });
      return errorResult("cursor splits a Unicode character.");
    }

    const nextCursor = weightedEnd(stored.payload, cursor, RESULT_CHUNK_WEIGHT, RESULT_CHUNK_MAX_CHARS);
    const done = nextCursor >= stored.payload.length;
    const metadata: ResultChunkMetadata = {
      result_ref: resultRef,
      encoding: stored.encoding,
      content_kind: stored.contentKind,
      cursor,
      next_cursor: done ? null : nextCursor,
      done,
    };

    emit(observer, {
      phase: "recovery",
      outcome: done ? "complete" : "chunk",
      referenceId: resultReferenceId,
      encoding: stored.encoding,
      contentKind: stored.contentKind,
      cursor,
      nextCursor: done ? null : nextCursor,
      chunkChars: nextCursor - cursor,
    });

    return {
      content: [
        { type: "text", text: stored.payload.slice(cursor, nextCursor) },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    };
  }

  clear(): number {
    const cleared = this.results.size;
    this.results.clear();
    this.resultOrder = [];
    this.storedPayloadBytes = 0;
    return cleared;
  }

  /** Remove the snapshot behind a projection that was not delivered. */
  discardProjection(result: CallToolResult): boolean {
    const metadata = result.structuredContent;
    const capsuleMetadata = result._meta?.[CAPSULE_META_KEY];
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !capsuleMetadata ||
      typeof capsuleMetadata !== "object" ||
      (capsuleMetadata as Record<string, unknown>).result_ref !== (metadata as Record<string, unknown>).result_ref
    ) {
      return false;
    }
    const resultRef = (metadata as Record<string, unknown>).result_ref;
    if (typeof resultRef !== "string" || !this.results.has(resultRef)) return false;
    this.delete(resultRef);
    return true;
  }

  private store(resultRef: string, snapshot: ResultSnapshot): string | undefined {
    const now = Date.now();
    this.pruneExpired(now);
    let evictedReferenceId: string | undefined;
    const payloadBytes = Buffer.byteLength(snapshot.payload, "utf8");
    while (
      this.resultOrder.length > 0 &&
      (this.resultOrder.length >= MAX_STORED_RESULTS ||
        this.storedPayloadBytes + payloadBytes > MAX_STORED_PAYLOAD_BYTES)
    ) {
      const oldest = this.resultOrder[0];
      if (!oldest) break;
      this.delete(oldest);
      evictedReferenceId = referenceId(oldest);
    }
    this.results.set(resultRef, {
      ...snapshot,
      expiresAt: now + RESULT_TTL_MS,
      payloadBytes,
    });
    this.storedPayloadBytes += payloadBytes;
    this.resultOrder.push(resultRef);
    return evictedReferenceId;
  }

  private pruneExpired(now: number): void {
    for (const [resultRef, stored] of this.results) {
      if (stored.expiresAt <= now) this.delete(resultRef);
    }
  }

  private delete(resultRef: string): void {
    const stored = this.results.get(resultRef);
    if (stored) {
      this.storedPayloadBytes = Math.max(0, this.storedPayloadBytes - stored.payloadBytes);
    }
    this.results.delete(resultRef);
    this.resultOrder = this.resultOrder.filter((candidate) => candidate !== resultRef);
  }
}
