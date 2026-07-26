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

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const fixtureServer = path.join(scriptDirectory, "task-fixture-server.mjs");
const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
const reportPath = path.join(repositoryRoot, "docs", "evidence", "2026-07-26-complete-task-capture.json");
const encoding = get_encoding("o200k_base");

const TASKS = [
  {
    id: "en-catalog-search",
    language: "en",
    prompt: 'Search the product catalog for "adapter" and return three results.',
    intent: "search product catalog",
    tool: "search_catalog",
    arguments: { query: "adapter", locale: "en", limit: 3 },
    expected: "CATALOG:adapter:en",
  },
  {
    id: "zh-catalog-search",
    language: "zh",
    prompt: "检索产品目录中的“适配器”，返回三个结果。",
    intent: "检索产品目录",
    tool: "search_catalog",
    arguments: { query: "适配器", locale: "zh", limit: 3 },
    expected: "CATALOG:适配器:zh",
  },
  {
    id: "en-report-header",
    language: "en",
    prompt: "Generate the full RPT-42 report and confirm its header marker.",
    intent: "generate detailed operational report",
    tool: "generate_report",
    arguments: { report_id: "RPT-42", locale: "en", detail: "full" },
    expected: "REPORT:RPT-42:en:BEGIN",
  },
  {
    id: "zh-report-tail",
    language: "zh",
    prompt: "生成完整的 CN-77 运营报告，并核验报告末尾标记。",
    intent: "生成详细运营报告",
    tool: "generate_report",
    arguments: { report_id: "CN-77", locale: "zh", detail: "full" },
    expected: "REPORT:CN-77:zh:END",
  },
];

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

function findOnPath(executable) {
  try {
    const command = process.platform === "win32" ? "where.exe" : "which";
    return execFileSync(command, [executable], {
      encoding: "utf8",
      windowsHide: true,
    })
      .split(/\r?\n/u)
      .find(Boolean);
  } catch {
    return undefined;
  }
}

function resolveCompetitor() {
  const configured = process.env.MCP_COMPRESSOR_BIN;
  const executable = configured || findOnPath("mcp-compressor");
  if (!executable) {
    throw new Error("mcp-compressor executable not found. Set MCP_COMPRESSOR_BIN to the official CLI executable.");
  }
  return {
    executable,
    version: executableVersion(executable),
  };
}

function slimGuardConfig(temporaryDirectory) {
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
        env: {},
      },
    },
  };
}

async function connectProfile(profile, competitor, temporaryDirectory) {
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
      JSON.stringify(slimGuardConfig(temporaryDirectory), null, 2),
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
    env: { ...process.env },
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
  if (containsExpected(delivered, task.expected)) return delivered;

  const capsule = parseText(delivered);
  if (!capsule.result_ref) return delivered;

  let cursor = capsule.next_cursor;
  while (cursor !== null) {
    const page = await callAndRecord(client, events, "retrieval", "read_result", {
      result_ref: capsule.result_ref,
      cursor,
    });
    if (containsExpected(page, task.expected)) return page;
    cursor = page.structuredContent?.next_cursor;
  }
  return delivered;
}

async function runProfile(profile, competitor) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `slim-guard-bench-${profile}-`));
  const connection = await connectProfile(profile, competitor, temporaryDirectory);
  const results = [];

  try {
    for (const task of TASKS) {
      const events = [];
      const toolsResponse = await connection.client.listTools();
      recordEvent(events, "tools/list", { method: "tools/list" }, toolsResponse);

      let finalResult;
      if (profile === "baseline") {
        finalResult = await runBaselineTask(connection.client, task, events);
      } else if (profile === "mcp-compressor") {
        finalResult = await runCompetitorTask(connection.client, task, events);
      } else {
        finalResult = await runSlimGuardTask(connection.client, task, events);
      }

      const success = containsExpected(finalResult, task.expected);
      if (!success) {
        throw new Error(
          `${profile} did not produce expected marker for ${task.id}: ${normalizeWire(finalResult).slice(0, 1_000)}`,
        );
      }
      const promptTokens = tokenCount(task.prompt);
      results.push({
        task_id: task.id,
        language: task.language,
        success,
        prompt_tokens: promptTokens,
        protocol_events: events.length,
        retries: 0,
        event_tokens: events.reduce((sum, event) => sum + event.total_tokens, 0),
        total_tokens: promptTokens + events.reduce((sum, event) => sum + event.total_tokens, 0),
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
    retries: results.reduce((sum, result) => sum + result.retries, 0),
    total_tokens: results.reduce((sum, result) => sum + result.total_tokens, 0),
    average_tokens: Math.round(results.reduce((sum, result) => sum + result.total_tokens, 0) / results.length),
  };
}

function reduction(reference, candidate) {
  return Number((((reference - candidate) / reference) * 100).toFixed(2));
}

async function main() {
  const competitor = resolveCompetitor();
  const profiles = {};
  for (const profile of ["baseline", "mcp-compressor", "slim-guard"]) {
    profiles[profile] = await runProfile(profile, competitor);
  }

  const summary = Object.fromEntries(
    Object.entries(profiles).map(([profile, results]) => [profile, summarize(results)]),
  );
  const report = {
    schema_version: 1,
    benchmark_date: "2026-07-26",
    methodology: {
      kind: "deterministic successful protocol replay",
      tokenizer: "o200k_base",
      accounting: "prompt plus every MCP tools/list and tools/call request and response payload",
      slim_guard_retrieval: "read until the expected task marker is visible or the snapshot ends",
      limitation: "No model selects tools; this capture measures successful-path task cost, not model accuracy.",
    },
    provenance: {
      fixture_sha256: createHash("sha256").update(fs.readFileSync(fixtureServer)).digest("hex"),
      competitor: competitor.version,
      competitor_compression: "medium",
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
    comparisons: {
      mcp_compressor_vs_baseline_percent: reduction(
        summary.baseline.total_tokens,
        summary["mcp-compressor"].total_tokens,
      ),
      slim_guard_vs_baseline_percent: reduction(summary.baseline.total_tokens, summary["slim-guard"].total_tokens),
      slim_guard_vs_mcp_compressor_percent: reduction(
        summary["mcp-compressor"].total_tokens,
        summary["slim-guard"].total_tokens,
      ),
    },
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
