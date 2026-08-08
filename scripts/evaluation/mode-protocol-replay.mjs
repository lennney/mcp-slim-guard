import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MODEL_SELECTION_SCENARIOS } from "./model-selection-scenarios.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "..", "..");
export const fixtureServer = path.join(repositoryRoot, "scripts", "benchmark", "task-fixture-server.mjs");
export const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
export const MODE_PROFILES = ["baseline", "native", "compact", "extreme"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createModeProtocolSuite() {
  return {
    schema_version: 1,
    id: "three-modes-24-task",
    kind: "protocol-replay",
    fixture_digest: sha256(fs.readFileSync(fixtureServer)),
    profiles: [...MODE_PROFILES],
    cases: MODEL_SELECTION_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      language: scenario.language,
      prompt: scenario.prompt,
      expected_tool: scenario.tool,
      expected_marker: scenario.marker,
    })),
    expected_advertised_tool_counts: {
      baseline: 12,
      native: 13,
      compact: 3,
      extreme: 3,
    },
  };
}

function parseText(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected a text MCP result");
  return JSON.parse(block.text);
}

function slimGuardConfig(temporaryDirectory, auditPath) {
  return {
    version: 2,
    tools: { allow: ["fixture_*"], deny: [] },
    ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
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
  };
}

async function connectProfile(profile, temporaryDirectory, auditPath) {
  const parameters =
    profile === "baseline"
      ? { command: process.execPath, args: [fixtureServer], cwd: repositoryRoot }
      : (() => {
          fs.writeFileSync(
            path.join(temporaryDirectory, "mcp-slim-guard.yml"),
            JSON.stringify(slimGuardConfig(temporaryDirectory, auditPath), null, 2),
            "utf8",
          );
          return {
            command: process.execPath,
            args: [slimGuardCli, "start", "--mode", profile],
            cwd: temporaryDirectory,
          };
        })();
  const transport = new StdioClientTransport({
    ...parameters,
    env: { ...process.env, SLIM_GUARD_FIXTURE_AUDIT_PATH: auditPath },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "slim-guard-mode-protocol-evaluation", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  await client.connect(transport);
  return { client, transport };
}

async function callAndCapture(client, events, kind, name, args) {
  const request = { name, arguments: args };
  const response = await client.callTool(request);
  events.push({ kind, request, response });
  return response;
}

async function recoverIfNeeded(client, events, delivered) {
  let capsule;
  try {
    capsule = parseText(delivered);
  } catch {
    return { finalResult: delivered, recoveredResult: null };
  }
  if (!capsule?.result_ref || capsule.replay_cursor === undefined) {
    return { finalResult: delivered, recoveredResult: null };
  }

  const chunks = [];
  let cursor = capsule.replay_cursor;
  while (cursor !== null) {
    const page = await callAndCapture(client, events, "recovery", "read_result", {
      result_ref: capsule.result_ref,
      cursor,
    });
    const block = page.content?.[0];
    if (!block || block.type !== "text") throw new Error("read_result did not return a text chunk");
    chunks.push(block.text);
    cursor = page.structuredContent?.next_cursor ?? null;
  }

  const serialized = chunks.join("");
  const reconstructed =
    capsule.encoding === "single-text-v1"
      ? { content: [{ type: "text", text: serialized }], ...(capsule.result_shape ?? {}) }
      : JSON.parse(serialized);
  return { finalResult: reconstructed, recoveredResult: reconstructed };
}

async function runModeTask(client, events, profile, scenario) {
  if (profile === "native") {
    return recoverIfNeeded(
      client,
      events,
      await callAndCapture(client, events, "invoke", scenario.tool, scenario.arguments),
    );
  }
  const found = await callAndCapture(client, events, "discovery", "find_tool", {
    query: scenario.tool.replaceAll("_", " "),
  });
  const match = parseText(found).matches?.find((candidate) => candidate.name === `fixture_${scenario.tool}`);
  if (!match) throw new Error(`${profile} did not find fixture_${scenario.tool} for ${scenario.id}`);
  return recoverIfNeeded(
    client,
    events,
    await callAndCapture(client, events, "invoke", "call_tool", {
      tool_ref: match.tool_ref,
      arguments: scenario.arguments,
    }),
  );
}

function auditEntries(auditPath) {
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runProfile(profile, suite) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `slim-guard-eval-${profile}-`));
  const auditPath = path.join(temporaryDirectory, "fixture-invocations.jsonl");
  const connection = await connectProfile(profile, temporaryDirectory, auditPath);
  const observations = [];
  try {
    for (const suiteCase of suite.cases) {
      const scenario = MODEL_SELECTION_SCENARIOS.find((candidate) => candidate.id === suiteCase.id);
      if (!scenario) throw new Error(`Unknown protocol replay case: ${suiteCase.id}`);
      const events = [];
      const upstreamCallsBefore = auditEntries(auditPath).length;
      const toolsResponse = await connection.client.listTools();
      events.push({ kind: "tools/list", request: { method: "tools/list" }, response: toolsResponse });
      const outcome =
        profile === "baseline"
          ? {
              finalResult: await callAndCapture(connection.client, events, "invoke", scenario.tool, scenario.arguments),
              recoveredResult: null,
            }
          : await runModeTask(connection.client, events, profile, scenario);
      observations.push({
        profile,
        case_id: suiteCase.id,
        advertised_tools: toolsResponse.tools.map((tool) => tool.name).sort(),
        upstream_invocations: auditEntries(auditPath).slice(upstreamCallsBefore),
        events,
        final_result: outcome.finalResult,
        recovered_result: outcome.recoveredResult,
      });
    }
  } finally {
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return observations;
}

export function createModeProtocolReplayAdapter() {
  return {
    id: "local-stdio-mode-protocol-replay",
    async run({ suite }) {
      const observations = [];
      for (const profile of suite.profiles) observations.push(...(await runProfile(profile, suite)));
      return { observations };
    },
  };
}
