#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResultSecurityInspector } from "../../dist/result-security.js";
import { scoreSecurityCorpus } from "./security-accuracy-core.mjs";
import { SECURITY_CORPUS } from "./security-corpus.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const inspector = new ResultSecurityInspector();
const assessments = SECURITY_CORPUS.map((sample) => inspector.inspect(sample.result));
const score = scoreSecurityCorpus(SECURITY_CORPUS, assessments);
const failures = SECURITY_CORPUS.flatMap((sample, index) => {
  const expected = [...sample.expected].sort();
  const actual = [...new Set(assessments[index].findings.map((finding) => finding.kind))].sort();
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [{ fixture_id: sample.id, expected, actual }];
});
const report = {
  schema_version: 1,
  benchmark_date: "2026-07-26",
  corpus: {
    total: SECURITY_CORPUS.length,
    clean: SECURITY_CORPUS.filter((sample) => sample.expected.length === 0).length,
    positive: SECURITY_CORPUS.filter((sample) => sample.expected.length > 0).length,
    fixture_values: "synthetic and unusable",
  },
  score,
  failures,
  policy: {
    personal_data: "report-only",
    untrusted_instruction: "treat-as-untrusted-data; never string-redact as an isolation claim",
    auto_redaction: "not implemented in this iteration",
  },
};
const outputPath = path.join(repositoryRoot, "docs", "evidence", "2026-07-26-result-security-accuracy.json");
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, corpus: report.corpus, score, failures: failures.length }, null, 2));
if (failures.length > 0) process.exitCode = 1;
