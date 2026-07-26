#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const completeTaskPath = path.join(root, "docs/evidence/2026-07-26-complete-task-capture.json");
const projectionPath = path.join(root, "docs/evidence/2026-07-26-content-projection-capture.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function totalTokens(results) {
  return results.reduce((sum, result) => sum + result.total_tokens, 0);
}

function totalWithRecoveryVerification(results) {
  return results.reduce((sum, result) => sum + result.total_with_recovery_verification_tokens, 0);
}

const complete = readJson(completeTaskPath);
const projection = readJson(projectionPath);
const baseline = complete.profiles.baseline;
const competitor = complete.profiles["mcp-compressor"];
const slim = complete.profiles["slim-guard"];

for (const [name, results] of Object.entries({ baseline, competitor, slim })) {
  assert.equal(results.length, 24, `${name} must contain all 24 bilingual MCP tasks`);
  assert.equal(
    results.every((result) => result.success),
    true,
    `${name} must complete every MCP task`,
  );
  assert.equal(
    results.every((result) => result.upstream_calls === 1),
    true,
    `${name} must invoke the upstream MCP tool exactly once per task`,
  );
  assert.equal(
    results.every((result) => result.retries === 0),
    true,
    `${name} must not hide retries in the frozen capture`,
  );
}

assert.equal(
  slim.every((result) => result.advertised_tool_count === 3),
  true,
  "Slim Guard must expose exactly three tools",
);
assert.equal(
  complete.summary["slim-guard"].total_tokens <= complete.summary["mcp-compressor"].total_tokens,
  true,
  "Slim Guard complete MCP task tokens must not exceed mcp-compressor",
);

const recoveryTasks = slim.filter((result) => result.exact_recovery);
assert.equal(recoveryTasks.length >= 2, true, "At least two MCP results must exercise read_result");
for (const result of recoveryTasks) {
  const baselineResult = baseline.find((candidate) => candidate.task_id === result.task_id);
  assert.ok(baselineResult, `Missing baseline result for ${result.task_id}`);
  assert.equal(
    result.recovered_content_sha256,
    baselineResult.result_content_sha256,
    `Recovered MCP content differs from baseline for ${result.task_id}`,
  );
  assert.equal(
    result.events.some((event) => event.kind === "recovery"),
    true,
    `${result.task_id} did not record a read_result recovery event`,
  );
}

const recoveryIds = new Set(recoveryTasks.map((result) => result.task_id));
const boundedSlim = slim.filter((result) => !recoveryIds.has(result.task_id));
assert.equal(
  totalTokens(boundedSlim) <= 15_653,
  true,
  `Bounded MCP tasks regressed above 15,653 tokens: ${totalTokens(boundedSlim)}`,
);
assert.equal(
  totalWithRecoveryVerification(recoveryTasks) <=
    totalWithRecoveryVerification(competitor.filter((result) => recoveryIds.has(result.task_id))) * 1.1,
  true,
  "Fully recovered MCP report tasks exceeded the explicit 10% recovery-overhead ceiling",
);

assert.equal(projection.deterministic_capture.stable, true);
assert.equal(projection.deterministic_capture.first_sha256, projection.deterministic_capture.second_sha256);
assert.equal(
  projection.results.every((result) => result.exact_recovery),
  true,
  "Every content strategy fixture must retain exact recovery",
);
assert.equal(
  projection.results.every((result) => result.compression_cpu_ms < 10),
  true,
  "A deterministic projection exceeded the 10 ms fixture budget",
);

console.log(
  JSON.stringify(
    {
      gate: "passed",
      model_calls: 0,
      mcp_tasks: slim.length,
      exact_recovery_tasks: recoveryTasks.length,
      upstream_calls: complete.summary["slim-guard"].upstream_calls,
      advertised_tools: complete.summary["slim-guard"].advertised_tool_counts,
      bounded_slim_tokens: totalTokens(boundedSlim),
      recovered_report_tokens: totalTokens(recoveryTasks),
      recovered_report_tokens_with_verification: totalWithRecoveryVerification(recoveryTasks),
      competitor_report_tokens: totalWithRecoveryVerification(
        competitor.filter((result) => recoveryIds.has(result.task_id)),
      ),
      full_recovery_overhead_percent: Number(
        (
          (totalWithRecoveryVerification(recoveryTasks) /
            totalWithRecoveryVerification(competitor.filter((result) => recoveryIds.has(result.task_id))) -
            1) *
          100
        ).toFixed(2),
      ),
      slim_total_tokens: complete.summary["slim-guard"].total_tokens,
      competitor_total_tokens: complete.summary["mcp-compressor"].total_tokens,
      projection_cases: projection.results.length,
    },
    null,
    2,
  ),
);
