import assert from "node:assert/strict";
import { get_encoding } from "tiktoken";
import { SecureProjectionKernel } from "../../dist/secure-projection.js";

const META_KEY = "io.github.lennney/slim-guard";
const RESULT_REF_PATTERN = /result_[a-f0-9]{32}/gu;
const NORMALIZED_RESULT_REF = `result_${"0".repeat(32)}`;
const encoding = get_encoding("cl100k_base");
const tools = [
  {
    name: "fixture_large_result",
    description: "Return a large multilingual fixture",
    inputSchema: { type: "object", properties: {} },
  },
];
const upstreamResult = {
  content: [
    {
      type: "text",
      text: "evidence 中文 🙂 https://example.com/item/42\n".repeat(1_000),
    },
  ],
  isError: false,
  structuredContent: { fixture: true, count: 1_000 },
  _meta: { traceId: "fixture-trace" },
};

function parseText(result) {
  const content = result.content[0];
  assert.equal(content.type, "text");
  return JSON.parse(content.text);
}

function tokens(value) {
  const stableWire = JSON.stringify(value).replace(RESULT_REF_PATTERN, NORMALIZED_RESULT_REF);
  return encoding.encode(stableWire).length;
}

async function retrieveCurrent(kernel, resultRef, cursor, prefix) {
  const chunks = [prefix];
  let calls = 0;
  let responseTokens = 0;
  let nextCursor = cursor;

  while (nextCursor !== null) {
    const response = await kernel.call(
      "read_result",
      { result_ref: resultRef, cursor: nextCursor },
      async () => upstreamResult,
    );
    responseTokens += tokens(response);
    calls += 1;
    chunks.push(response.content[0].text);
    nextCursor = response.structuredContent.next_cursor;
  }

  return {
    calls,
    responseTokens,
    serialized: chunks.join(""),
  };
}

function retrieveLegacy(serialized, resultRef) {
  const chunks = [];
  let calls = 0;
  let responseTokens = 0;
  let cursor = 0;

  while (cursor < serialized.length) {
    const chunk = serialized.slice(cursor, cursor + 8_000);
    const nextCursor = cursor + chunk.length;
    const done = nextCursor >= serialized.length;
    const response = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result_ref: resultRef,
            cursor,
            next_cursor: done ? null : nextCursor,
            done,
            chunk,
          }),
        },
      ],
    };
    responseTokens += tokens(response);
    calls += 1;
    chunks.push(chunk);
    cursor = nextCursor;
  }

  return {
    calls,
    responseTokens,
    serialized: chunks.join(""),
  };
}

const kernel = new SecureProjectionKernel(tools);
const found = parseText(await kernel.call("find_tool", { query: "large result" }, async () => upstreamResult));
const toolRef = found.matches[0].tool_ref;
const delivered = await kernel.call("call_tool", { tool_ref: toolRef, arguments: {} }, async () => upstreamResult);
const capsule = parseText(delivered);

const currentRecovery = await retrieveCurrent(kernel, capsule.result_ref, capsule.next_cursor, capsule.preview);
assert.deepEqual(JSON.parse(currentRecovery.serialized), upstreamResult);

const legacyCapsule = {
  result_ref: capsule.result_ref,
  original_chars: capsule.original_chars,
  preview: capsule.preview,
  next_cursor: 0,
};
const legacyInitial = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        ...legacyCapsule,
        message: "Large result captured. Use read_result with result_ref to retrieve bounded chunks.",
      }),
    },
  ],
  isError: upstreamResult.isError,
  structuredContent: legacyCapsule,
  _meta: {
    ...upstreamResult._meta,
    [META_KEY]: legacyCapsule,
  },
};
const legacyRecovery = retrieveLegacy(JSON.stringify(upstreamResult), capsule.result_ref);
assert.deepEqual(JSON.parse(legacyRecovery.serialized), upstreamResult);

const legacyInitialTokens = tokens(legacyInitial);
const currentInitialTokens = tokens(delivered);
const legacyTotalTokens = legacyInitialTokens + legacyRecovery.responseTokens;
const currentTotalTokens = currentInitialTokens + currentRecovery.responseTokens;

console.log(
  JSON.stringify(
    {
      fixture: {
        serialized_chars: JSON.stringify(upstreamResult).length,
        encoding: "cl100k_base",
      },
      legacy_reference: {
        initial_tokens: legacyInitialTokens,
        retrieval_calls: legacyRecovery.calls,
        total_delivery_tokens: legacyTotalTokens,
      },
      slim_guard: {
        initial_tokens: currentInitialTokens,
        retrieval_calls: currentRecovery.calls,
        total_delivery_tokens: currentTotalTokens,
      },
      reduction: {
        initial_percent: Number(
          (((legacyInitialTokens - currentInitialTokens) / legacyInitialTokens) * 100).toFixed(2),
        ),
        total_delivery_percent: Number(
          (((legacyTotalTokens - currentTotalTokens) / legacyTotalTokens) * 100).toFixed(2),
        ),
      },
      exact_recovery: true,
    },
    null,
    2,
  ),
);

encoding.free();
