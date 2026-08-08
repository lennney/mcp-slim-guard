#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CALL_TOOL, FIND_TOOL, READ_RESULT, SecureProjectionKernel } from "../../dist/secure-projection.js";
import { ResultCapsuleStore } from "../../dist/result-capsule-store.js";
import { captureCandidateIdentity } from "../evaluation/candidate-identity.mjs";
import { createEvaluationMeasurement } from "../evaluation/evaluation-measurement.mjs";
import { evaluate } from "../evaluation/evaluation-runner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_PATH = path.join(ROOT, "docs/evidence/2026-08-06-stress-evaluation.json");
const TOKENIZER = "o200k_base";
const measurement = createEvaluationMeasurement(TOKENIZER);

function normalizedWire(value) {
  return measurement.normalizedWire(value);
}

function tokens(value) {
  return measurement.tokens(value);
}

function hash(value) {
  return measurement.sha256(value);
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
  const inputSchema = {
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
  };
  const decoys = Array.from({ length: 99 }, (_, index) => ({
    name: `fixture_domain_${String(index).padStart(3, "0")}_operation`,
    title: `Fixture domain operation ${index}`,
    description: "Deterministic stress-fixture operation with structured filters and bounded output.",
    inputSchema,
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
            items: { type: "string" },
            description: "Only return results from these domains",
          },
          count: { type: "number", description: "Maximum result count" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
}

function buildLargeResult() {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          Array.from({ length: 8_000 }, (_, index) => ({
            rank: index + 1,
            title: index === 0 ? "STRESS_MARKER:advanced-search-complete" : `Deterministic result ${index + 1}`,
            url: `https://example.test/results/${index + 1}`,
            snippet: `Synthetic stress payload ${index + 1}`,
            score: Number((1 - index / 10_000).toFixed(4)),
          })),
        ),
      },
    ],
  };
}

function reconstruct(capsule, payload) {
  return capsule.encoding === "single-text-v1"
    ? { content: [{ type: "text", text: payload }], ...(capsule.result_shape ?? {}) }
    : JSON.parse(payload);
}

async function runMode(mode, tools, upstreamResult, prompt, callArguments, directNormalTokens) {
  const kernel = new SecureProjectionKernel(tools, new ResultCapsuleStore({ mode }));
  const listRequest = { method: "tools/list" };
  const listResponse = { tools: kernel.listTools() };
  const findRequest = {
    method: "tools/call",
    params: { name: FIND_TOOL, arguments: { query: "advanced web search" } },
  };
  const findResponse = await kernel.call(FIND_TOOL, findRequest.params.arguments, async () => upstreamResult);
  const match = parseText(findResponse).matches?.find((candidate) => candidate.name === "fixture_web_search_advanced");
  assert.ok(match, `${mode} did not discover the stress target`);
  let upstreamCalls = 0;
  let recoveryUpstreamCalls = 0;
  const callRequest = {
    method: "tools/call",
    params: { name: CALL_TOOL, arguments: { tool_ref: match.tool_ref, arguments: callArguments } },
  };
  const callResponse = await kernel.call(CALL_TOOL, callRequest.params.arguments, async (name, args) => {
    upstreamCalls += 1;
    assert.equal(name, "fixture_web_search_advanced");
    assert.deepEqual(args, callArguments);
    return upstreamResult;
  });
  const capsule = parseText(callResponse);
  assert.match(capsule.result_ref, /^result_[a-f0-9]{32}$/u);
  const normalTokens =
    tokens(prompt) +
    eventTokens(listRequest, listResponse) +
    eventTokens(findRequest, findResponse) +
    eventTokens(callRequest, callResponse);
  const recoveryEvents = [];
  const chunks = [];
  for (let cursor = capsule.replay_cursor; cursor !== null;) {
    const request = {
      method: "tools/call",
      params: { name: READ_RESULT, arguments: { result_ref: capsule.result_ref, cursor } },
    };
    const response = await kernel.call(READ_RESULT, request.params.arguments, async () => {
      recoveryUpstreamCalls += 1;
      return upstreamResult;
    });
    const block = response.content?.[0];
    assert.equal(block?.type, "text");
    chunks.push(block.text);
    recoveryEvents.push({ request, response });
    cursor = response.structuredContent?.next_cursor ?? null;
  }
  const recovered = reconstruct(capsule, chunks.join(""));
  const recoveredHash = hash(recovered);
  const directHash = hash(upstreamResult);
  const fullRecoveryTokens =
    normalTokens + recoveryEvents.reduce((total, event) => total + eventTokens(event.request, event.response), 0);
  return {
    normal_path: {
      direct_tokens: directNormalTokens,
      mode_tokens: normalTokens,
      reduction_percent: Number((((directNormalTokens - normalTokens) / directNormalTokens) * 100).toFixed(2)),
      advertised_tools: kernel.listTools().length,
      upstream_calls: upstreamCalls,
      target_visible_in_initial_delivery: normalizedWire(callResponse).includes(
        "STRESS_MARKER:advanced-search-complete",
      ),
    },
    forced_full_recovery: {
      direct_tokens: directNormalTokens,
      mode_tokens: fullRecoveryTokens,
      read_result_calls: recoveryEvents.length,
      exact_hash_match: recoveredHash === directHash,
      upstream_calls: recoveryUpstreamCalls,
    },
    integrity: {
      direct_result_sha256: directHash,
      recovered_result_sha256: recoveredHash,
      upstream_calls: upstreamCalls,
    },
  };
}

async function main() {
  const tools = buildTools();
  const upstreamResult = buildLargeResult();
  const prompt = "Search the web and return the complete marker.";
  const callArguments = { query: "MCP context", language: "en", count: 8_000 };
  const directNormalTokens =
    tokens(prompt) +
    eventTokens({ method: "tools/list" }, { tools }) +
    eventTokens(
      { method: "tools/call", params: { name: "fixture_web_search_advanced", arguments: callArguments } },
      upstreamResult,
    );
  const modes = Object.fromEntries(
    await Promise.all(
      ["compact", "extreme"].map(async (mode) => [
        mode,
        await runMode(mode, tools, upstreamResult, prompt, callArguments, directNormalTokens),
      ]),
    ),
  );
  const fixture = {
    authorized_tools: tools.length,
    result_rows: 8_000,
    result_chars: normalizedWire(upstreamResult).length,
    expected_tool: "fixture_web_search_advanced",
  };
  const suite = {
    schema_version: 1,
    id: "three-mode-100-tool-8000-row-stress",
    kind: "stress",
    fixture_digest: measurement.sha256({ tools, upstreamResult, prompt, callArguments }),
    profiles: ["compact", "extreme"],
    cases: [{ id: "100-tools-8000-rows" }],
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
      id: "in-process-100-tool-8000-row-fixture",
      async run() {
        return {
          observations: Object.entries(modes).map(([profile, result]) => ({
            profile,
            case_id: "100-tools-8000-rows",
            ...result,
          })),
        };
      },
    },
  });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        report: REPORT_PATH,
        candidate_digest: report.candidate.digest,
        fixture,
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
