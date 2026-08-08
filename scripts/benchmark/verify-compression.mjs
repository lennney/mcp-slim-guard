#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const completeTaskPath = path.join(root, "docs/evidence/2026-08-06-protocol-evaluation.json");
const projectionPath = path.join(root, "docs/evidence/2026-08-06-result-evaluation.json");
const stressPath = path.join(root, "docs/evidence/2026-08-06-stress-evaluation.json");
const modes = ["native", "compact", "extreme"];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const complete = readJson(completeTaskPath);
const projection = readJson(projectionPath);
const stress = readJson(stressPath);

assert.equal(complete.schema_version, 1);
assert.equal(complete.suite.id, "three-modes-24-task");
assert.equal(complete.suite.kind, "protocol-replay");
assert.match(complete.candidate.digest, /^[a-f0-9]{64}$/u);
assert.equal(complete.verdict, "pass");
assert.equal(
  Object.values(complete.hard_gates).every((gate) => gate.passed),
  true,
  "protocol evaluation hard gates must all pass",
);
const completeProfiles = Object.fromEntries(
  ["baseline", ...modes].map((profile) => [
    profile,
    complete.observations.filter((observation) => observation.profile === profile),
  ]),
);
for (const profile of ["baseline", ...modes]) {
  const results = completeProfiles[profile];
  assert.equal(results.length, 24, `${profile} must contain all 24 bilingual MCP tasks`);
  assert.equal(
    results.every((result) => result.success),
    true,
    `${profile} must complete every MCP task`,
  );
  assert.equal(
    results.every((result) => result.upstream_calls === 1),
    true,
    `${profile} must invoke upstream exactly once per task`,
  );
  assert.equal(
    results.every((result) => result.retries === 0),
    true,
    `${profile} must not hide retries`,
  );
}

for (const mode of ["compact", "extreme"]) {
  assert.equal(
    completeProfiles[mode].every((result) => result.advertised_tool_count === 3),
    true,
    `${mode} must expose the fixed three-tool surface`,
  );
}
for (const mode of modes) {
  for (const result of completeProfiles[mode].filter((entry) => entry.exact_recovery)) {
    const baseline = completeProfiles.baseline.find((entry) => entry.task_id === result.task_id);
    assert.ok(baseline, `Missing baseline result for ${mode}/${result.task_id}`);
    assert.equal(
      result.recovered_content_sha256,
      baseline.result_content_sha256,
      `Recovered result differs for ${mode}/${result.task_id}`,
    );
  }
}

assert.equal(projection.schema_version, 1);
assert.equal(projection.suite.id, "mode-result-projection");
assert.equal(projection.suite.kind, "result-projection");
assert.equal(projection.verdict, "pass");
assert.equal(
  Object.values(projection.hard_gates).every((gate) => gate.passed),
  true,
  "result-projection evaluation hard gates must all pass",
);
for (const mode of ["compact", "extreme"]) {
  const results = projection.observations.filter((observation) => observation.profile === mode);
  assert.equal(results.length, 23, `${mode} must contain all 23 result fixtures`);
  assert.equal(
    results.every((result) => result.exact_recovery),
    true,
    `${mode} must preserve exact recovery for every fixture`,
  );
  assert.equal(
    results
      .filter((result) => result.compression_cpu_ms !== undefined)
      .every((result) => result.compression_cpu_ms < 10),
    true,
    `${mode} projection exceeded the fixture CPU budget`,
  );
}

assert.equal(stress.schema_version, 1);
assert.equal(stress.suite.id, "three-mode-100-tool-8000-row-stress");
assert.equal(stress.suite.kind, "stress");
assert.equal(stress.suite.case_count, 1);
assert.equal(stress.verdict, "pass");
assert.equal(
  Object.values(stress.hard_gates).every((gate) => gate.passed),
  true,
  "stress evaluation hard gates must all pass",
);
for (const mode of ["compact", "extreme"]) {
  const result = stress.observations.find((observation) => observation.profile === mode);
  assert.ok(result, `${mode} stress observation is missing`);
  assert.equal(result.case_id, "100-tools-8000-rows");
  assert.equal(result.normal_path.advertised_tools, 3, `${mode} stress surface is not fixed`);
  assert.equal(result.normal_path.upstream_calls, 1, `${mode} stress run repeated upstream`);
  assert.equal(result.forced_full_recovery.exact_hash_match, true, `${mode} stress recovery is not exact`);
  assert.equal(result.forced_full_recovery.upstream_calls, 0, `${mode} stress recovery called upstream`);
  assert.equal(result.integrity.upstream_calls, 1, `${mode} stress recovery repeated upstream`);
}

console.log(
  JSON.stringify(
    {
      gate: "passed",
      protocol_evaluation: {
        candidate_digest: complete.candidate.digest,
        manifest_sha256: complete.suite.manifest_sha256,
        mcp_tasks_per_mode: complete.suite.case_count,
        verdict: complete.verdict,
      },
      modes,
      result_projection_profiles: projection.suite.profiles,
      stress_fixture: stress.observations[0]?.case_id,
    },
    null,
    2,
  ),
);
