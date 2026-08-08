#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureServer = path.join(repositoryRoot, "scripts", "benchmark", "task-fixture-server.mjs");
const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-alpha-demo-"));
const auditPath = path.join(temporaryDirectory, "upstream-calls.jsonl");

function createClient(name) {
  return new Client({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
}

function parseText(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected a text result");
  return JSON.parse(block.text);
}

function auditCount() {
  if (!fs.existsSync(auditPath)) return 0;
  return fs.readFileSync(auditPath, "utf8").split(/\r?\n/u).filter(Boolean).length;
}

let baseline;
let slim;
try {
  baseline = createClient("slim-guard-alpha-demo-baseline");
  await baseline.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fixtureServer],
      cwd: repositoryRoot,
      stderr: "pipe",
    }),
  );
  const upstreamTools = await baseline.listTools();
  await baseline.close();
  baseline = undefined;

  fs.writeFileSync(
    path.join(temporaryDirectory, "mcp-slim-guard.yml"),
    JSON.stringify(
      {
        version: 2,
        tools: { allow: ["fixture_*"], deny: [] },
        ssrf: {
          mode: "off",
          block_private_ips: false,
          allow_domains: [],
          block_domains: [],
        },
        rate_limit: { default: "1000/min" },
        injection_detection: { enabled: false },
        audit: { output: "file", filePath: path.join(temporaryDirectory, "audit.log") },
        servers: {
          fixture: {
            command: process.execPath,
            args: [fixtureServer],
            cwd: repositoryRoot,
            env: { SLIM_GUARD_FIXTURE_AUDIT_PATH: auditPath },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  slim = createClient("slim-guard-alpha-demo");
  await slim.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [slimGuardCli, "start", "--mode", "compact"],
      cwd: temporaryDirectory,
      stderr: "pipe",
    }),
  );

  const projectedTools = await slim.listTools();
  const found = await slim.callTool({
    name: "find_tool",
    arguments: { query: "generate report" },
  });
  const match = parseText(found).matches?.find((candidate) => candidate.name === "fixture_generate_report");
  if (!match?.tool_ref) throw new Error("generate_report was not found");

  const called = await slim.callTool({
    name: "call_tool",
    arguments: {
      tool_ref: match.tool_ref,
      arguments: { report_id: "alpha-demo", locale: "en", detail: "full" },
    },
  });
  const capsule = parseText(called);
  if (!capsule.result_ref) throw new Error("Large report was not captured");
  if (!String(capsule.preview).includes("REPORT:alpha-demo:en:END")) {
    throw new Error("Head-tail projection did not preserve the report conclusion");
  }

  const recovered = await slim.callTool({
    name: "read_result",
    arguments: { result_ref: capsule.result_ref, cursor: 0 },
  });
  if (auditCount() !== 1) throw new Error(`Expected one upstream call, received ${auditCount()}`);

  const projectedNames = projectedTools.tools.map((tool) => tool.name);
  console.log(`1. Upstream catalog: ${upstreamTools.tools.length} tools`);
  console.log(`2. Compact catalog: ${projectedNames.length} tools -> ${projectedNames.join(", ")}`);
  console.log(`3. Discovery: fixture_generate_report -> ${String(match.tool_ref).slice(0, 20)}...`);
  console.log(`4. Large result: ${capsule.original_chars} chars -> recoverable preview`);
  console.log(`5. On-demand recovery: ${recovered.content?.[0]?.text?.length ?? 0} exact chars`);
  console.log(`6. Upstream execution count: ${auditCount()}`);
  console.log("PASS: Compress what agents see. Preserve what tools do.");
} finally {
  await baseline?.close().catch(() => {});
  await slim?.close().catch(() => {});
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
