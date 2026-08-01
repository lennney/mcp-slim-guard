#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexEntry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const cli = path.join(repositoryRoot, "dist", "cli.js");
const basicFixtureDirectory = path.join(repositoryRoot, ".artifacts", "codex-native-host-acceptance");
const shareEvidenceMode = process.argv.includes("--share-evidence");
const recoveryMode = process.argv.includes("--recovery");
const selectedModel = process.env.SLIM_GUARD_CODEX_MODEL ?? "gpt-5.6-terra";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.stdout) process.stdout.write(result.stdout);
    throw new Error(`${path.basename(command)} exited ${result.status}`);
  }
  return result.stdout;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseCodexEvents(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function codexArgs(fixtureDirectory, prompt) {
  return [
    codexEntry,
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--model",
    selectedModel,
    "--sandbox",
    "read-only",
    "--cd",
    fixtureDirectory,
    "--config",
    'model_reasoning_effort="low"',
    "--config",
    `mcp_servers.slim_guard.command=${JSON.stringify(process.execPath)}`,
    "--config",
    `mcp_servers.slim_guard.args=${JSON.stringify([cli, "start", "--surface", "native"])}`,
    "--config",
    `mcp_servers.slim_guard.cwd=${JSON.stringify(fixtureDirectory)}`,
    "--config",
    "mcp_servers.slim_guard.required=true",
    "--config",
    'mcp_servers.slim_guard.default_tools_approval_mode="approve"',
    prompt,
  ];
}

function assertCompletedTurn(events) {
  if (!events.some((event) => event.type === "turn.completed")) throw new Error("Codex turn did not complete");
  return events.filter((event) => event.type === "item.completed").map((event) => event.item);
}

function prepareShareFixture() {
  const runId = new Date().toISOString().replace(/[:.]/gu, "-");
  const fixtureDirectory = path.join(repositoryRoot, ".artifacts", "codex-share-evidence", runId);
  const codexDirectory = path.join(fixtureDirectory, ".codex");
  const fixtureAuditPath = path.join(fixtureDirectory, "fixture-calls.jsonl");
  const upstreamFixture = path.join(repositoryRoot, "scripts", "integration", "host-share-evidence-fixture.mjs");
  fs.mkdirSync(codexDirectory, { recursive: true });

  const baselineConfig = 'model_reasoning_effort = "low"\n';
  fs.writeFileSync(path.join(codexDirectory, "config.toml"), baselineConfig, "utf8");
  const yamlPath = (value) => value.replace(/\\/gu, "/").replace(/"/gu, '\\"');
  fs.writeFileSync(
    path.join(fixtureDirectory, "mcp-slim-guard.yml"),
    [
      "version: 1",
      "tools:",
      "  allow: ['fixture_*']",
      "  deny: []",
      "ssrf:",
      "  mode: block",
      "  block_private_ips: true",
      "  allow_domains: []",
      "  block_domains: []",
      "rate_limit:",
      "  default: 60/min",
      "injection_detection:",
      "  enabled: true",
      "  sensitivity: medium",
      "  mode: block",
      "compressor:",
      "  enabled: true",
      "  level: light",
      "audit:",
      "  output: file",
      "  filePath: mcp-slim-guard-audit.log",
      "servers:",
      "  fixture:",
      `    command: "${yamlPath(process.execPath)}"`,
      `    args: ["${yamlPath(upstreamFixture)}"]`,
      "    env:",
      `      SLIM_GUARD_FIXTURE_AUDIT_PATH: "${yamlPath(fixtureAuditPath)}"`,
      "",
    ].join("\n"),
    "utf8",
  );
  return { fixtureDirectory, fixtureAuditPath, baselineConfig };
}

function runShareEvidenceAcceptance() {
  const { fixtureDirectory, fixtureAuditPath, baselineConfig } = prepareShareFixture();
  const configPath = path.join(fixtureDirectory, ".codex", "config.toml");
  const baselineHash = sha256(Buffer.from(baselineConfig));
  const install = JSON.parse(
    run(process.execPath, [cli, "install", "--host", "codex", "--json"], { cwd: fixtureDirectory }),
  );
  if (install.status !== "installed" || install.host !== "codex")
    throw new Error("Codex installation transaction failed");

  const prompt = [
    "Use only the slim_guard MCP tools; do not use the shell.",
    "Complete these steps in order, and do not start the next business tool until the current result is complete:",
    "(1) Call long_text exactly once, then call read_result with each returned next_cursor until done is true.",
    "(2) Call json_array exactly once, then call read_result with each returned next_cursor until done is true.",
    "(3) Call logs exactly once, then call read_result with each returned next_cursor until done is true.",
    "(4) Call structured exactly once; it must arrive directly and must not require read_result.",
    "For read_result, use the exact next_cursor from the previous response and stop immediately when done is true and next_cursor is null.",
    "Do not call any upstream business tool more than once.",
    "In the final response, quote the exact marker text found at long_text line 0600, the marker field at JSON index 599, the distinctive ERROR marker token in the logs, and the structured marker.",
    "Those values are not included in this prompt; read them from the Tool results.",
    "Also report the number of upstream business calls and read_result calls.",
  ].join(" ");
  const stdout = run(process.execPath, codexArgs(fixtureDirectory, prompt), {
    cwd: repositoryRoot,
    timeout: 540_000,
  });
  fs.writeFileSync(path.join(fixtureDirectory, "codex-events.jsonl"), stdout, "utf8");
  const completedItems = assertCompletedTurn(parseCodexEvents(stdout));
  const toolCalls = completedItems.filter((item) => item.type === "mcp_tool_call" && item.status === "completed");
  const businessTools = ["long_text", "json_array", "logs", "structured"];
  for (const tool of businessTools) {
    const count = toolCalls.filter((item) => item.server === "slim_guard" && item.tool === tool).length;
    if (count !== 1) throw new Error(`Expected one ${tool} call, received ${count}`);
  }
  const recoveryCalls = toolCalls.filter((item) => item.server === "slim_guard" && item.tool === "read_result");
  if (recoveryCalls.length === 0) throw new Error("Codex did not call read_result");

  const finalMessage = completedItems.filter((item) => item.type === "agent_message").at(-1)?.text ?? "";
  for (const marker of [
    "EVIDENCE_LONG_TEXT",
    "EVIDENCE_JSON_0599",
    "EVIDENCE_LOG_FAILURE",
    "EVIDENCE_STRUCTURED_PASS_THROUGH",
  ]) {
    if (!finalMessage.includes(marker)) throw new Error(`Codex did not report recovered marker ${marker}`);
  }

  const fixtureCalls = fs
    .readFileSync(fixtureAuditPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line).tool);
  if (fixtureCalls.length !== 4) throw new Error(`Expected four fixture calls, received ${fixtureCalls.length}`);
  for (const tool of businessTools) {
    if (fixtureCalls.filter((name) => name === tool).length !== 1)
      throw new Error(`Fixture did not execute ${tool} exactly once`);
  }

  const profile = JSON.parse(run(process.execPath, [cli, "profile", "--json"], { cwd: fixtureDirectory }));
  const report = JSON.parse(run(process.execPath, [cli, "profile", "--share", "--json"], { cwd: fixtureDirectory }));
  const lifecycleOnlyPartial =
    report.coverage === "partial" &&
    profile.audit.reasons.length === 1 &&
    profile.audit.reasons[0] === "runtime_not_stopped";
  if (report.coverage !== "complete" && !lifecycleOnlyPartial) {
    throw new Error(`Profile coverage is ${report.coverage}: ${profile.audit.reasons.join(", ")}`);
  }
  if (report.calls.upstreamExecutions !== 4) throw new Error("Profile did not record exactly four upstream executions");
  if (report.calls.recoveryPageReads !== recoveryCalls.length)
    throw new Error("Codex and profile recovery counts differ");
  if (report.delivery.projected !== 3 || report.delivery.passThrough !== 1 || report.delivery.failOpen !== 0) {
    throw new Error("Profile delivery outcomes did not match 3 projected, 1 pass-through, 0 fail-open");
  }
  if (report.recovery.fullyRead !== 3 || report.recovery.exactRecovery !== "verified") {
    throw new Error("Profile did not verify exact recovery for all projected results");
  }
  if (report.rollback !== "available") throw new Error("Share report did not record available rollback");

  const rollback = JSON.parse(run(process.execPath, [cli, "rollback", "--json"], { cwd: fixtureDirectory }));
  if (rollback.status !== "rolled_back") throw new Error("Codex rollback did not complete");
  const restoredHash = sha256(fs.readFileSync(configPath));
  if (restoredHash !== baselineHash) throw new Error("Codex rollback did not restore the exact baseline config");
  const postRollbackReport = JSON.parse(
    run(process.execPath, [cli, "profile", "--share", "--json"], { cwd: fixtureDirectory }),
  );
  if (postRollbackReport.rollback !== "completed") throw new Error("Share report did not record completed rollback");

  console.log(
    JSON.stringify({
      host: "Codex CLI",
      model: selectedModel,
      reasoning_effort: "low",
      surface: "native",
      upstream_calls: fixtureCalls.length,
      read_result_calls: recoveryCalls.length,
      delivery: { projected: 3, pass_through: 1, fail_open: 0 },
      exact_recovery: true,
      rollback_sha256_match: true,
      lifecycle: lifecycleOnlyPartial ? "host_terminated_without_runtime_stopped" : "complete",
      report,
      evidence_directory: fixtureDirectory,
      passed: true,
    }),
  );
}

if (shareEvidenceMode) {
  runShareEvidenceAcceptance();
  process.exit(0);
}

const prompt = recoveryMode
  ? "Call the slim_guard MCP tool that returns large deterministic text exactly once. " +
    "Use read_result as many times as needed to recover the exact final marker without calling the upstream tool again. " +
    "Do not use the shell. Report the upstream tool name, read_result call count, and exact final marker."
  : "Use the arithmetic tool exposed by the slim_guard MCP server to calculate 19 plus 23. " +
    "You must call that MCP tool exactly once; do not use the shell and do not calculate it yourself. " +
    "Then report the tool name and returned value.";

const events = parseCodexEvents(
  run(process.execPath, codexArgs(basicFixtureDirectory, prompt), { cwd: repositoryRoot }),
);
const completedItems = assertCompletedTurn(events);
const toolCalls = completedItems.filter((item) => item.type === "mcp_tool_call" && item.status === "completed");
const finalMessage = completedItems.filter((item) => item.type === "agent_message").at(-1)?.text ?? "";

if (recoveryMode) {
  const upstreamCalls = toolCalls.filter((item) => item.server === "slim_guard" && item.tool === "large_text");
  const recoveryCalls = toolCalls.filter((item) => item.server === "slim_guard" && item.tool === "read_result");
  if (upstreamCalls.length !== 1) throw new Error(`Expected one large_text call, received ${upstreamCalls.length}`);
  if (recoveryCalls.length === 0) throw new Error("Codex did not call read_result");
  if (!finalMessage.includes("EXACT-END-MARKER:SLIM-GUARD-CODEX-NATIVE-RECOVERY-PASSED")) {
    throw new Error("Codex did not report the exact recovered marker");
  }
  console.log(
    JSON.stringify({
      host: "Codex CLI",
      model: selectedModel,
      reasoning_effort: "low",
      surface: "native",
      upstream_tool: "large_text",
      upstream_calls: 1,
      read_result_calls: recoveryCalls.length,
      exact_marker_recovered: true,
      passed: true,
    }),
  );
} else {
  const addCalls = toolCalls.filter((item) => item.server === "slim_guard" && item.tool === "add");
  if (addCalls.length !== 1) throw new Error(`Expected one add call, received ${addCalls.length}`);
  if (!finalMessage.includes("42")) throw new Error("Codex did not report the arithmetic Tool result");
  console.log(
    JSON.stringify({
      host: "Codex CLI",
      model: selectedModel,
      reasoning_effort: "low",
      surface: "native",
      upstream_tool: "add",
      upstream_calls: 1,
      returned_value: 42,
      passed: true,
    }),
  );
}
