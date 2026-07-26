#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const agentSearchRoot = process.argv[2] ?? process.env.SLIM_GUARD_AGENT_SEARCH_ROOT;
if (!agentSearchRoot) {
  throw new Error("Pass the local Agent Search MCP checkout or set SLIM_GUARD_AGENT_SEARCH_ROOT");
}

const runtimeDirectory = path.join(path.resolve(agentSearchRoot), ".codex");
const auditFile = path.join(runtimeDirectory, "mcp-slim-guard-audit.log");
const cli = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(repositoryRoot, "dist", "cli.js");
const query = "slim guard audit trace offline dogfood";
const client = new Client(
  { name: "slim-guard-agent-search-audit-smoke", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

function textJson(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected a JSON text block");
  return JSON.parse(block.text);
}

function readEntries() {
  if (!fs.existsSync(auditFile)) return [];
  return fs
    .readFileSync(auditFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [cli, "start"],
      cwd: runtimeDirectory,
      stderr: "pipe",
    }),
  );

  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(["call_tool", "find_tool", "read_result"])) {
    throw new Error(`Unexpected tool surface: ${names.join(", ")}`);
  }

  const found = await client.callTool({
    name: "find_tool",
    arguments: { query: "advanced search filters" },
  });
  const match = textJson(found).matches?.find((candidate) => candidate.name === "agent_search_free_search_advanced");
  if (!match?.tool_ref) {
    throw new Error("Slim Guard did not discover agent_search_free_search_advanced");
  }

  const called = await client.callTool({
    name: "call_tool",
    arguments: {
      tool_ref: match.tool_ref,
      arguments: { query, time_range: "day" },
    },
  });
  if (called.isError !== true || !JSON.stringify(called).includes("UNSUPPORTED_FILTER")) {
    throw new Error("Agent Search did not return its expected offline validation error");
  }

  await client.close();

  const entries = readEntries();
  const policyEntry = [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.event === "policy" &&
        entry.toolName === "agent_search_free_search_advanced" &&
        entry.arguments?.query === query,
    );
  if (!policyEntry?.traceId) {
    throw new Error("Audit log did not correlate the Agent Search policy event");
  }
  const trace = entries.filter((entry) => entry.traceId === policyEntry.traceId);
  for (const expected of [
    ["policy", "success"],
    ["upstream", "upstream_error"],
    ["projection", "upstream_error"],
  ]) {
    if (!trace.some((entry) => entry.event === expected[0] && entry.outcome === expected[1])) {
      throw new Error(`Agent Search trace is missing ${expected[0]}/${expected[1]}`);
    }
  }
  if (trace.some((entry) => entry.action === "blocked")) {
    throw new Error("Agent Search upstream error was misclassified as a policy block");
  }
  if (JSON.stringify(trace).includes(match.tool_ref)) {
    throw new Error("Agent Search trace retained a raw tool_ref");
  }
  const lifecycleStates = entries
    .filter((entry) => entry.sessionId === policyEntry.sessionId && entry.event === "lifecycle")
    .map((entry) => entry.toolName);
  for (const expected of ["runtime/starting", "runtime/ready", "runtime/stopping", "runtime/stopped"]) {
    if (!lifecycleStates.includes(expected)) {
      throw new Error(`Agent Search runtime is missing lifecycle state ${expected}`);
    }
  }

  console.log(
    JSON.stringify({
      host: "SDK client",
      upstream: "Agent Search MCP",
      slim_guard_cli: cli,
      transport: "stdio",
      model_calls: 0,
      live_search_requests: 0,
      tools: names,
      expected_upstream_error: "UNSUPPORTED_FILTER",
      trace_id: policyEntry.traceId,
      stages: trace.map((entry) => `${entry.event}/${entry.outcome}`),
      lifecycle_states: lifecycleStates,
      blocked_events: trace.filter((entry) => entry.action === "blocked").length,
      raw_tool_ref_logged: false,
      passed: true,
    }),
  );
} finally {
  await client.close().catch(() => {});
}
