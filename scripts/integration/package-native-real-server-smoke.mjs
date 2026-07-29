#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FILESYSTEM_VERSION = "2026.7.10";
const EVERYTHING_VERSION = "2026.7.4";
const RUNTIME_CONFIG_ENV = "SLIM_GUARD_NATIVE_REAL_SERVER_CONFIG";
const RUNTIME_MODE = "--native-runtime";
const EXPECTED_TOOL_NAMES = ["echo", "get-structured-content", "read_result", "read_text_file"];
const SAFE_NPM_ENVIRONMENT_KEYS =
  process.platform === "win32"
    ? [
        "APPDATA",
        "COMSPEC",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMFILES",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERNAME",
        "USERPROFILE",
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    timeout: options.timeout ?? 120_000,
    windowsHide: true,
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
  const npmCli = process.env.npm_execpath;
  if (npmCli?.endsWith(".js")) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  return run("npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function sha256File(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

function credentialFreeNpmEnvironment(userConfig) {
  const environment = {};
  for (const key of SAFE_NPM_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.npm_config_engine_strict = "true";
  environment.npm_config_userconfig = userConfig;
  return environment;
}

function safeRuntimeEnvironment(getDefaultEnvironment, config) {
  const environment = {
    ...getDefaultEnvironment(),
    [RUNTIME_CONFIG_ENV]: JSON.stringify(config),
  };
  const credentialKeys = Object.keys(environment).filter((key) =>
    /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTHORIZATION)/iu.test(key),
  );
  assert.deepEqual(
    credentialKeys,
    [],
    `Runtime environment contains credential-like keys: ${credentialKeys.join(", ")}`,
  );
  return environment;
}

function parseAuditEntries(stderr) {
  const entries = [];
  for (const line of stderr.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.event === "string") {
        entries.push(parsed);
      }
    } catch {
      // Credential-free reference servers write startup diagnostics to stderr.
    }
  }
  return entries;
}

function assertOneUpstreamCall(entries, toolName) {
  const upstream = entries.filter(
    (entry) => entry.toolName === toolName && entry.event === "upstream" && entry.outcome === "success",
  );
  assert.equal(upstream.length, 1, `${toolName} did not record exactly one successful upstream invocation`);
}

function assertProjectionOutcome(entries, toolName, outcome) {
  assert.equal(
    entries.some((entry) => entry.toolName === toolName && entry.event === "projection" && entry.outcome === outcome),
    true,
    `${toolName} did not record projection/${outcome}`,
  );
}

async function recoverText(client, delivered) {
  const resultRef = delivered.structuredContent?.result_ref;
  assert.equal(typeof resultRef, "string", "Eligible Everything text did not return a result_ref");

  let cursor = 0;
  let recovered = "";
  for (let pageCount = 1; pageCount <= 100; pageCount += 1) {
    const page = await client.callTool({
      name: "read_result",
      arguments: { result_ref: resultRef, cursor },
    });
    const block = page.content?.[0];
    assert.equal(block?.type, "text", "read_result did not return a text chunk");
    recovered += block.text;

    if (page.structuredContent?.done === true) {
      return { pages: pageCount, recovered, resultRef };
    }
    assert.equal(typeof page.structuredContent?.next_cursor, "number", "read_result omitted its next cursor");
    cursor = page.structuredContent.next_cursor;
  }
  throw new Error("read_result exceeded the bounded smoke pagination limit");
}

async function runInstalledNativeRuntime() {
  const rawConfig = process.env[RUNTIME_CONFIG_ENV];
  if (!rawConfig) throw new Error(`Missing ${RUNTIME_CONFIG_ENV}`);

  const config = JSON.parse(rawConfig);
  assert.deepEqual(Object.keys(config.servers).sort(), ["everything", "filesystem"]);

  const { AuditLogger, GuardProxy, PolicyPipeline, ServerManager, WhitelistPolicy } = await import("mcp-slim-guard");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const proxy = new GuardProxy(
    config,
    new PolicyPipeline([new WhitelistPolicy(config.tools)]),
    new AuditLogger(),
    new ServerManager(config.servers),
    { surface: "native" },
  );

  let stopping;
  const stop = () => {
    stopping ??= proxy.stop().catch(() => {});
    return stopping;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.stdin.once("end", () => void stop());

  await proxy.start(new StdioServerTransport());
}

async function runSmoke() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline") || /^(?:1|true)$/iu.test(process.env.npm_config_offline ?? "");
  const positional = args.filter((argument) => !argument.startsWith("--"));
  if (positional.length !== 1) {
    throw new Error("Usage: node package-native-real-server-smoke.mjs <exact-candidate.tgz> [--offline]");
  }

  const tarball = path.resolve(positional[0]);
  if (!fs.existsSync(tarball)) throw new Error(`Candidate tarball not found: ${tarball}`);
  assert.equal(
    Number(process.versions.node.split(".")[0]) >= 20,
    true,
    `The installed-package smoke requires Node.js 20 or newer, received ${process.version}`,
  );

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-native-real-package-"));
  let client;
  let report;
  let transport;
  try {
    fs.writeFileSync(
      path.join(temporaryRoot, "package.json"),
      `${JSON.stringify({ name: "slim-guard-native-real-package-smoke", private: true }, null, 2)}\n`,
      "utf8",
    );
    const emptyNpmConfig = path.join(temporaryRoot, ".npmrc");
    fs.writeFileSync(emptyNpmConfig, "", "utf8");

    const installArguments = [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      ...(offline ? ["--offline"] : []),
      tarball,
      `@modelcontextprotocol/server-filesystem@${FILESYSTEM_VERSION}`,
      `@modelcontextprotocol/server-everything@${EVERYTHING_VERSION}`,
    ];
    runNpm(installArguments, {
      cwd: temporaryRoot,
      env: credentialFreeNpmEnvironment(emptyNpmConfig),
    });

    const nodeModules = path.join(temporaryRoot, "node_modules");
    const installedPackage = path.join(nodeModules, "mcp-slim-guard");
    const filesystemPackage = path.join(nodeModules, "@modelcontextprotocol", "server-filesystem");
    const everythingPackage = path.join(nodeModules, "@modelcontextprotocol", "server-everything");
    const sdkPackage = path.join(nodeModules, "@modelcontextprotocol", "sdk");

    const installedPackageJson = readJson(path.join(installedPackage, "package.json"));
    const filesystemPackageJson = readJson(path.join(filesystemPackage, "package.json"));
    const everythingPackageJson = readJson(path.join(everythingPackage, "package.json"));
    const sdkPackageJson = readJson(path.join(sdkPackage, "package.json"));
    assert.equal(filesystemPackageJson.version, FILESYSTEM_VERSION);
    assert.equal(everythingPackageJson.version, EVERYTHING_VERSION);

    const filesystemEntry = path.join(filesystemPackage, "dist", "index.js");
    const everythingEntry = path.join(everythingPackage, "dist", "index.js");
    assert.equal(fs.existsSync(filesystemEntry), true, "Filesystem package entry is missing");
    assert.equal(fs.existsSync(everythingEntry), true, "Everything package entry is missing");

    const runtimeEntry = path.join(temporaryRoot, "package-native-real-server-runtime.mjs");
    fs.copyFileSync(fileURLToPath(import.meta.url), runtimeEntry);

    const fixtureDirectory = path.join(temporaryRoot, "fixture");
    fs.mkdirSync(fixtureDirectory);
    const fixturePath = path.join(fixtureDirectory, "large-result.txt");
    const payloadMarker = "NATIVE_REAL_SERVER_PAYLOAD_39f64b";
    const largePayload = [
      `${payloadMarker}:BEGIN`,
      ...Array.from({ length: 1_200 }, (_, index) => `fixture-${String(index).padStart(4, "0")}|${"x".repeat(64)}`),
      `${payloadMarker}:END`,
    ].join("\n");
    fs.writeFileSync(fixturePath, largePayload, "utf8");

    const config = {
      version: 1,
      tools: {
        allow: ["filesystem_read_text_file", "everything_echo", "everything_get-structured-content"],
        deny: [],
      },
      ssrf: {
        mode: "off",
        block_private_ips: false,
        allow_domains: [],
        block_domains: [],
      },
      rate_limit: { default: "1000/min" },
      injection_detection: { enabled: false },
      compressor: { enabled: true, level: "light" },
      servers: {
        filesystem: {
          command: process.execPath,
          args: [filesystemEntry, fixtureDirectory],
          env: {},
        },
        everything: {
          command: process.execPath,
          args: [everythingEntry],
          env: {},
        },
      },
    };

    const sdkRoot = path.join(sdkPackage, "dist", "esm");
    const { Client } = await import(pathToFileURL(path.join(sdkRoot, "client", "index.js")));
    const { StdioClientTransport, getDefaultEnvironment } = await import(
      pathToFileURL(path.join(sdkRoot, "client", "stdio.js"))
    );

    client = new Client(
      { name: "installed-native-real-server-smoke", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [runtimeEntry, RUNTIME_MODE],
      cwd: temporaryRoot,
      env: safeRuntimeEnvironment(getDefaultEnvironment, config),
      stderr: "pipe",
    });

    let stderr = "";
    let finishStderr;
    const stderrFinished = new Promise((resolve) => {
      finishStderr = resolve;
    });
    transport.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    transport.stderr?.once("end", finishStderr);
    transport.stderr?.once("close", finishStderr);

    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map(({ name }) => name).sort();
    assert.deepEqual(toolNames, EXPECTED_TOOL_NAMES);

    const filesystemDefinition = listed.tools.find(({ name }) => name === "read_text_file");
    const echoDefinition = listed.tools.find(({ name }) => name === "echo");
    const structuredDefinition = listed.tools.find(({ name }) => name === "get-structured-content");
    assert.equal(filesystemDefinition?.outputSchema?.type, "object");
    assert.equal(echoDefinition?.outputSchema, undefined);
    assert.equal(structuredDefinition?.outputSchema?.type, "object");

    const filesystem = await client.callTool({
      name: "read_text_file",
      arguments: { path: fixturePath },
    });
    assert.equal(filesystem.content?.[0]?.type, "text");
    assert.equal(filesystem.content[0].text, largePayload, "Filesystem text content changed");
    assert.equal(filesystem.structuredContent?.content, largePayload, "Filesystem structuredContent changed");
    assert.equal(filesystem.structuredContent?.result_ref, undefined, "Schema-bound Filesystem result was projected");

    const expectedEcho = `Echo: ${largePayload}`;
    const echo = await client.callTool({
      name: "echo",
      arguments: { message: largePayload },
    });
    const recovery = await recoverText(client, echo);
    assert.equal(recovery.recovered, expectedEcho, "Everything echo recovery was not exact");

    const expectedStructured = {
      temperature: 36,
      conditions: "Light rain / drizzle",
      humidity: 82,
    };
    const structured = await client.callTool({
      name: "get-structured-content",
      arguments: { location: "Chicago" },
    });
    assert.deepEqual(structured.structuredContent, expectedStructured);
    assert.equal(structured.structuredContent?.result_ref, undefined, "Structured Everything result was projected");

    await client.close();
    client = undefined;
    await Promise.race([
      stderrFinished,
      new Promise((resolve) => {
        setTimeout(resolve, 1_000);
      }),
    ]);

    assert.equal(stderr.includes(payloadMarker), false, "stderr retained the invocation or result payload");
    assert.equal(stderr.includes(recovery.resultRef), false, "stderr retained the raw result_ref");

    const auditEntries = parseAuditEntries(stderr);
    assertOneUpstreamCall(auditEntries, "filesystem_read_text_file");
    assertOneUpstreamCall(auditEntries, "everything_echo");
    assertOneUpstreamCall(auditEntries, "everything_get-structured-content");
    assertProjectionOutcome(auditEntries, "filesystem_read_text_file", "pass_through");
    assertProjectionOutcome(auditEntries, "everything_echo", "projected");
    assertProjectionOutcome(auditEntries, "everything_get-structured-content", "pass_through");
    assert.equal(
      auditEntries.some((entry) => entry.toolName === "read_result" && entry.event === "upstream"),
      false,
      "read_result re-executed an upstream Tool",
    );

    const callAuditEntries = auditEntries.filter((entry) =>
      ["filesystem_read_text_file", "everything_echo", "everything_get-structured-content"].includes(entry.toolName),
    );
    assert.equal(
      callAuditEntries.every((entry) => Object.keys(entry.arguments ?? {}).length === 0),
      true,
      "Audit entries retained invocation arguments",
    );

    report = {
      passed: true,
      candidate: {
        filename: path.basename(tarball),
        sha256: sha256File(tarball),
        version: installedPackageJson.version,
      },
      runtime: {
        node: process.version,
        node_exec: process.execPath,
        sdk: sdkPackageJson.version,
        chain: "SDK Client stdio -> installed native Slim Guard stdio -> real MCP Servers stdio",
      },
      servers: {
        filesystem: FILESYSTEM_VERSION,
        everything: EVERYTHING_VERSION,
        github_included: false,
      },
      tools: toolNames,
      filesystem: {
        upstream_calls: 1,
        output_schema_preserved: true,
        structured_content_preserved: true,
        large_result_passed_through_exactly: true,
        bytes: Buffer.byteLength(largePayload),
      },
      everything_echo: {
        upstream_calls: 1,
        projected: true,
        recovery_upstream_calls: 0,
        recovered_exactly: true,
        recovery_pages: recovery.pages,
        recovered_sha256: createHash("sha256").update(recovery.recovered).digest("hex"),
      },
      everything_structured: {
        upstream_calls: 1,
        output_schema_preserved: true,
        structured_content_preserved: true,
        passed_through: true,
      },
      audit: {
        stream: "stderr",
        records: auditEntries.length,
        arguments_logged: false,
        result_payload_logged: false,
        raw_result_reference_logged: false,
      },
      install: {
        offline,
        credentials_used: false,
        credential_environment_inherited: false,
      },
    };
  } finally {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }

  report.install.temporary_consumer_removed = !fs.existsSync(temporaryRoot);
  console.log(JSON.stringify(report));
}

if (process.argv.includes(RUNTIME_MODE)) {
  await runInstalledNativeRuntime();
} else {
  await runSmoke();
}
