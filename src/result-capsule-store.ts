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

const RESULT_BUDGET_CHARS = 12_000;
const RESULT_PREVIEW_CHARS = 1_000;
const RESULT_CHUNK_CHARS = 8_000;
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
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
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

  capture(result: CallToolResult): CallToolResult {
    const serialized = JSON.stringify(result);
    if (serialized.length <= RESULT_BUDGET_CHARS) return result;

    const resultRef = `result_${randomBytes(16).toString("hex")}`;
    this.store(resultRef, serialized);

    const previewEnd = boundedEnd(serialized, 0, RESULT_PREVIEW_CHARS);
    const preview = serialized.slice(0, previewEnd);
    const metadata: ResultCapsuleMetadata = {
      result_ref: resultRef,
      original_chars: serialized.length,
      preview_chars: preview.length,
      next_cursor: previewEnd,
    };

    return {
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

    return jsonResult({
      result_ref: resultRef,
      cursor,
      next_cursor: done ? null : nextCursor,
      done,
      chunk: stored.serialized.slice(cursor, nextCursor),
    });
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
