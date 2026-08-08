import * as fs from "node:fs";
import * as path from "node:path";
import type { GuardMode } from "./modes.js";

export interface CodexConfigPlan {
  schemaVersion: 1;
  kind: "mcp-slim-guard/config-plan";
  mode: "dry-run";
  host: "codex";
  support: "supported";
  target: {
    scope: "project";
    path: string;
    exists: boolean;
    slimGuardEntry: "present" | "absent";
  };
  server: {
    name: "slim_guard";
    transport: "stdio";
    mode: GuardMode;
    command: "mcp-slim-guard";
    args: ["start", "--mode", GuardMode];
    cwd: string;
  };
  proposedChange: { operation: "upsert"; toml: string };
  preconditions: { guardConfigPath: string; guardConfigExists: boolean };
  verification: { command: ["codex", "mcp", "list"] };
  writesPerformed: 0;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfigPlan(projectRoot: string, mode: GuardMode = "native"): CodexConfigPlan {
  const cwd = path.resolve(projectRoot);
  const targetPath = path.join(cwd, ".codex", "config.toml");
  const guardConfigPath = path.join(cwd, "mcp-slim-guard.yml");
  const exists = fs.existsSync(targetPath);
  const current = exists ? fs.readFileSync(targetPath, "utf8") : "";
  const slimGuardEntry = /^\s*\[mcp_servers\.slim_guard\]\s*$/mu.test(current) ? "present" : "absent";
  const args: ["start", "--mode", GuardMode] = ["start", "--mode", mode];
  const toml = [
    "[mcp_servers.slim_guard]",
    'command = "mcp-slim-guard"',
    `args = ${JSON.stringify(args)}`,
    `cwd = ${tomlString(cwd)}`,
  ].join("\n");

  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/config-plan",
    mode: "dry-run",
    host: "codex",
    support: "supported",
    target: { scope: "project", path: targetPath, exists, slimGuardEntry },
    server: { name: "slim_guard", transport: "stdio", mode, command: "mcp-slim-guard", args, cwd },
    proposedChange: { operation: "upsert", toml },
    preconditions: { guardConfigPath, guardConfigExists: fs.existsSync(guardConfigPath) },
    verification: { command: ["codex", "mcp", "list"] },
    writesPerformed: 0,
  };
}
