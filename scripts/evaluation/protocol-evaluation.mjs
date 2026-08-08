import fs from "node:fs";
import path from "node:path";
import { captureCandidateIdentity } from "./candidate-identity.mjs";
import { evaluate } from "./evaluation-runner.mjs";
import { createModeProtocolReplayAdapter, createModeProtocolSuite, repositoryRoot } from "./mode-protocol-replay.mjs";

export const protocolEvaluationReportPath = path.join(
  repositoryRoot,
  "docs",
  "evidence",
  "2026-08-06-protocol-evaluation.json",
);

export async function runProtocolEvaluation() {
  return evaluate({
    candidate: captureCandidateIdentity(repositoryRoot),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tokenizer: "o200k_base",
    },
    suite: createModeProtocolSuite(),
    adapter: createModeProtocolReplayAdapter(),
  });
}

export function writeProtocolEvaluation(report) {
  fs.writeFileSync(protocolEvaluationReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
