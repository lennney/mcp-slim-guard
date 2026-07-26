import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ResultCapsuleStore } from "../../src/result-capsule-store.js";

function parseText(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

describe("ResultCapsuleStore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a bounded result through without changing its MCP fields", () => {
    const store = new ResultCapsuleStore();
    const result = {
      content: [{ type: "text" as const, text: "ok" }],
      structuredContent: { count: 1 },
      _meta: { traceId: "trace-1" },
      extension: "preserved",
    };

    expect(store.capture(result)).toBe(result);
  });

  it("carries the initial preview once and resumes after it", () => {
    const store = new ResultCapsuleStore();
    const original: CallToolResult = {
      content: [{ type: "text", text: "中🙂abc".repeat(4_000) }],
      _meta: { large: "metadata".repeat(2_000) },
    };

    const delivered = store.capture(original);
    const capsule = parseText(delivered);
    const structured = delivered.structuredContent as Record<string, unknown>;
    const metadata = delivered._meta?.["io.github.lennney/slim-guard"] as Record<string, unknown>;

    expect(capsule.preview).toBeTypeOf("string");
    expect(capsule.next_cursor).toBe((capsule.preview as string).length);
    expect(structured).not.toHaveProperty("preview");
    expect(metadata).not.toHaveProperty("preview");
    expect(delivered._meta).not.toHaveProperty("large");

    const chunks = [capsule.preview as string];
    let cursor = capsule.next_cursor as number;
    for (let page = 0; page < 20; page++) {
      const body = parseText(store.read({ result_ref: capsule.result_ref, cursor }));
      chunks.push(body.chunk as string);
      if (body.done) break;
      cursor = body.next_cursor as number;
    }

    expect(JSON.parse(chunks.join(""))).toEqual(original);
  });

  it("never splits a Unicode surrogate pair at a generated boundary", () => {
    const store = new ResultCapsuleStore();
    const probe: CallToolResult = { content: [{ type: "text", text: "X" }] };
    const textStart = JSON.stringify(probe).indexOf("X");
    const original: CallToolResult = {
      content: [{ type: "text", text: `${"a".repeat(999 - textStart)}🙂${"b".repeat(15_000)}` }],
    };

    const delivered = store.capture(original);
    const capsule = parseText(delivered);
    const preview = capsule.preview as string;

    expect(preview).toHaveLength(999);
    expect(preview.charCodeAt(preview.length - 1)).not.toBeGreaterThanOrEqual(0xd800);

    const splitCursor = (capsule.next_cursor as number) + 1;
    const rejected = store.read({ result_ref: capsule.result_ref, cursor: splitCursor });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]).toMatchObject({
      type: "text",
      text: "cursor splits a Unicode character.",
    });
  });

  it("invalidates every captured result when cleared", () => {
    const store = new ResultCapsuleStore();
    const capsule = parseText(
      store.capture({
        content: [{ type: "text", text: "x".repeat(20_000) }],
      }),
    );

    store.clear();

    expect(store.read({ result_ref: capsule.result_ref }).isError).toBe(true);
  });

  it("expires results and evicts the oldest entry at the fixed capacity", () => {
    vi.useFakeTimers();
    const store = new ResultCapsuleStore();
    const refs: string[] = [];
    for (let index = 0; index < 65; index++) {
      const capsule = parseText(
        store.capture({
          content: [{ type: "text", text: `${index}:${"x".repeat(20_000)}` }],
        }),
      );
      refs.push(capsule.result_ref as string);
    }

    expect(store.read({ result_ref: refs[0] }).isError).toBe(true);
    expect(store.read({ result_ref: refs[64] }).isError).not.toBe(true);

    vi.advanceTimersByTime(5 * 60 * 1_000 + 1);
    expect(store.read({ result_ref: refs[64] }).isError).toBe(true);
  });
});
