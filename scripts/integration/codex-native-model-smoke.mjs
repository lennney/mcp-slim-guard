#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const codexEntry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
const cli = path.join(repositoryRoot, "dist", "cli.js");
const fixtureDirectory = path.join(repositoryRoot, ".artifacts", "codex-native-host-acceptance");
const recoveryMode = process.argv.includes("--recovery");
const prompt = recoveryMode
  ? "Call the slim_guard MCP tool that returns large deterministic text exactly once. " +
    "Use read_result as many times as needed to recover the exact final marker without calling the upstream tool again. " +
    "Do not use the shell. Report the upstream tool name, read_result call count, and exact final marker."
  : "Use the arithmetic tool exposed by the slim_guard MCP server to calculate 19 plus 23. " +
    "You must call that MCP tool exactly once; do not use the shell and do not calculate it yourself. " +
    "Then report the tool name and returned value.";

const result = spawnSync(
  process.execPath,
  [
    codexEntry,
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--json",
    "--sandbox",
    "read-only",
    "--cd",
    repositoryRoot,
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
  ],
  {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  throw new Error(`codex exec exited ${result.status}`);
}

const events = result.stdout
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const completedItems = events.filter((event) => event.type === "item.completed").map((event) => event.item);
const toolCalls = completedItems.filter((item) => item.type === "mcp_tool_call" && item.status === "completed");
const finalMessage = completedItems.filter((item) => item.type === "agent_message").at(-1)?.text ?? "";
const turnCompleted = events.some((event) => event.type === "turn.completed");

if (!turnCompleted) throw new Error("Codex turn did not complete");

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
      surface: "native",
      upstream_tool: "large_text",
      upstream_calls: upstreamCalls.length,
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
      surface: "native",
      upstream_tool: "add",
      upstream_calls: addCalls.length,
      returned_value: 42,
      passed: true,
    }),
  );
}
