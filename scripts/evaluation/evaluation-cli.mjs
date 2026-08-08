#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  protocolEvaluationReportPath,
  runProtocolEvaluation,
  writeProtocolEvaluation,
} from "./protocol-evaluation.mjs";

function option(name, fallback) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(`--${name}=`.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

function runScript(relativePath) {
  const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), relativePath);
  const result = spawnSync(process.execPath, [scriptPath], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${relativePath} exited with status ${result.status}`);
}

async function runProtocol() {
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
  if (report.verdict !== "pass") throw new Error("protocol evaluation did not pass");
}

async function main() {
  const suite = option("suite", "protocol");
  const candidate = option("candidate", "current");
  if (candidate !== "current") throw new Error(`Unsupported evaluation candidate: ${candidate}`);

  if (suite === "protocol") return runProtocol();
  if (suite === "result" || suite === "result-projection") {
    runScript("../benchmark/content-projection.mjs");
    return;
  }
  if (suite === "stress") {
    runScript("../benchmark/automatic-stress.mjs");
    return;
  }
  if (suite === "all") {
    await runProtocol();
    runScript("../benchmark/content-projection.mjs");
    runScript("../benchmark/automatic-stress.mjs");
    return;
  }
  throw new Error(`Unsupported evaluation suite: ${suite}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
