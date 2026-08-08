import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { ResultCapsuleStore } from "../../dist/result-capsule-store.js";
import { captureCandidateIdentity } from "../evaluation/candidate-identity.mjs";
import { createEvaluationMeasurement } from "../evaluation/evaluation-measurement.mjs";
import { evaluate } from "../evaluation/evaluation-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = path.join(ROOT, "docs/evidence/2026-08-06-result-evaluation.json");
const TOKENIZER = "o200k_base";
const measurement = createEvaluationMeasurement(TOKENIZER);

function parseCapsule(result) {
  assert.equal(result.content[0]?.type, "text");
  const capsule = JSON.parse(result.content[0].text);
  assert.equal(typeof capsule.result_ref, "string");
  return capsule;
}

function normalizedWire(value) {
  return measurement.normalizedWire(value);
}

function tokens(value) {
  return measurement.tokens(value);
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
  if (initial.includes(marker)) return { found: true, calls: 0, responseTokens: 0, responses: [] };

  let cursor = capsule.next_cursor;
  let calls = 0;
  let responseTokens = 0;
  const responses = [];
  while (cursor !== null) {
    const response = store.read({ result_ref: capsule.result_ref, cursor });
    assert.notEqual(response.isError, true);
    responses.push(response);
    calls += 1;
    responseTokens += tokens(response);
    if (normalizedWire(response).includes(marker)) return { found: true, calls, responseTokens, responses };
    cursor = response.structuredContent.next_cursor;
  }
  return { found: false, calls, responseTokens, responses };
}

function readByQuery(store, capsule, query) {
  const response = store.read({ result_ref: capsule.result_ref, query });
  assert.notEqual(response.isError, true);
  return { response, responseTokens: tokens(response) };
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

function runCase(fixture, mode) {
  const store = new ResultCapsuleStore({ mode });
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const delivered = store.capture(fixture.result);
  const elapsed = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  let capsule;
  try {
    capsule = parseCapsule(delivered);
  } catch {
    return {
      id: fixture.id,
      category: fixture.category,
      mode,
      source_chars: JSON.stringify(fixture.result).length,
      delivery: "exact-pass-through",
      initial_tokens: tokens(delivered),
      initial_contains_marker: normalizedWire(delivered).includes(fixture.marker),
      target_retrieval_calls: 0,
      full_retrieval_calls: 0,
      payload_sha256: measurement.sha256(fixture.result),
      _evidence: {
        source_result: fixture.result,
        recovered_result: delivered,
        initial_delivery: delivered,
        targeted_responses: [],
      },
    };
  }
  const oneChunk = store.read({ result_ref: capsule.result_ref, cursor: capsule.replay_cursor });
  const targeted = readUntilMarker(store, delivered, capsule, fixture.marker);
  const searched = readByQuery(store, capsule, fixture.marker);
  const recovered = readAll(store, capsule);
  const reconstructed = reconstruct(capsule, recovered.payload);

  return {
    id: fixture.id,
    category: fixture.category,
    mode,
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
    query_retrieval_calls: 1,
    query_total_tokens: tokens(delivered) + searched.responseTokens,
    full_retrieval_calls: recovered.calls,
    full_total_tokens: tokens(delivered) + recovered.responseTokens,
    compression_cpu_ms: Number(elapsed.toFixed(3)),
    observed_peak_heap_bytes: Math.max(heapBefore, heapAfter),
    heap_delta_bytes: heapAfter - heapBefore,
    payload_sha256: measurement.sha256(recovered.payload),
    _evidence: {
      source_result: fixture.result,
      recovered_result: reconstructed,
      initial_delivery: delivered,
      targeted_responses: targeted.responses,
      query_response: searched.response,
    },
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

function flatten(run) {
  return Object.entries(run).flatMap(([profile, results]) =>
    results.map(({ id, mode: _mode, ...result }) => ({ profile, case_id: id, ...result })),
  );
}

async function main() {
  const firstRun = Object.fromEntries(
    ["compact", "extreme"].map((mode) => [mode, CASES.map((fixture) => runCase(fixture, mode))]),
  );
  const secondRun = Object.fromEntries(
    ["compact", "extreme"].map((mode) => [mode, CASES.map((fixture) => runCase(fixture, mode))]),
  );
  const suite = {
    schema_version: 1,
    id: "mode-result-projection",
    kind: "result-projection",
    fixture_digest: measurement.sha256(CASES),
    profiles: ["compact", "extreme"],
    cases: CASES.map(({ id, category, marker, expectedKind }) => ({
      id,
      category,
      expected_marker: marker,
      expected_content_kind: expectedKind,
    })),
  };
  const report = await evaluate({
    candidate: captureCandidateIdentity(ROOT),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tokenizer: TOKENIZER,
    },
    suite,
    adapter: {
      id: "in-process-result-capsule-fixture",
      async run() {
        return { observations: flatten(firstRun), repeat_observations: flatten(secondRun) };
      },
    },
  });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        report: REPORT_PATH,
        candidate_digest: report.candidate.digest,
        cases: report.suite.case_count,
        verdict: report.verdict,
        hard_gates: report.hard_gates,
        comparisons: report.comparisons,
      },
      null,
      2,
    ),
  );
  if (report.verdict !== "pass") process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => measurement.close());
