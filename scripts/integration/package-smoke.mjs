#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-package-smoke-"));
const npmCli = process.env.npm_execpath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  if (npmCli?.endsWith(".js")) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run("npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function createTarball() {
  const packDirectory = path.join(temporaryRoot, "pack");
  fs.mkdirSync(packDirectory);
  const result = runNpm(["pack", "--json", "--pack-destination", packDirectory]);
  const packed = JSON.parse(result.stdout);
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not return a tarball filename");
  return path.join(packDirectory, filename);
}

function verifyCodexConfiguration(cli, runtimeDirectory) {
  if (process.env.SLIM_GUARD_DOGFOOD_CODEX !== "1") return null;

  const codexEntry =
    process.env.SLIM_GUARD_CODEX_ENTRY ??
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (!fs.existsSync(codexEntry)) {
    throw new Error(`Codex CLI entry not found: ${codexEntry}`);
  }

  const version = run(process.execPath, [codexEntry, "--version"]).stdout.trim();
  const result = run(process.execPath, [
    codexEntry,
    "mcp",
    "list",
    "-c",
    `mcp_servers.slim_guard.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.slim_guard.args=${JSON.stringify([cli, "start"])}`,
    "-c",
    `mcp_servers.slim_guard.cwd=${JSON.stringify(runtimeDirectory)}`,
  ]);
  if (!result.stdout.includes("slim_guard")) {
    throw new Error("Codex did not accept the installed candidate configuration");
  }

  return {
    host: "Codex CLI",
    version,
    mode: "ephemeral configuration",
    configured_server: "slim_guard",
    global_config_changed: false,
    model_calls: 0,
    passed: true,
  };
}

function fixtureSource() {
  return String.raw`#!/usr/bin/env node
import readline from "node:readline";

let callCount = 0;
const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "package-smoke-fixture", version: "1.0.0" }
      }
    });
    return;
  }
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        tools: [
          {
            name: "marker",
            title: "Package marker",
            description: "Return the package smoke marker",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            },
            outputSchema: {
              type: "object",
              properties: { marker: { type: "string" } },
              required: ["marker"]
            },
            annotations: { readOnlyHint: true },
            "x-package-smoke": { preserved: true },
            "tool_ref": "untrusted-wire-value"
          },
          {
            name: "native_large",
            title: "Native large package result",
            description: "Return an eligible large plain-text result",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            },
            annotations: { readOnlyHint: true },
            _meta: { fixture: "native-package-smoke" }
          },
          {
            name: "native_structured",
            title: "Native structured package result",
            description: "Return a schema-bound structured result",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            },
            outputSchema: {
              type: "object",
              properties: {
                marker: { type: "string" },
                count: { type: "number" }
              },
              required: ["marker", "count"],
              additionalProperties: false
            }
          }
        ]
      }
    });
    return;
  }
  if (request.method === "tools/call") {
    callCount += 1;
    if (request.params?.name === "native_large") {
      const marker = "NATIVE_PACKAGE_LARGE:" + request.params?.arguments?.value + ":CALLS:" + callCount;
      const text = marker + "\n" + "native package payload\n".repeat(3000);
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text }]
        }
      });
      return;
    }
    if (request.params?.name === "native_structured") {
      const marker = "NATIVE_PACKAGE_STRUCTURED:" + request.params?.arguments?.value + ":CALLS:" + callCount;
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{ type: "text", text: marker }],
          structuredContent: { marker, count: callCount },
          _meta: { fixture: "native-package-smoke" },
          "x-native-package-smoke-result": { preserved: true }
        }
      });
      return;
    }
    const marker = "PACKAGE_SMOKE:" + request.params?.arguments?.value + ":CALLS:" + callCount;
    const text = marker + "\n" + "deterministic package payload\n".repeat(3000);
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text }],
        structuredContent: { marker },
        _meta: { fixture: "package-smoke" }
      }
    });
    return;
  }
  if (request.id !== undefined) {
    send({ jsonrpc: "2.0", id: request.id, result: {} });
  }
});
`;
}

function textJson(result) {
  const block = result.content?.[0];
  if (!block || block.type !== "text") throw new Error("Expected a JSON text block");
  return JSON.parse(block.text);
}

function verifyAuditTrace(auditFile, toolRef, resultRef) {
  const entries = fs
    .readFileSync(auditFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const callDelivery = entries.find(
    (entry) => entry.toolName === "call_tool" && entry.event === "projection" && entry.outcome === "projected",
  );
  if (!callDelivery?.traceId) {
    throw new Error("Audit log did not record the projected call_tool delivery trace");
  }

  const callStages = entries.filter((entry) => entry.traceId === callDelivery.traceId);
  for (const expected of [
    ["policy", "success"],
    ["upstream", "success"],
    ["projection", "projected"],
  ]) {
    if (!callStages.some((entry) => entry.event === expected[0] && entry.outcome === expected[1])) {
      throw new Error(`Audit trace is missing ${expected[0]}/${expected[1]}`);
    }
  }
  if (callStages.some((entry) => entry.action === "blocked")) {
    throw new Error("Successful package call was misclassified as blocked");
  }

  const recovery = entries.find(
    (entry) =>
      entry.toolName === "read_result" &&
      entry.event === "recovery" &&
      (entry.outcome === "chunk" || entry.outcome === "complete"),
  );
  if (!recovery?.traceId) {
    throw new Error("Audit log did not record the read_result recovery trace");
  }

  const lifecycleStates = entries.filter((entry) => entry.event === "lifecycle").map((entry) => entry.toolName);
  for (const expected of ["runtime/starting", "runtime/ready", "runtime/stopping", "runtime/stopped"]) {
    if (!lifecycleStates.includes(expected)) {
      throw new Error(`Audit log is missing lifecycle state ${expected}`);
    }
  }

  const serialized = JSON.stringify(entries);
  if (serialized.includes(toolRef) || serialized.includes(resultRef)) {
    throw new Error("Audit log retained a raw tool_ref or result_ref");
  }
  if (serialized.includes("PACKAGE_SMOKE:")) {
    throw new Error("Audit log retained result payload content");
  }

  return {
    events: entries.map((entry) => `${entry.event ?? "legacy"}/${entry.outcome ?? entry.action}`),
    call_trace_stages: callStages.map((entry) => `${entry.event}/${entry.outcome}`),
    recovery_outcome: recovery.outcome,
    lifecycle_states: lifecycleStates,
    raw_references_logged: false,
    result_payload_logged: false,
  };
}

function verifyNativeAuditTrace(stderr, resultRef) {
  const lines = stderr.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Installed native runtime did not emit default audit records to stderr");

  const entries = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Installed native runtime emitted non-JSON stderr: ${line}`);
    }
  });
  const projected = entries.find(
    (entry) =>
      entry.toolName === "fixture_native_large" && entry.event === "projection" && entry.outcome === "projected",
  );
  if (!projected?.traceId) {
    throw new Error("Native audit stream did not record the projected direct Tool call");
  }
  const projectedStages = entries
    .filter((entry) => entry.traceId === projected.traceId)
    .map((entry) => `${entry.event}/${entry.outcome}`);
  for (const expected of ["policy/success", "upstream/success", "projection/projected"]) {
    if (!projectedStages.includes(expected)) {
      throw new Error(`Native audit trace is missing ${expected}`);
    }
  }

  const structured = entries.find(
    (entry) =>
      entry.toolName === "fixture_native_structured" &&
      entry.event === "projection" &&
      entry.outcome === "pass_through",
  );
  if (!structured?.traceId) {
    throw new Error("Native audit stream did not record schema-bound pass-through");
  }
  if (
    !entries.some(
      (entry) =>
        entry.toolName === "read_result" &&
        entry.event === "recovery" &&
        (entry.outcome === "chunk" || entry.outcome === "complete"),
    )
  ) {
    throw new Error("Native audit stream did not record recovery");
  }

  const lifecycleStates = entries.filter((entry) => entry.event === "lifecycle").map((entry) => entry.toolName);
  for (const expected of ["runtime/starting", "runtime/ready", "runtime/stopping", "runtime/stopped"]) {
    if (!lifecycleStates.includes(expected)) {
      throw new Error(`Native audit stream is missing lifecycle state ${expected}`);
    }
  }

  const serialized = JSON.stringify(entries);
  for (const forbidden of [
    "NATIVE_PACKAGE_ARGUMENT_SECRET_74c63b",
    "NATIVE_PACKAGE_LARGE:",
    "NATIVE_PACKAGE_STRUCTURED:",
    resultRef,
  ]) {
    if (serialized.includes(forbidden)) {
      throw new Error(`Native audit stream retained forbidden call data: ${forbidden}`);
    }
  }

  return {
    stream: "stderr",
    records: entries.length,
    projected_trace_stages: projectedStages,
    structured_outcome: structured.outcome,
    recovery_recorded: true,
    lifecycle_states: lifecycleStates,
    arguments_logged: false,
    result_payload_logged: false,
    raw_result_reference_logged: false,
  };
}

let client;
try {
  const requestedTarball = process.argv[2];
  const tarball = requestedTarball ? path.resolve(requestedTarball) : createTarball();
  if (!fs.existsSync(tarball)) throw new Error(`Tarball not found: ${tarball}`);

  const installDirectory = path.join(temporaryRoot, "install");
  fs.mkdirSync(installDirectory);
  fs.writeFileSync(
    path.join(installDirectory, "package.json"),
    JSON.stringify({ name: "slim-guard-package-smoke", private: true }),
    "utf8",
  );
  runNpm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", tarball], {
    cwd: installDirectory,
  });

  const installedPackage = path.join(installDirectory, "node_modules", "mcp-slim-guard");
  const cli = path.join(installedPackage, "dist", "cli.js");
  if (!fs.existsSync(cli)) throw new Error("Installed tarball does not contain dist/cli.js");
  const sourceVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
  const installedVersion = JSON.parse(fs.readFileSync(path.join(installedPackage, "package.json"), "utf8")).version;
  if (installedVersion !== sourceVersion) {
    throw new Error(`Installed version ${installedVersion} does not match source ${sourceVersion}`);
  }
  const rootImportProbe = path.join(installDirectory, "root-import-probe.mjs");
  fs.writeFileSync(
    rootImportProbe,
    `import {
  AuditLogger,
  GuardProxy,
  PolicyPipeline,
  ServerManager,
  WhitelistPolicy
} from "mcp-slim-guard";
const config = {
  version: 1,
  tools: { allow: [], deny: [] },
  ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
  rate_limit: { default: "" },
  injection_detection: { enabled: false },
  compressor: { enabled: false, level: "off" },
  servers: {}
};
const proxy = new GuardProxy(
  config,
  new PolicyPipeline([new WhitelistPolicy(config.tools)]),
  new AuditLogger({ output: "stderr", level: "silent" }),
  new ServerManager({}),
  { surface: "native" }
);
process.stdout.write(JSON.stringify({
  constructed: proxy.constructor.name === "GuardProxy",
  exports: {
    AuditLogger: typeof AuditLogger,
    GuardProxy: typeof GuardProxy,
    PolicyPipeline: typeof PolicyPipeline,
    ServerManager: typeof ServerManager,
    WhitelistPolicy: typeof WhitelistPolicy
  }
}));
`,
    "utf8",
  );
  const rootImport = JSON.parse(run(process.execPath, [rootImportProbe], { cwd: installDirectory }).stdout);
  if (!rootImport.constructed || Object.values(rootImport.exports).some((type) => type !== "function")) {
    throw new Error("Installed package root cannot construct the documented native runtime");
  }

  const runtimeDirectory = path.join(temporaryRoot, "runtime");
  fs.mkdirSync(runtimeDirectory);
  const fixture = path.join(runtimeDirectory, "fixture.mjs");
  fs.writeFileSync(fixture, fixtureSource(), "utf8");
  fs.writeFileSync(
    path.join(runtimeDirectory, "mcp-slim-guard.yml"),
    `version: 1
tools:
  allow: ["fixture_*"]
  deny: []
ssrf:
  mode: "off"
  block_private_ips: false
  allow_domains: []
  block_domains: []
rate_limit:
  default: "1000/min"
injection_detection:
  enabled: false
compressor:
  enabled: true
  level: light
audit:
  output: file
  filePath: ${JSON.stringify(path.join(runtimeDirectory, "audit.log"))}
servers:
  fixture:
    command: ${JSON.stringify(process.execPath)}
    args:
      - ${JSON.stringify(fixture)}
    env: {}
`,
    "utf8",
  );

  client = new Client({ name: "slim-guard-package-smoke", version: "1.0.0" }, { capabilities: { tools: {} } });
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
  const expectedNames = ["call_tool", "find_tool", "read_result"];
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`Unexpected tool surface: ${names.join(", ")}`);
  }

  const found = await client.callTool({
    name: "find_tool",
    arguments: { query: "package marker" },
  });
  const match = textJson(found).matches?.find((candidate) => candidate.name === "fixture_marker");
  if (!match?.tool_ref) throw new Error("Installed package could not discover fixture_marker");
  if (match.tool_ref === "untrusted-wire-value") {
    throw new Error("Upstream metadata overrode the catalog-bound tool reference");
  }
  if (match.title !== "Package marker" || match.outputSchema?.type !== "object") {
    throw new Error("Catalog projection dropped standard MCP tool metadata");
  }
  if (match["x-package-smoke"]?.preserved !== true) {
    throw new Error("Catalog projection dropped unknown MCP tool metadata");
  }

  const called = await client.callTool({
    name: "call_tool",
    arguments: {
      tool_ref: match.tool_ref,
      arguments: { value: "alpha" },
    },
  });
  const marker = "PACKAGE_SMOKE:alpha:CALLS:1";
  if (!JSON.stringify(called).includes(marker)) {
    throw new Error("Installed package did not return the once-only fixture marker");
  }
  const capsule = textJson(called);
  if (!capsule.result_ref) {
    throw new Error("Installed package did not capture the large result");
  }
  const recovered = await client.callTool({
    name: "read_result",
    arguments: { result_ref: capsule.result_ref, cursor: 0 },
  });
  if (!JSON.stringify(recovered).includes(marker)) {
    throw new Error("Installed package could not recover the captured marker");
  }

  const codex = verifyCodexConfiguration(cli, runtimeDirectory);

  await client.close();
  client = undefined;
  const audit = verifyAuditTrace(path.join(runtimeDirectory, "audit.log"), match.tool_ref, capsule.result_ref);
  const shareRun = run(process.execPath, [cli, "profile", "--share", "--json"], { cwd: runtimeDirectory });
  const shareReport = JSON.parse(shareRun.stdout);
  if (
    shareReport.kind !== "mcp-slim-guard/share-report" ||
    shareReport.calls?.upstreamExecutions !== 1 ||
    shareReport.calls?.recoveryPageReads !== 1 ||
    shareReport.delivery?.projected !== 1 ||
    shareReport.recovery?.exactRecovery !== "verified"
  ) {
    throw new Error("Installed package did not produce the expected safe ShareReport");
  }
  for (const forbidden of ["fixture_marker", match.tool_ref, capsule.result_ref, runtimeDirectory]) {
    if (shareRun.stdout.includes(forbidden)) {
      throw new Error("Installed package ShareReport exposed non-allowlisted evidence");
    }
  }

  const nativeConsumerSource = path.join(repositoryRoot, "scripts", "integration", "package-native-consumer.mjs");
  const nativeConsumer = path.join(installDirectory, "package-native-consumer.mjs");
  fs.copyFileSync(nativeConsumerSource, nativeConsumer);
  const nativeRun = run(process.execPath, [nativeConsumer, fixture], { cwd: installDirectory });
  const nativeStdoutLines = nativeRun.stdout.split(/\r?\n/).filter(Boolean);
  if (nativeStdoutLines.length !== 1) {
    throw new Error(
      `Installed native runtime polluted stdout; expected one consumer result, got ${nativeStdoutLines.length}`,
    );
  }
  if (nativeRun.stdout.includes('"event":"policy"') || nativeRun.stdout.includes('"event":"lifecycle"')) {
    throw new Error("Installed native runtime wrote audit records to stdout");
  }
  const native = JSON.parse(nativeStdoutLines[0]);
  const nativeResultRef = native._result_ref;
  if (typeof nativeResultRef !== "string") {
    throw new Error("Installed native consumer did not expose its recovery reference to the smoke harness");
  }
  delete native._result_ref;
  native.stdout = {
    consumer_records: nativeStdoutLines.length,
    audit_records: 0,
    clean: true,
  };
  native.audit = verifyNativeAuditTrace(nativeRun.stderr, nativeResultRef);

  runNpm(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "mcp-slim-guard"], {
    cwd: installDirectory,
  });
  if (fs.existsSync(installedPackage)) throw new Error("npm uninstall left the package installed");

  console.log(
    JSON.stringify({
      version: installedVersion,
      tarball: path.basename(tarball),
      sha256: createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
      installed: true,
      root_import: rootImport,
      transport: "stdio",
      tools: names,
      flow: ["find_tool", "call_tool", "read_result"],
      marker,
      projection: capsule.projection,
      upstream_calls: 1,
      audit,
      share_report: shareReport,
      native,
      codex,
      uninstalled: true,
      passed: true,
    }),
  );
} finally {
  await client?.close().catch(() => {});
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
