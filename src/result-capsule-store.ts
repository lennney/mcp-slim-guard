/**
 * Lossless, bounded delivery for oversized MCP tool results.
 *
 * This module owns the capture threshold, preview and chunk boundaries,
 * expiry, capacity, recovery references, and capsule wire shape. Callers only
 * decide when to capture and when to read.
 *
 * @module result-capsule-store
 */

import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ResultSecurityInspector, type ResultSecurityAssessment } from "./result-security.js";

const RESULT_BUDGET_CHARS = 12_000;
const RESULT_PREVIEW_CHARS = 1_000;
const RESULT_CHUNK_CHARS = 12_000;
const RESULT_TTL_MS = 5 * 60 * 1000;
const MAX_STORED_RESULTS = 64;
const CAPSULE_META_KEY = "io.github.lennney/slim-guard";

interface StoredResult {
  serialized: string;
  expiresAt: number;
}

interface ResultCapsuleMetadata extends Record<string, unknown> {
  result_ref: string;
  original_chars: number;
  preview_chars: number;
  next_cursor: number;
  delivery_verified: true;
  security: ResultSecurityAssessment;
}

interface ResultChunkMetadata extends Record<string, unknown> {
  result_ref: string;
  cursor: number;
  next_cursor: number | null;
  done: boolean;
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
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

function boundedEnd(value: string, cursor: number, budget: number): number {
  let end = Math.min(cursor + budget, value.length);
  if (!isSafeBoundary(value, end)) end -= 1;
  return end;
}

function verifyCapsuleDelivery(
  delivered: CallToolResult,
  serialized: string,
  preview: string,
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
    preview === serialized.slice(0, metadata.next_cursor) &&
    metadata.original_chars === serialized.length &&
    envelope.result_ref === metadata.result_ref &&
    envelope.preview === preview &&
    delivered.structuredContent === metadata &&
    delivered._meta?.[CAPSULE_META_KEY] === metadata
  );
}

/**
 * Deep in-process module for fixed-policy, recoverable result compression.
 *
 * Oversized results are serialized exactly once. The initial response carries
 * one exact prefix plus an opaque continuation cursor; later reads return
 * slices from that same snapshot and never invoke the upstream tool again.
 */
export class ResultCapsuleStore {
  private results = new Map<string, StoredResult>();
  private resultOrder: string[] = [];
  private security = new ResultSecurityInspector();

  capture(result: CallToolResult): CallToolResult {
    const security = this.security.inspect(result);
    const securedResult =
      security.findings.length === 0
        ? result
        : {
            ...result,
            _meta: {
              ...result._meta,
              [CAPSULE_META_KEY]: {
                ...((result._meta?.[CAPSULE_META_KEY] as Record<string, unknown> | undefined) ?? {}),
                security,
              },
            },
          };
    const serialized = JSON.stringify(securedResult);
    if (serialized.length <= RESULT_BUDGET_CHARS) return securedResult;

    const resultRef = `result_${randomBytes(16).toString("hex")}`;
    this.store(resultRef, serialized);

    const previewEnd = boundedEnd(serialized, 0, RESULT_PREVIEW_CHARS);
    const preview = serialized.slice(0, previewEnd);
    const metadata: ResultCapsuleMetadata = {
      result_ref: resultRef,
      original_chars: serialized.length,
      preview_chars: preview.length,
      next_cursor: previewEnd,
      delivery_verified: true,
      security,
    };

    const delivered: CallToolResult = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ...metadata,
            preview,
            message: "Large result captured. Continue read_result from next_cursor.",
          }),
        },
      ],
      isError: result.isError,
      structuredContent: metadata,
      _meta: {
        [CAPSULE_META_KEY]: metadata,
      },
    };
    if (!verifyCapsuleDelivery(delivered, serialized, preview, metadata)) {
      this.delete(resultRef);
      return securedResult;
    }
    return delivered;
  }

  read(args: Record<string, unknown>): CallToolResult {
    const resultRef = typeof args.result_ref === "string" ? args.result_ref : "";
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    if (!resultRef) return errorResult("Missing required parameter: result_ref");
    if (!Number.isInteger(cursor) || cursor < 0) return errorResult("cursor must be a non-negative integer");

    const stored = this.results.get(resultRef);
    if (!stored || stored.expiresAt <= Date.now()) {
      if (stored) this.delete(resultRef);
      return errorResult("Unknown or expired result_ref.");
    }
    if (cursor > stored.serialized.length) {
      return errorResult("cursor is beyond the captured result.");
    }
    if (!isSafeBoundary(stored.serialized, cursor)) {
      return errorResult("cursor splits a Unicode character.");
    }

    const nextCursor = boundedEnd(stored.serialized, cursor, RESULT_CHUNK_CHARS);
    const done = nextCursor >= stored.serialized.length;
    const metadata: ResultChunkMetadata = {
      result_ref: resultRef,
      cursor,
      next_cursor: done ? null : nextCursor,
      done,
    };

    return {
      content: [
        { type: "text", text: stored.serialized.slice(cursor, nextCursor) },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    };
  }

  clear(): void {
    this.results.clear();
    this.resultOrder = [];
  }

  private store(resultRef: string, serialized: string): void {
    this.results.set(resultRef, {
      serialized,
      expiresAt: Date.now() + RESULT_TTL_MS,
    });
    this.resultOrder.push(resultRef);
    while (this.resultOrder.length > MAX_STORED_RESULTS) {
      const oldest = this.resultOrder.shift();
      if (oldest) this.results.delete(oldest);
    }
  }

  private delete(resultRef: string): void {
    this.results.delete(resultRef);
    this.resultOrder = this.resultOrder.filter((candidate) => candidate !== resultRef);
  }
}
