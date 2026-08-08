#!/usr/bin/env node

import {
  protocolEvaluationReportPath,
  runProtocolEvaluation,
  writeProtocolEvaluation,
} from "../evaluation/protocol-evaluation.mjs";

async function main() {
  const report = await runProtocolEvaluation();
  writeProtocolEvaluation(report);
  console.log(
    JSON.stringify(
      {
        report: protocolEvaluationReportPath,
        verdict: report.verdict,
        candidate: report.candidate,
        summary: report.summary,
        comparisons: report.comparisons,
        hard_gates: report.hard_gates,
      },
      null,
      2,
    ),
  );
  if (report.verdict !== "pass") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
