import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { get_encoding } from "tiktoken";
import { ResultCapsuleStore } from "../../dist/result-capsule-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = path.join(ROOT, "docs/evidence/2026-07-26-content-projection-capture.json");
const RESULT_REF_PATTERN = /result_[a-f0-9]{32}/gu;
const NORMALIZED_RESULT_REF = `result_${"0".repeat(32)}`;
const TOKENIZER = "o200k_base";
const encoding = get_encoding(TOKENIZER);

function parseCapsule(result) {
  assert.equal(result.content[0]?.type, "text");
  const capsule = JSON.parse(result.content[0].text);
  assert.equal(typeof capsule.result_ref, "string");
  return capsule;
}

function normalizedWire(value) {
  return JSON.stringify(value).replace(RESULT_REF_PATTERN, NORMALIZED_RESULT_REF);
}

function tokens(value) {
  return encoding.encode(normalizedWire(value)).length;
}

function readAll(store, capsule) {
  const chunks = [];
  let cursor = capsule.replay_cursor;
  let calls = 0;
  let responseTokens = 0;
  while (cursor !== null) {
    const response = store.read({ result_ref: capsule.result_ref, cursor });
    assert.notEqual(response.isError, true);
    chunks.push(response.content[0].text);
    responseTokens += tokens(response);
    calls += 1;
    cursor = response.structuredContent.next_cursor;
  }
  return { payload: chunks.join(""), calls, responseTokens };
}

function readUntilMarker(store, delivered, capsule, marker) {
  const initial = normalizedWire(delivered);
  if (initial.includes(marker)) return { found: true, calls: 0, responseTokens: 0 };

  let cursor = capsule.next_cursor;
  let calls = 0;
  let responseTokens = 0;
  while (cursor !== null) {
    const response = store.read({ result_ref: capsule.result_ref, cursor });
    assert.notEqual(response.isError, true);
    calls += 1;
    responseTokens += tokens(response);
    if (normalizedWire(response).includes(marker)) return { found: true, calls, responseTokens };
    cursor = response.structuredContent.next_cursor;
  }
  return { found: false, calls, responseTokens };
}

function reconstruct(capsule, payload) {
  return capsule.encoding === "single-text-v1"
    ? { content: [{ type: "text", text: payload }], ...(capsule.result_shape ?? {}) }
    : JSON.parse(payload);
}

function positionedText(id, language, position) {
  const marker = `NEEDLE:${id}`;
  const unit = language === "zh" ? "这是确定性压缩评测正文。" : "Deterministic compression benchmark context. ";
  const source = unit.repeat(language === "zh" ? 2_500 : 900);
  const cursor = Math.floor(source.length * position);
  return {
    id,
    category: "plain-text",
    marker,
    expectedKind: "plain-text",
    result: { content: [{ type: "text", text: `${source.slice(0, cursor)}${marker}${source.slice(cursor)}` }] },
  };
}

const plainCases = [
  ...[0, 0.25, 0.5, 0.75, 1].map((position, index) => positionedText(`plain-en-${index}`, "en", position)),
  ...[0, 0.25, 0.5, 0.75, 1].map((position, index) => positionedText(`plain-zh-${index}`, "zh", position)),
];

const uniformRows = Array.from({ length: 1_000 }, (_, index) => ({
  id: index,
  state: index % 2 === 0 ? "open" : "closed",
  owner: `team-${index % 12}`,
}));
uniformRows[500].owner = "NEEDLE:uniform-json";

const heterogeneousRows = Array.from({ length: 800 }, (_, index) =>
  index % 2 === 0 ? { id: index, value: `v-${index}` } : { id: index, status: "ok", extra: index },
);
heterogeneousRows[400].marker = "NEEDLE:heterogeneous-json";

const structuredCases = [
  {
    id: "uniform-json",
    category: "json",
    marker: "NEEDLE:uniform-json",
    expectedKind: "uniform-json",
    result: { content: [{ type: "text", text: JSON.stringify(uniformRows) }] },
  },
  {
    id: "heterogeneous-json",
    category: "json",
    marker: "NEEDLE:heterogeneous-json",
    expectedKind: "plain-text",
    result: { content: [{ type: "text", text: JSON.stringify(heterogeneousRows) }] },
  },
  {
    id: "deep-json",
    category: "json",
    marker: "NEEDLE:deep-json",
    expectedKind: "plain-text",
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            root: {
              nested: {
                values: Array.from({ length: 3_000 }, (_, index) =>
                  index === 1_500 ? "NEEDLE:deep-json" : `value-${index}`,
                ),
              },
            },
          }),
        },
      ],
    },
  },
  {
    id: "invalid-json",
    category: "json",
    marker: "NEEDLE:invalid-json",
    expectedKind: "plain-text",
    result: {
      content: [
        {
          type: "text",
          text: `{"items":[${Array.from({ length: 4_000 }, (_, index) => `"value-${index}"`).join(",")} BROKEN NEEDLE:invalid-json`,
        },
      ],
    },
  },
];

const logCases = [
  {
    id: "repeated-log",
    marker: "NEEDLE:repeated-log",
    lines: [
      "INFO build started",
      ...Array.from({ length: 1_000 }, () => "INFO dependency cached"),
      "WARN NEEDLE:repeated-log retry scheduled",
      "INFO build finished",
    ],
  },
  {
    id: "progress-log",
    marker: "NEEDLE:progress-log",
    lines: [
      "INFO download started",
      `${Array.from({ length: 500 }, (_, index) => `progress ${index}/500`).join("\r")}\rINFO download complete`,
      ...Array.from({ length: 1_000 }, (_, index) => `DEBUG file ${index}`),
      "ERROR NEEDLE:progress-log checksum mismatch",
    ],
  },
  {
    id: "stack-log",
    marker: "NEEDLE:stack-log",
    lines: [
      "INFO request accepted",
      ...Array.from({ length: 1_500 }, (_, index) => `DEBUG step ${index}`),
      "ERROR NEEDLE:stack-log request failed",
      "Exception: synthetic failure",
      "  at fixture (fixture.ts:10:2)",
      "INFO shutdown",
    ],
  },
  {
    id: "bilingual-log",
    marker: "NEEDLE:bilingual-log",
    lines: [
      "INFO 服务启动",
      ...Array.from({ length: 1_500 }, (_, index) => `DEBUG 处理记录 ${index}`),
      "WARN NEEDLE:bilingual-log 正在重试",
      "ERROR 请求失败",
      "INFO 服务停止",
    ],
  },
].map((entry) => ({
  id: entry.id,
  category: "log",
  marker: entry.marker,
  expectedKind: "log-like",
  result: { content: [{ type: "text", text: entry.lines.join("\n") }] },
}));

const opaqueCases = [
  {
    id: "multi-block",
    category: "mcp-result",
    marker: "NEEDLE:multi-block",
    expectedKind: "opaque-result",
    result: {
      content: [
        { type: "text", text: `NEEDLE:multi-block\n${"text\n".repeat(3_000)}` },
        { type: "resource_link", uri: "https://example.com/report", name: "report" },
      ],
    },
  },
  {
    id: "image-block",
    category: "mcp-result",
    marker: "NEEDLE:image-block",
    expectedKind: "opaque-result",
    result: {
      content: [
        { type: "text", text: "NEEDLE:image-block" },
        { type: "image", data: "YQ==".repeat(5_000), mimeType: "image/png" },
      ],
    },
  },
  {
    id: "structured-content",
    category: "mcp-result",
    marker: "NEEDLE:structured-content",
    expectedKind: "opaque-result",
    result: {
      content: [{ type: "text", text: "summary" }],
      structuredContent: {
        rows: Array.from({ length: 2_000 }, (_, index) =>
          index === 1_000 ? "NEEDLE:structured-content" : `row-${index}`,
        ),
      },
    },
  },
  {
    id: "metadata",
    category: "mcp-result",
    marker: "NEEDLE:metadata",
    expectedKind: "opaque-result",
    result: {
      content: [{ type: "text", text: "metadata fixture" }],
      _meta: { trace: `${"x".repeat(14_000)}NEEDLE:metadata` },
      extension: { future: true },
    },
  },
  {
    id: "error-result",
    category: "mcp-result",
    marker: "NEEDLE:error-result",
    expectedKind: "opaque-result",
    result: {
      content: [{ type: "text", text: `${"failure context\n".repeat(1_000)}NEEDLE:error-result` }],
      isError: true,
    },
  },
];

const CASES = [...plainCases, ...structuredCases, ...logCases, ...opaqueCases];

function runCase(fixture) {
  const store = new ResultCapsuleStore();
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const delivered = store.capture(fixture.result);
  const elapsed = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  const capsule = parseCapsule(delivered);
  const oneChunk = store.read({ result_ref: capsule.result_ref, cursor: capsule.replay_cursor });
  const targeted = readUntilMarker(store, delivered, capsule, fixture.marker);
  const recovered = readAll(store, capsule);
  const reconstructed = reconstruct(capsule, recovered.payload);
  assert.deepEqual(reconstructed, fixture.result);
  assert.equal(targeted.found, true);
  assert.equal(capsule.content_kind, fixture.expectedKind);

  return {
    id: fixture.id,
    category: fixture.category,
    source_chars: JSON.stringify(fixture.result).length,
    encoding: capsule.encoding,
    content_kind: capsule.content_kind,
    projection: capsule.projection,
    fallback_reason:
      capsule.content_kind === "opaque-result"
        ? "complex-mcp-result"
        : capsule.content_kind === "plain-text" && fixture.category === "json"
          ? "json-not-uniform"
          : null,
    initial_tokens: tokens(delivered),
    initial_contains_marker: normalizedWire(delivered).includes(fixture.marker),
    one_chunk_tokens: tokens(oneChunk),
    target_retrieval_calls: targeted.calls,
    target_total_tokens: tokens(delivered) + targeted.responseTokens,
    full_retrieval_calls: recovered.calls,
    full_total_tokens: tokens(delivered) + recovered.responseTokens,
    compression_cpu_ms: Number(elapsed.toFixed(3)),
    observed_peak_heap_bytes: Math.max(heapBefore, heapAfter),
    heap_delta_bytes: heapAfter - heapBefore,
    exact_recovery: true,
    payload_sha256: createHash("sha256").update(recovered.payload).digest("hex"),
    deterministic_projection: {
      encoding: capsule.encoding,
      content_kind: capsule.content_kind,
      projection: capsule.projection,
      preview: capsule.preview,
      preview_ranges: capsule.preview_ranges,
      next_cursor: capsule.next_cursor,
      payload_chars: capsule.payload_chars,
      result_shape: capsule.result_shape ?? null,
    },
  };
}

const firstRun = CASES.map(runCase);
const secondRun = CASES.map(runCase);
const stableFirst = firstRun.map(
  ({ compression_cpu_ms, observed_peak_heap_bytes, heap_delta_bytes, ...entry }) => entry,
);
const stableSecond = secondRun.map(
  ({ compression_cpu_ms, observed_peak_heap_bytes, heap_delta_bytes, ...entry }) => entry,
);
const firstHash = createHash("sha256").update(JSON.stringify(stableFirst)).digest("hex");
const secondHash = createHash("sha256").update(JSON.stringify(stableSecond)).digest("hex");
assert.equal(firstHash, secondHash);

const report = {
  schema_version: 1,
  benchmark_date: "2026-07-26",
  methodology: {
    kind: "deterministic quota-free content projection and exact recovery",
    tokenizer: TOKENIZER,
    accounting: "MCP response payloads for initial delivery, targeted retrieval, and full recovery",
    model_calls: 0,
  },
  corpus: {
    cases: CASES.length,
    categories: Object.fromEntries(
      [...new Set(CASES.map((fixture) => fixture.category))].map((category) => [
        category,
        CASES.filter((fixture) => fixture.category === category).length,
      ]),
    ),
  },
  deterministic_capture: {
    first_sha256: firstHash,
    second_sha256: secondHash,
    stable: true,
  },
  results: firstRun,
};

fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      report: REPORT_PATH,
      corpus: report.corpus,
      deterministic_capture: report.deterministic_capture,
      strategies: Object.fromEntries(
        [...new Set(firstRun.map((entry) => entry.projection))].map((projection) => [
          projection,
          firstRun.filter((entry) => entry.projection === projection).length,
        ]),
      ),
      exact_recovery: firstRun.every((entry) => entry.exact_recovery),
    },
    null,
    2,
  ),
);

encoding.free();
