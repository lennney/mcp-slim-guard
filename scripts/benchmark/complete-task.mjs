#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { get_encoding } from "tiktoken";
import { MODEL_SELECTION_SCENARIOS } from "../evaluation/model-selection-scenarios.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const fixtureServer = path.join(scriptDirectory, "task-fixture-server.mjs");
const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
const reportPath = path.join(repositoryRoot, "docs", "evidence", "2026-07-26-complete-task-capture.json");
const encoding = get_encoding("o200k_base");

const TASKS = MODEL_SELECTION_SCENARIOS.map((scenario) => ({
  id: scenario.id,
  language: scenario.language,
  prompt: scenario.prompt,
  intent: scenario.tool.replaceAll("_", " "),
  tool: scenario.tool,
  arguments: scenario.arguments,
  expected: scenario.marker,
}));

function normalizeWire(value) {
  return JSON.stringify(value)
    .replace(/result_[a-f0-9]{32}/gu, `result_${"0".repeat(32)}`)
    .replace(/tool_[a-f0-9]{16}_\d+/gu, "tool_0000000000000000_0")
    .replace(/"catalog_digest":"[a-f0-9]{64}"/gu, `"catalog_digest":"${"0".repeat(64)}"`);
}

function tokenCount(value) {
  return encoding.encode(typeof value === "string" ? value : normalizeWire(value)).length;
}

function parseText(result) {
  const content = result.content?.[0];
  if (!content || content.type !== "text") {
    throw new Error("Expected a text CallToolResult");
  }
  return JSON.parse(content.text);
}

function containsExpected(value, expected) {
  return normalizeWire(value).includes(expected);
}

function recordEvent(events, kind, request, response) {
  const requestWire = normalizeWire(request);
  const responseWire = normalizeWire(response);
  const requestTokens = tokenCount(request);
  const responseTokens = tokenCount(response);
  events.push({
    kind,
    request_chars: requestWire.length,
    response_chars: responseWire.length,
    request_tokens: requestTokens,
    response_tokens: responseTokens,
    total_tokens: requestTokens + responseTokens,
    request_sha256: createHash("sha256").update(requestWire).digest("hex"),
    response_sha256: createHash("sha256").update(responseWire).digest("hex"),
    request_preview: requestWire.slice(0, 240),
    response_preview: responseWire.slice(0, 240),
  });
}

function executableVersion(executable) {
  return execFileSync(executable, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function resolveCompetitor() {
  const executable = process.env.MCP_COMPRESSOR_BIN;
  if (!executable) {
    return undefined;
  }
  return {
    executable,
    version: executableVersion(executable),
  };
}

function slimGuardConfig(temporaryDirectory, auditPath) {
  return {
    version: 1,
    tools: { allow: ["fixture_*"], deny: [] },
    ssrf: {
      mode: "off",
      block_private_ips: false,
      allow_domains: [],
      block_domains: [],
    },
    rate_limit: { default: "1000/min" },
    injection_detection: { enabled: false },
    compressor: { enabled: true, level: "light" },
    audit: {
      output: "stdout",
      filePath: path.join(temporaryDirectory, "audit.log"),
    },
    servers: {
      fixture: {
        command: process.execPath,
        args: [fixtureServer],
        cwd: repositoryRoot,
        env: {
          SLIM_GUARD_FIXTURE_AUDIT_PATH: auditPath,
        },
      },
    },
  };
}

async function connectProfile(profile, competitor, temporaryDirectory, auditPath) {
  let parameters;
  if (profile === "baseline") {
    parameters = {
      command: process.execPath,
      args: [fixtureServer],
      cwd: repositoryRoot,
    };
  } else if (profile === "mcp-compressor") {
    parameters = {
      command: competitor.executable,
      args: ["--compression", "medium", "--server-name", "fixture", "--", process.execPath, fixtureServer],
      cwd: repositoryRoot,
    };
  } else {
    fs.writeFileSync(
      path.join(temporaryDirectory, "mcp-slim-guard.yml"),
      JSON.stringify(slimGuardConfig(temporaryDirectory, auditPath), null, 2),
      "utf8",
    );
    parameters = {
      command: process.execPath,
      args: [slimGuardCli, "start"],
      cwd: temporaryDirectory,
    };
  }

  const transport = new StdioClientTransport({
    ...parameters,
    env: {
      ...process.env,
      SLIM_GUARD_FIXTURE_AUDIT_PATH: auditPath,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-8_000);
  });
  const client = new Client(
    { name: "slim-guard-complete-task-benchmark", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(
      `${profile} failed to connect: ${error instanceof Error ? error.message : String(error)}\n${stderr}`,
    );
  }
  return { client, transport };
}

async function callAndRecord(client, events, kind, name, args) {
  const request = { name, arguments: args };
  const response = await client.callTool(request);
  recordEvent(events, kind, request, response);
  return response;
}

async function runBaselineTask(client, task, events) {
  return callAndRecord(client, events, "invoke", task.tool, task.arguments);
}

async function runCompetitorTask(client, task, events) {
  await callAndRecord(client, events, "schema", "fixture_get_tool_schema", {
    tool_name: task.tool,
  });
  return callAndRecord(client, events, "invoke", "fixture_invoke_tool", {
    tool_name: task.tool,
    tool_input: task.arguments,
  });
}

async function runSlimGuardTask(client, task, events) {
  const found = await callAndRecord(client, events, "discovery", "find_tool", {
    query: task.intent,
  });
  const match = parseText(found).matches?.find((candidate) => candidate.name === `fixture_${task.tool}`);
  if (!match) {
    throw new Error(`Slim Guard did not find fixture_${task.tool} for ${task.id}`);
  }

  const delivered = await callAndRecord(client, events, "invoke", "call_tool", {
    tool_ref: match.tool_ref,
    arguments: task.arguments,
  });
  const capsule = parseText(delivered);
  if (!capsule.result_ref) {
    return {
      finalResult: delivered,
      exactRecovery: false,
      recoveredContentSha256: null,
    };
  }

  let finalResult = delivered;
  let cursor = containsExpected(delivered, task.expected) ? null : capsule.next_cursor;
  if (cursor !== null) {
    while (cursor !== null) {
      const page = await callAndRecord(client, events, "retrieval", "read_result", {
        result_ref: capsule.result_ref,
        cursor,
      });
      if (containsExpected(page, task.expected)) {
        finalResult = page;
        break;
      }
      cursor = page.structuredContent?.next_cursor;
    }
  }

  const chunks = [];
  cursor = capsule.replay_cursor;
  while (cursor !== null) {
    const page = await callAndRecord(client, events, "recovery", "read_result", {
      result_ref: capsule.result_ref,
      cursor,
    });
    const block = page.content?.[0];
    if (!block || block.type !== "text") {
      throw new Error(`Slim Guard returned a non-text recovery page for ${task.id}`);
    }
    chunks.push(block.text);
    cursor = page.structuredContent?.next_cursor;
  }
  const payload = chunks.join("");
  const reconstructed =
    capsule.encoding === "single-text-v1"
      ? {
          content: [{ type: "text", text: payload }],
          ...(capsule.result_shape ?? {}),
        }
      : JSON.parse(payload);
  if (!containsExpected(reconstructed, task.expected)) {
    throw new Error(`Slim Guard exact recovery lost the expected result for ${task.id}`);
  }
  return {
    finalResult,
    exactRecovery: true,
    recoveredContentSha256: createHash("sha256").update(JSON.stringify(reconstructed.content)).digest("hex"),
  };
}

function auditEntries(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runProfile(profile, competitor) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `slim-guard-bench-${profile}-`));
  const auditPath = path.join(temporaryDirectory, "fixture-invocations.jsonl");
  const connection = await connectProfile(profile, competitor, temporaryDirectory, auditPath);
  const results = [];

  try {
    for (const task of TASKS) {
      const events = [];
      const upstreamCallsBefore = auditEntries(auditPath).length;
      const toolsResponse = await connection.client.listTools();
      const advertisedTools = toolsResponse.tools.map((tool) => tool.name).sort();
      if (
        profile === "slim-guard" &&
        JSON.stringify(advertisedTools) !== JSON.stringify(["call_tool", "find_tool", "read_result"])
      ) {
        throw new Error(`Slim Guard exposed an unexpected tool surface: ${advertisedTools.join(", ")}`);
      }
      recordEvent(events, "tools/list", { method: "tools/list" }, toolsResponse);

      let finalResult;
      let exactRecovery = false;
      let recoveredContentSha256 = null;
      if (profile === "baseline") {
        finalResult = await runBaselineTask(connection.client, task, events);
      } else if (profile === "mcp-compressor") {
        finalResult = await runCompetitorTask(connection.client, task, events);
      } else {
        const slimResult = await runSlimGuardTask(connection.client, task, events);
        finalResult = slimResult.finalResult;
        exactRecovery = slimResult.exactRecovery;
        recoveredContentSha256 = slimResult.recoveredContentSha256;
      }

      const upstreamEntries = auditEntries(auditPath).slice(upstreamCallsBefore);
      if (upstreamEntries.length !== 1 || upstreamEntries[0].tool !== task.tool) {
        throw new Error(
          `${profile} made ${upstreamEntries.length} upstream calls for ${task.id}; expected one ${task.tool} call`,
        );
      }
      const success = containsExpected(finalResult, task.expected);
      if (!success) {
        throw new Error(
          `${profile} did not produce expected marker for ${task.id}: ${normalizeWire(finalResult).slice(0, 1_000)}`,
        );
      }
      const promptTokens = tokenCount(task.prompt);
      const taskEventTokens = events
        .filter((event) => event.kind !== "recovery")
        .reduce((sum, event) => sum + event.total_tokens, 0);
      const recoveryVerificationTokens = events
        .filter((event) => event.kind === "recovery")
        .reduce((sum, event) => sum + event.total_tokens, 0);
      results.push({
        task_id: task.id,
        language: task.language,
        success,
        prompt_tokens: promptTokens,
        protocol_events: events.length,
        advertised_tool_count: advertisedTools.length,
        upstream_calls: upstreamEntries.length,
        retries: 0,
        exact_recovery: exactRecovery,
        result_content_sha256: createHash("sha256").update(JSON.stringify(finalResult.content)).digest("hex"),
        recovered_content_sha256: recoveredContentSha256,
        event_tokens: taskEventTokens,
        recovery_verification_tokens: recoveryVerificationTokens,
        total_tokens: promptTokens + taskEventTokens,
        total_with_recovery_verification_tokens: promptTokens + taskEventTokens + recoveryVerificationTokens,
        events,
      });
    }
  } finally {
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return results;
}

function summarize(results) {
  return {
    tasks: results.length,
    successful_tasks: results.filter((result) => result.success).length,
    protocol_events: results.reduce((sum, result) => sum + result.protocol_events, 0),
    upstream_calls: results.reduce((sum, result) => sum + result.upstream_calls, 0),
    exact_recoveries: results.filter((result) => result.exact_recovery).length,
    advertised_tool_counts: [...new Set(results.map((result) => result.advertised_tool_count))],
    retries: results.reduce((sum, result) => sum + result.retries, 0),
    total_tokens: results.reduce((sum, result) => sum + result.total_tokens, 0),
    recovery_verification_tokens: results.reduce((sum, result) => sum + result.recovery_verification_tokens, 0),
    total_with_recovery_verification_tokens: results.reduce(
      (sum, result) => sum + result.total_with_recovery_verification_tokens,
      0,
    ),
    average_tokens: Math.round(results.reduce((sum, result) => sum + result.total_tokens, 0) / results.length),
  };
}

function reduction(reference, candidate) {
  return Number((((reference - candidate) / reference) * 100).toFixed(2));
}

async function main() {
  const competitor = resolveCompetitor();
  const profiles = {};
  const requestedProfiles = competitor ? ["baseline", "mcp-compressor", "slim-guard"] : ["baseline", "slim-guard"];
  for (const profile of requestedProfiles) {
    profiles[profile] = await runProfile(profile, competitor);
  }
  for (const slimResult of profiles["slim-guard"].filter((result) => result.exact_recovery)) {
    const baselineResult = profiles.baseline.find((result) => result.task_id === slimResult.task_id);
    if (!baselineResult || slimResult.recovered_content_sha256 !== baselineResult.result_content_sha256) {
      throw new Error(`Exact MCP result recovery did not match baseline for ${slimResult.task_id}`);
    }
  }

  const summary = Object.fromEntries(
    Object.entries(profiles).map(([profile, results]) => [profile, summarize(results)]),
  );
  const comparisons = {
    slim_guard_vs_baseline_percent: reduction(summary.baseline.total_tokens, summary["slim-guard"].total_tokens),
  };
  if (summary["mcp-compressor"]) {
    comparisons.mcp_compressor_vs_baseline_percent = reduction(
      summary.baseline.total_tokens,
      summary["mcp-compressor"].total_tokens,
    );
    comparisons.slim_guard_vs_mcp_compressor_percent = reduction(
      summary["mcp-compressor"].total_tokens,
      summary["slim-guard"].total_tokens,
    );
  }

  const report = {
    schema_version: 1,
    benchmark_date: "2026-07-26",
    methodology: {
      kind: "deterministic successful protocol replay",
      tokenizer: "o200k_base",
      accounting: "prompt plus every MCP tools/list and tools/call request and response payload",
      slim_guard_retrieval: "read until the expected task marker is visible or the snapshot ends",
      exact_recovery:
        "Every oversized Slim Guard result is replayed from cursor 0 and its recovered content hash is compared with the baseline MCP result.",
      upstream_call_accounting:
        "The fixture MCP server appends one project-local audit entry per invocation; every task must produce exactly one upstream call, including tasks using read_result.",
      limitation: "No model selects tools; this capture measures successful-path task cost, not model accuracy.",
    },
    provenance: {
      fixture_sha256: createHash("sha256").update(fs.readFileSync(fixtureServer)).digest("hex"),
      ...(competitor
        ? {
            competitor: competitor.version,
            competitor_compression: "medium",
          }
        : {}),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    tasks: TASKS.map(({ id, language, prompt, tool, expected }) => ({
      id,
      language,
      prompt,
      tool,
      expected,
    })),
    profiles,
    summary,
    comparisons,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ report: reportPath, summary, comparisons: report.comparisons }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    encoding.free();
  });
