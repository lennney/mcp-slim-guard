#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertThreeToolSurface,
  describeResult,
  parseJsonTextBlock,
  recoverCapturedResult,
} from "./real-server-smoke-core.mjs";

const FILESYSTEM_VERSION = "2026.7.10";
const EVERYTHING_VERSION = "2026.7.4";
const GITHUB_VERSION = "1.7.0";
const GITHUB_COMMIT = "eb088dfe9d854dab6453a8d4ae5871a5ced20974";
const GITHUB_WINDOWS_ZIP_SHA256 = "14882ca059cd2eccc037388d586b552b60a891b126050f8cefff8beab3c9157f";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const slimGuardCli = path.join(repositoryRoot, "dist", "cli.js");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-real-servers-"));
const fixturePath = path.join(temporaryDirectory, "large-result.txt");

function readPackageJson(packagePath) {
  return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 30_000,
    env: options.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}`);
  }
  return result.stdout.trim();
}

function githubToken() {
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    return { value: process.env.GITHUB_PERSONAL_ACCESS_TOKEN, source: "environment" };
  }
  const value = commandOutput("gh", ["auth", "token"]);
  if (!value) throw new Error("GitHub authentication is required; run gh auth login first");
  return { value, source: "gh-keyring" };
}

function githubBinary() {
  const value = process.env.GITHUB_MCP_SERVER_BIN;
  if (!value) {
    throw new Error(
      "Set GITHUB_MCP_SERVER_BIN to the verified GitHub MCP Server 1.7.0 executable before running this smoke",
    );
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`GitHub MCP Server binary not found: ${resolved}`);
  const versionOutput = commandOutput(resolved, ["--version"]);
  if (!versionOutput.includes(`Version: ${GITHUB_VERSION}`) || !versionOutput.includes(`Commit: ${GITHUB_COMMIT}`)) {
    throw new Error(`Unexpected GitHub MCP Server build: ${versionOutput.replaceAll(/\s+/gu, " ")}`);
  }
  return resolved;
}

function createFixture() {
  const lines = ["REAL_MCP_FILESYSTEM:BEGIN"];
  for (let index = 0; index < 900; index += 1) {
    const marker = index === 450 ? " REAL_MCP_FILESYSTEM:MIDDLE" : "";
    lines.push(
      `fixture line ${String(index).padStart(4, "0")} | deterministic MCP payload | 中文内容 | ${"x".repeat(48)}${marker}`,
    );
  }
  lines.push("REAL_MCP_FILESYSTEM:END");
  const value = lines.join("\n");
  fs.writeFileSync(fixturePath, value, "utf8");
  return value;
}

function writeConfig(binaryPath) {
  const config = {
    version: 2,
    tools: {
      allow: ["github_get_file_contents", "filesystem_read_text_file", "everything_get-structured-content"],
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
    audit: {
      output: "file",
      filePath: path.join(temporaryDirectory, "audit.log"),
    },
    servers: {
      github: {
        command: binaryPath,
        args: ["stdio", "--read-only", "--tools", "get_file_contents"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}",
        },
      },
      filesystem: {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          "npx",
          "-y",
          `@modelcontextprotocol/server-filesystem@${FILESYSTEM_VERSION}`,
          temporaryDirectory,
        ],
        env: {},
      },
      everything: {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "npx", "-y", `@modelcontextprotocol/server-everything@${EVERYTHING_VERSION}`],
        env: {},
      },
    },
  };
  fs.writeFileSync(path.join(temporaryDirectory, "mcp-slim-guard.yml"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function findTool(client, name, query) {
  const found = await client.callTool({
    name: "find_tool",
    arguments: { query },
  });
  const match = parseJsonTextBlock(found).matches?.find((candidate) => candidate.name === name);
  if (!match?.tool_ref) throw new Error(`Slim Guard could not discover ${name}`);
  return match;
}

async function callTool(client, name, query, args) {
  const match = await findTool(client, name, query);
  const delivered = await client.callTool({
    name: "call_tool",
    arguments: {
      tool_ref: match.tool_ref,
      arguments: args,
    },
  });
  const recovered = await recoverCapturedResult(client, delivered);
  return { match, delivered, recovered };
}

function sourceTree() {
  const commit = commandOutput("git", ["rev-parse", "HEAD"]);
  const status = commandOutput("git", ["status", "--porcelain"]);
  return {
    git_commit: commit,
    dirty: status.length > 0,
    smoke_script_sha256: createHash("sha256")
      .update(fs.readFileSync(fileURLToPath(import.meta.url)))
      .digest("hex"),
  };
}

const packageJson = readPackageJson(path.join(repositoryRoot, "package.json"));
const sdkPackageJson = readPackageJson(
  path.join(repositoryRoot, "node_modules", "@modelcontextprotocol", "sdk", "package.json"),
);
const token = githubToken();
const binaryPath = githubBinary();
const filesystemFixture = createFixture();
writeConfig(binaryPath);

let client;
try {
  client = new Client({ name: "slim-guard-real-server-smoke", version: "1.0.0" }, { capabilities: { tools: {} } });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [slimGuardCli, "start"],
      cwd: temporaryDirectory,
      env: {
        ...getDefaultEnvironment(),
        GITHUB_PERSONAL_ACCESS_TOKEN: token.value,
      },
      stderr: "pipe",
    }),
  );

  const toolSurface = assertThreeToolSurface(await client.listTools());

  const github = await callTool(client, "github_get_file_contents", "read a file from a GitHub repository", {
    owner: "github",
    repo: "github-mcp-server",
    path: "README.md",
  });
  const githubJson = JSON.stringify(github.recovered.result);
  if (!githubJson.includes("GitHub MCP Server")) throw new Error("GitHub result marker was not recovered");
  const githubShape = describeResult(github.recovered.result);
  if (!githubShape.content_types.includes("resource")) {
    throw new Error(`GitHub result did not preserve its resource block: ${githubShape.content_types.join(", ")}`);
  }

  const filesystem = await callTool(client, "filesystem_read_text_file", "read a large local text file", {
    path: fixturePath,
  });
  const filesystemText = filesystem.recovered.result.content?.[0]?.text;
  if (filesystemText !== filesystemFixture) throw new Error("Filesystem result did not recover exactly");
  if (!filesystem.recovered.compressed) throw new Error("Filesystem result did not exercise capsule recovery");

  const everything = await callTool(client, "everything_get-structured-content", "return structured weather content", {
    location: "Chicago",
  });
  const expectedWeather = {
    temperature: 36,
    conditions: "Light rain / drizzle",
    humidity: 82,
  };
  if (JSON.stringify(everything.recovered.result.structuredContent) !== JSON.stringify(expectedWeather)) {
    throw new Error("Everything server structuredContent did not pass through");
  }
  if (everything.recovered.compressed) throw new Error("Small structured result should pass through without a capsule");

  const capture = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    passed: true,
    source_tree: sourceTree(),
    host: {
      client: "@modelcontextprotocol/sdk Client",
      client_version: sdkPackageJson.version,
      chain: "TypeScript SDK client -> Slim Guard stdio -> upstream MCP server",
      slim_guard_version: packageJson.version,
      slim_guard_ingress: "stdio",
      advertised_tools: toolSurface,
    },
    totals: {
      real_mcp_servers: 3,
      upstream_tool_calls: 3,
      successful_tool_calls: 3,
    },
    servers: [
      {
        id: "github",
        server: "GitHub MCP Server",
        version: GITHUB_VERSION,
        commit: GITHUB_COMMIT,
        type: "API-backed repository server",
        transport: "stdio",
        mode: "read-only; get_file_contents only",
        tool: "get_file_contents",
        fixture: "github/github-mcp-server README.md at the default branch",
        initial_result_shape: describeResult(github.delivered),
        recovered_result_shape: githubShape,
        delivery: {
          compressed: github.recovered.compressed,
          encoding: github.recovered.encoding,
          content_kind: github.recovered.content_kind,
          projection: github.recovered.projection,
          read_result_calls: github.recovered.read_result_calls,
          snapshot_sha256: github.recovered.snapshot_sha256,
          marker_recovered: true,
          resource_block_preserved: true,
        },
        upstream_calls: 1,
      },
      {
        id: "filesystem",
        server: "@modelcontextprotocol/server-filesystem",
        version: FILESYSTEM_VERSION,
        type: "sandboxed local filesystem server",
        transport: "stdio",
        mode: "one temporary allowed directory",
        tool: "read_text_file",
        fixture: "generated UTF-8 text with beginning, middle, and ending markers",
        initial_result_shape: describeResult(filesystem.delivered),
        recovered_result_shape: describeResult(filesystem.recovered.result),
        delivery: {
          compressed: filesystem.recovered.compressed,
          encoding: filesystem.recovered.encoding,
          content_kind: filesystem.recovered.content_kind,
          projection: filesystem.recovered.projection,
          read_result_calls: filesystem.recovered.read_result_calls,
          snapshot_sha256: filesystem.recovered.snapshot_sha256,
          exact_text_recovery: true,
          all_three_markers_recovered: true,
        },
        upstream_calls: 1,
      },
      {
        id: "everything",
        server: "@modelcontextprotocol/server-everything",
        version: EVERYTHING_VERSION,
        type: "MCP protocol reference and conformance server",
        transport: "stdio",
        mode: "standard package defaults",
        tool: "get-structured-content",
        fixture: "built-in Chicago weather payload",
        catalog_metadata: {
          output_schema_preserved: everything.match.outputSchema?.type === "object",
        },
        initial_result_shape: describeResult(everything.delivered),
        recovered_result_shape: describeResult(everything.recovered.result),
        delivery: {
          compressed: everything.recovered.compressed,
          pass_through: true,
          structured_content_preserved: true,
          snapshot_sha256: everything.recovered.snapshot_sha256,
        },
        upstream_calls: 1,
      },
    ],
    integrity: {
      github_release_asset: "github-mcp-server_Windows_x86_64.zip",
      github_release_asset_sha256: GITHUB_WINDOWS_ZIP_SHA256,
      github_auth_source: token.source,
      credential_recorded: false,
      temporary_state_removed: true,
    },
    limitations: [
      "One Windows machine and one TypeScript SDK host were exercised.",
      "The GitHub fixture reads the default branch, so its content can change between runs.",
      "This proves MCP discovery, invocation, projection, and recovery; it does not measure model tool selection.",
      "The three calls are compatibility evidence, not a universal latency or token-savings benchmark.",
    ],
  };

  console.log(JSON.stringify(capture, null, 2));
} finally {
  await client?.close().catch(() => {});
  fs.rmSync(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
