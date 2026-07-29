#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get_encoding } from "tiktoken";
import { CALL_TOOL, FIND_TOOL, READ_RESULT, SecureProjectionKernel } from "../../dist/secure-projection.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = path.join(ROOT, "docs", "evidence", "2026-07-27-automatic-compression-stress.json");
const TOKENIZER = "o200k_base";
const RESULT_REF_PATTERN = /result_[a-f0-9]{32}/gu;
const TOOL_REF_PATTERN = /tool_[a-f0-9]{16}_\d+/gu;
const CATALOG_DIGEST_PATTERN = /"catalog_digest":"[a-f0-9]{64}"/gu;
const encoding = get_encoding(TOKENIZER);

function normalizedWire(value) {
  return JSON.stringify(value)
    .replace(RESULT_REF_PATTERN, `result_${"0".repeat(32)}`)
    .replace(TOOL_REF_PATTERN, "tool_0000000000000000_0")
    .replace(CATALOG_DIGEST_PATTERN, `"catalog_digest":"${"0".repeat(64)}"`);
}

function tokens(value) {
  return encoding.encode(typeof value === "string" ? value : normalizedWire(value)).length;
}

function hash(value) {
  return createHash("sha256")
    .update(typeof value === "string" ? value : normalizedWire(value))
    .digest("hex");
}

function parseText(result) {
  const block = result.content?.[0];
  assert.equal(block?.type, "text");
  return JSON.parse(block.text);
}

function eventTokens(request, response) {
  return tokens(request) + tokens(response);
}

function buildTools() {
  const decoys = Array.from({ length: 99 }, (_, index) => ({
    name: `fixture_domain_${String(index).padStart(3, "0")}_operation`,
    title: `Fixture domain operation ${index}`,
    description:
      "Deterministic stress-fixture operation with structured filters, pagination, locale, sorting, and bounded output.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language operation query" },
        locale: { type: "string", description: "Preferred locale" },
        limit: { type: "number", description: "Maximum records" },
        cursor: { type: "string", description: "Pagination cursor" },
        sort: { type: "string", description: "Sort order" },
        include_archived: { type: "boolean", description: "Include archived records" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        records: { type: "array" },
        next_cursor: { type: "string" },
      },
      required: ["records"],
    },
    annotations: { readOnlyHint: true },
  }));

  return [
    ...decoys,
    {
      name: "fixture_web_search_advanced",
      title: "Advanced web search",
      description: "Search the web with domain, language, quality, and result-count controls.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Web search query" },
          language: { type: "string", description: "Preferred result language" },
          include_domains: {
            type: "array",
            description: "Only return results from these domains",
            items: { type: "string" },
          },
          count: { type: "number", description: "Maximum result count" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          results: { type: "array" },
        },
        required: ["results"],
      },
      annotations: { readOnlyHint: true },
      "x-fixture-shape": "stress-only",
    },
  ];
}

function buildLargeResult() {
  const rows = Array.from({ length: 8_000 }, (_, index) => ({
    rank: index + 1,
    title: index === 0 ? "STRESS_MARKER:advanced-search-complete" : `Deterministic result ${index + 1}`,
    url: `https://example.test/results/${index + 1}`,
    snippet: `Synthetic bilingual result payload ${index + 1}. 固定压力测试内容 ${index + 1}。`,
    score: Number((1 - index / 10_000).toFixed(4)),
    source: `fixture-${index % 12}`,
  }));
  return {
    content: [{ type: "text", text: JSON.stringify(rows) }],
  };
}

function reconstruct(capsule, payload) {
  return capsule.encoding === "single-text-v1"
    ? { content: [{ type: "text", text: payload }], ...(capsule.result_shape ?? {}) }
    : JSON.parse(payload);
}

function reduction(reference, candidate) {
  return Number((((reference - candidate) / reference) * 100).toFixed(2));
}

function main() {
  const tools = buildTools();
  const upstreamResult = buildLargeResult();
  const prompt = "高级网页搜索 MCP context compression，并返回最终完成标记。";
  const callArguments = { query: "MCP context compression", language: "zh", count: 8_000 };
  const kernel = new SecureProjectionKernel(tools);

  const directListRequest = { method: "tools/list" };
  const directListResponse = { tools };
  const directCallRequest = {
    method: "tools/call",
    params: { name: "fixture_web_search_advanced", arguments: callArguments },
  };
  const directCallResponse = upstreamResult;
  const directNormalTokens =
    tokens(prompt) +
    eventTokens(directListRequest, directListResponse) +
    eventTokens(directCallRequest, directCallResponse);

  const slimListRequest = { method: "tools/list" };
  const slimListResponse = { tools: kernel.listTools() };
  const findRequest = {
    method: "tools/call",
    params: { name: FIND_TOOL, arguments: { query: "高级网页搜索 advanced web search" } },
  };
  const findResponsePromise = kernel.call(FIND_TOOL, findRequest.params.arguments, async () => upstreamResult);

  return findResponsePromise.then(async (findResponse) => {
    const match = parseText(findResponse).matches?.find(
      (candidate) => candidate.name === "fixture_web_search_advanced",
    );
    assert.ok(match, "automatic discovery did not select the stress target");

    let upstreamCalls = 0;
    const callRequest = {
      method: "tools/call",
      params: {
        name: CALL_TOOL,
        arguments: { tool_ref: match.tool_ref, arguments: callArguments },
      },
    };
    const callResponse = await kernel.call(CALL_TOOL, callRequest.params.arguments, async (name, args) => {
      upstreamCalls += 1;
      assert.equal(name, "fixture_web_search_advanced");
      assert.equal(args, callArguments);
      return upstreamResult;
    });
    const capsule = parseText(callResponse);
    assert.equal(upstreamCalls, 1);
    assert.match(capsule.result_ref, /^result_[a-f0-9]{32}$/u);

    const slimNormalTokens =
      tokens(prompt) +
      eventTokens(slimListRequest, slimListResponse) +
      eventTokens(findRequest, findResponse) +
      eventTokens(callRequest, callResponse);

    const recoveryEvents = [];
    const chunks = [];
    let cursor = capsule.replay_cursor;
    while (cursor !== null) {
      const request = {
        method: "tools/call",
        params: { name: READ_RESULT, arguments: { result_ref: capsule.result_ref, cursor } },
      };
      const response = await kernel.call(READ_RESULT, request.params.arguments, async () => upstreamResult);
      const block = response.content?.[0];
      assert.equal(block?.type, "text");
      chunks.push(block.text);
      recoveryEvents.push({ request, response });
      cursor = response.structuredContent?.next_cursor ?? null;
    }

    const recovered = reconstruct(capsule, chunks.join(""));
    assert.deepEqual(recovered, upstreamResult);
    assert.equal(upstreamCalls, 1);

    const slimFullRecoveryTokens =
      slimNormalTokens + recoveryEvents.reduce((total, event) => total + eventTokens(event.request, event.response), 0);
    const directHash = hash(upstreamResult);
    const recoveredHash = hash(recovered);
    assert.equal(recoveredHash, directHash);

    const report = {
      schema_version: 1,
      benchmark_date: "2026-07-27",
      profile: "automatic-alpha-stress-fixture",
      methodology: {
        tokenizer: TOKENIZER,
        accounting: "prompt plus every model-facing MCP request and response",
        runtime_path:
          "The same automatic SecureProjectionKernel and ResultCapsuleStore used by the Alpha; no alternate compression level or model call.",
        purpose:
          "Show the upper-bound effect on an intentionally large catalog and result. This fixture must not replace the normal 24-task headline benchmark.",
        limitation:
          "Deterministic protocol replay. No model selects the tool, and the synthetic workload does not represent a typical MCP session.",
      },
      fixture: {
        authorized_tools: tools.length,
        result_rows: 8_000,
        result_chars: normalizedWire(upstreamResult).length,
        language: "zh-en",
        expected_tool: "fixture_web_search_advanced",
      },
      normal_path: {
        direct_tokens: directNormalTokens,
        slim_guard_tokens: slimNormalTokens,
        reduction_percent: reduction(directNormalTokens, slimNormalTokens),
        advertised_tools: kernel.listTools().length,
        upstream_calls: upstreamCalls,
        target_visible_in_initial_projection: normalizedWire(callResponse).includes(
          "STRESS_MARKER:advanced-search-complete",
        ),
      },
      forced_full_recovery: {
        direct_tokens: directNormalTokens,
        slim_guard_tokens: slimFullRecoveryTokens,
        overhead_percent: Number(((slimFullRecoveryTokens / directNormalTokens - 1) * 100).toFixed(2)),
        read_result_calls: recoveryEvents.length,
        exact_hash_match: recoveredHash === directHash,
      },
      integrity: {
        direct_result_sha256: directHash,
        recovered_result_sha256: recoveredHash,
        upstream_calls: upstreamCalls,
      },
    };

    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        { report: REPORT_PATH, ...report.normal_path, forced_full_recovery: report.forced_full_recovery },
        null,
        2,
      ),
    );
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    encoding.free();
  });
