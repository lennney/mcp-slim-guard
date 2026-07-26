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
        tools: [{
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
        }]
      }
    });
    return;
  }
  if (request.method === "tools/call") {
    callCount += 1;
    const marker = "PACKAGE_SMOKE:" + request.params?.arguments?.value + ":CALLS:" + callCount;
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{ type: "text", text: marker }],
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

  await client.close();
  client = undefined;
  runNpm(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "mcp-slim-guard"], {
    cwd: installDirectory,
  });
  if (fs.existsSync(installedPackage)) throw new Error("npm uninstall left the package installed");

  console.log(
    JSON.stringify({
      tarball: path.basename(tarball),
      sha256: createHash("sha256").update(fs.readFileSync(tarball)).digest("hex"),
      installed: true,
      transport: "stdio",
      tools: names,
      flow: ["find_tool", "call_tool"],
      marker,
      upstream_calls: 1,
      uninstalled: true,
      passed: true,
    }),
  );
} finally {
  await client?.close().catch(() => {});
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
