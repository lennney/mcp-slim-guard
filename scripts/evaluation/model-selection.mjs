#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  pairedBootstrap,
  redactCapture,
  summarizeModelRuns,
  validateModelOutcome,
} from "./model-selection-core.mjs";
import { MODEL_SELECTION_SCENARIOS } from "./model-selection-scenarios.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
const fixtureServer = path.join(repositoryRoot, "scripts", "benchmark", "task-fixture-server.mjs");
const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
const slimGuardCwd = path.join(repositoryRoot, "scripts", "integration");
const evidenceDirectory = path.join(repositoryRoot, "docs", "evidence");
const pilot = process.argv.includes("--pilot");
const requestedAdapter = process.argv.find((argument) => argument.startsWith("--adapter="))?.split("=")[1];
const requestedProfile = process.argv.find((argument) => argument.startsWith("--profile="))?.split("=")[1];
const requestedLimit = Number(
  process.argv.find((argument) => argument.startsWith("--limit="))?.split("=")[1] ?? 0,
);
const defaultScenarios = pilot ? MODEL_SELECTION_SCENARIOS.slice(0, 4) : MODEL_SELECTION_SCENARIOS;
const scenarios = requestedLimit > 0 ? defaultScenarios.slice(0, requestedLimit) : defaultScenarios;
const adapters = requestedAdapter ? [requestedAdapter] : ["codex", "claude"];
const profiles = requestedProfile ? [requestedProfile] : ["baseline", "slim-guard"];

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function hostCommand(name) {
  if (process.platform !== "win32") return { command: name, prefix: [] };
  const npmDirectory = path.dirname(process.env.APPDATA ? path.join(process.env.APPDATA, "npm", `${name}.cmd`) : "");
  if (name === "codex") {
    return {
      command: process.execPath,
      prefix: [path.join(npmDirectory, "node_modules", "@openai", "codex", "bin", "codex.js")],
    };
  }
  return {
    command: path.join(
      npmDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    ),
    prefix: [],
  };
}

function serverDefinition(profile) {
  return profile === "baseline"
    ? { name: "fixture", command: process.execPath, args: [fixtureServer], cwd: repositoryRoot }
    : { name: "slim_guard", command: process.execPath, args: [slimGuardCli, "start"], cwd: slimGuardCwd };
}

function promptFor(scenario, profile) {
  const route =
    profile === "baseline"
      ? "Use the fixture MCP server directly."
      : "Use only the slim_guard MCP server. First use find_tool, then call_tool, and use read_result if needed.";
  return `${route}
Complete this task through MCP: ${scenario.prompt}
After the real tool call succeeds, return one JSON object and no markdown:
{"selected_tool":"the upstream domain tool name","arguments":{},"marker":"an exact distinctive substring copied from the real tool result"}
Do not invent a marker and do not answer without calling the tool.`;
}

function parseObject(text) {
  const candidates = String(text).match(/\{[\s\S]*\}/gu) ?? [];
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && "selected_tool" in parsed) return parsed;
    } catch {
      // Continue to the next candidate.
    }
  }
  throw new Error("No structured model outcome found");
}

function runClaude(definition, prompt) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-claude-eval-"));
  const configPath = path.join(temporaryDirectory, "mcp.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [definition.name]: {
          type: "stdio",
          command: definition.command,
          args: definition.args,
          cwd: definition.cwd,
        },
      },
    }),
  );
  try {
    const host = hostCommand("claude");
    const execution = spawnSync(
      host.command,
      [
        ...host.prefix,
        `--mcp-config=${configPath}`,
        "--strict-mcp-config",
        "--print",
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--max-budget-usd",
        "0.25",
        prompt,
      ],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true, timeout: 120_000 },
    );
    if (execution.error) throw execution.error;
    if (execution.status !== 0) throw new Error(execution.stderr || `Claude exited ${execution.status}`);
    const envelope = JSON.parse(execution.stdout);
    return {
      outcome: parseObject(envelope.result),
      model: Object.values(envelope.modelUsage ?? {}).map((usage) => usage.canonicalModel).filter(Boolean),
      cost_usd: envelope.total_cost_usd ?? null,
      raw: execution.stdout,
    };
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runCodex(definition, prompt) {
  const overrides = [
    `mcp_servers.${definition.name}.command=${JSON.stringify(definition.command)}`,
    `mcp_servers.${definition.name}.args=${JSON.stringify(definition.args)}`,
    `mcp_servers.${definition.name}.cwd=${JSON.stringify(definition.cwd)}`,
  ];
  const args = ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json"];
  for (const override of overrides) args.push("-c", override);
  args.push(prompt);
  const host = hostCommand("codex");
  const execution = spawnSync(host.command, [...host.prefix, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (execution.error) throw execution.error;
  if (execution.status !== 0) throw new Error(execution.stderr || `Codex exited ${execution.status}`);
  const events = execution.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text);
  return { outcome: parseObject(messages.at(-1) ?? execution.stdout), model: ["codex-cli-configured-model"], cost_usd: null, raw: execution.stdout };
}

function runOne(adapter, profile, scenario) {
  const startedAt = Date.now();
  try {
    const definition = serverDefinition(profile);
    const response =
      adapter === "claude"
        ? runClaude(definition, promptFor(scenario, profile))
        : runCodex(definition, promptFor(scenario, profile));
    return {
      adapter,
      profile,
      scenario_id: scenario.id,
      language: scenario.language,
      status: "completed",
      model: response.model,
      cost_usd: response.cost_usd,
      duration_ms: Date.now() - startedAt,
      outcome: response.outcome,
      score: validateModelOutcome(response.outcome, scenario),
      capture: redactCapture(response.raw).slice(-20_000),
    };
  } catch (error) {
    return {
      adapter,
      profile,
      scenario_id: scenario.id,
      language: scenario.language,
      status: "error",
      duration_ms: Date.now() - startedAt,
      error: redactCapture(error instanceof Error ? error.message : String(error)).slice(0, 4_000),
    };
  }
}

function comparisons(runs) {
  const output = {};
  for (const adapter of adapters) {
    const completed = runs.filter((run) => run.adapter === adapter && run.status === "completed");
    const paired = scenarios
      .map((scenario) => ({
        baseline: completed.find((run) => run.profile === "baseline" && run.scenario_id === scenario.id),
        slim: completed.find((run) => run.profile === "slim-guard" && run.scenario_id === scenario.id),
      }))
      .filter((pair) => pair.baseline && pair.slim);
    output[adapter] = {
      paired_scenarios: paired.length,
      task_success: paired.length
        ? pairedBootstrap(
            paired.map((pair) => pair.baseline.score.task_success),
            paired.map((pair) => pair.slim.score.task_success),
          )
        : null,
      first_valid_arguments: paired.length
        ? pairedBootstrap(
            paired.map((pair) => pair.baseline.score.first_arguments_valid),
            paired.map((pair) => pair.slim.score.first_arguments_valid),
          )
        : null,
    };
  }
  return output;
}

async function main() {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const runs = [];
  let abortedReason = null;
  runLoop:
  for (const adapter of adapters) {
    for (const profile of profiles) {
      for (const scenario of scenarios) {
        const run = runOne(adapter, profile, scenario);
        runs.push(run);
        console.log(`${run.status === "completed" ? "PASS" : "ERROR"} ${adapter} ${profile} ${scenario.id}`);
        if (run.status === "error") console.error(run.error);
        const errors = runs.filter((item) => item.status === "error").length;
        if (runs.length >= 4 && errors / runs.length > 0.25) {
          abortedReason = `Infrastructure error rate exceeded 25% (${errors}/${runs.length})`;
          break runLoop;
        }
      }
    }
  }
  const report = {
    schema_version: 1,
    benchmark_date: "2026-07-26",
    pilot,
    aborted_reason: abortedReason,
    methodology: {
      scenarios: scenarios.length,
      isolated_host_sessions: true,
      profiles,
      adapters,
      non_inferiority_margin: -0.05,
      bootstrap_iterations: 10_000,
    },
    summary: summarizeModelRuns(runs),
    comparisons: comparisons(runs),
    runs,
  };
  const suffix = pilot ? "pilot" : "full";
  const outputPath = path.join(evidenceDirectory, `2026-07-26-model-selection-${suffix}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, summary: report.summary, comparisons: report.comparisons }, null, 2));
  if (abortedReason) {
    console.error(abortedReason);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
