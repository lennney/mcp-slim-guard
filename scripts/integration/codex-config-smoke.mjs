#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-codex-config-"));
const cli = path.join(repositoryRoot, "dist", "cli.js");
const cwd = path.join(repositoryRoot, "scripts", "integration");

const codexEntry = path.join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
try {
  const result = spawnSync(
    process.execPath,
    [
      codexEntry,
      "mcp",
      "list",
      "-c",
      `mcp_servers.slim_guard.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.slim_guard.args=${JSON.stringify([cli, "start", "--mode", "native"])}`,
      "-c",
      `mcp_servers.slim_guard.cwd=${JSON.stringify(cwd)}`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `codex mcp list exited ${result.status}`);
  if (!result.stdout.includes("slim_guard")) throw new Error("Codex did not load slim_guard");
  if (!result.stdout.includes("--mode native")) {
    throw new Error("Codex did not retain the explicit native surface selection");
  }
  console.log(
    JSON.stringify({
      host: "Codex CLI",
      mode: "ephemeral CLI configuration parse",
      configured_server: "slim_guard",
      selected_mode: "native",
      passed: true,
    }),
  );
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
