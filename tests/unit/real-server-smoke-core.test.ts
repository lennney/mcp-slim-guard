import { describe, expect, it, vi } from "vitest";
import {
  assertThreeToolSurface,
  describeResult,
  recoverCapturedResult,
} from "../../scripts/integration/real-server-smoke-core.mjs";

describe("real MCP server smoke helpers", () => {
  it("accepts only the fixed three-tool Slim Guard surface", () => {
    expect(
      assertThreeToolSurface({
        tools: [{ name: "read_result" }, { name: "find_tool" }, { name: "call_tool" }],
      }),
    ).toEqual(["call_tool", "find_tool", "read_result"]);
    expect(() => assertThreeToolSurface({ tools: [{ name: "call_tool" }] })).toThrow(
      "Unexpected Slim Guard tool surface",
    );
  });

  it("reconstructs a paged opaque MCP result without another upstream call", async () => {
    const original = {
      content: [
        { type: "text", text: "marker" },
        { type: "resource", resource: { uri: "fixture://result", text: "payload" } },
      ],
      structuredContent: { ok: true },
    };
    const serialized = JSON.stringify(original);
    const midpoint = Math.floor(serialized.length / 2);
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: serialized.slice(0, midpoint) },
          {
            type: "text",
            text: JSON.stringify({ done: false, next_cursor: midpoint }),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: serialized.slice(midpoint) },
          { type: "text", text: JSON.stringify({ done: true, next_cursor: null }) },
        ],
      });

    const recovered = await recoverCapturedResult(
      { callTool },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              result_ref: "result_fixture",
              encoding: "call-tool-result-json-v1",
              content_kind: "opaque-result",
              projection: "json-prefix-v1",
            }),
          },
        ],
      },
    );

    expect(recovered.result).toEqual(original);
    expect(recovered.read_result_calls).toBe(2);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("describes structured and multi-block results", () => {
    expect(
      describeResult({
        content: [
          { type: "text", text: "ok" },
          { type: "resource", resource: {} },
        ],
        structuredContent: { ok: true },
        _meta: { fixture: true },
      }),
    ).toMatchObject({
      content_types: ["text", "resource"],
      content_blocks: 2,
      has_structured_content: true,
      has_meta: true,
      is_error: false,
    });
  });
});
