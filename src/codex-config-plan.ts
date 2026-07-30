import * as fs from "node:fs";
import * as path from "node:path";

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
    surface: "native";
    command: "mcp-slim-guard";
    args: ["start", "--surface", "native"];
    cwd: string;
  };
  proposedChange: {
    operation: "upsert";
    toml: string;
  };
  verification: {
    command: ["codex", "mcp", "list"];
  };
  writesPerformed: 0;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function buildCodexConfigPlan(projectRoot: string): CodexConfigPlan {
  const cwd = path.resolve(projectRoot);
  const targetPath = path.join(cwd, ".codex", "config.toml");
  const exists = fs.existsSync(targetPath);
  const current = exists ? fs.readFileSync(targetPath, "utf8") : "";
  const slimGuardEntry = /^\s*\[mcp_servers\.slim_guard\]\s*$/mu.test(current) ? "present" : "absent";
  const toml = [
    "[mcp_servers.slim_guard]",
    'command = "mcp-slim-guard"',
    'args = ["start", "--surface", "native"]',
    `cwd = ${tomlString(cwd)}`,
  ].join("\n");

  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/config-plan",
    mode: "dry-run",
    host: "codex",
    support: "supported",
    target: {
      scope: "project",
      path: targetPath,
      exists,
      slimGuardEntry,
    },
    server: {
      name: "slim_guard",
      transport: "stdio",
      surface: "native",
      command: "mcp-slim-guard",
      args: ["start", "--surface", "native"],
      cwd,
    },
    proposedChange: {
      operation: "upsert",
      toml,
    },
    verification: {
      command: ["codex", "mcp", "list"],
    },
    writesPerformed: 0,
  };
}
