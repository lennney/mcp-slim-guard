import * as fs from "node:fs";
import * as path from "node:path";

export interface ClaudeConfigPlan {
  schemaVersion: 1;
  kind: "mcp-slim-guard/config-plan";
  mode: "dry-run";
  host: "claude-code";
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
    surface: "generic";
    command: "mcp-slim-guard";
    args: ["start"];
  };
  proposedChange: {
    operation: "replace-mcp-servers";
    json: string;
    displacedServerNames: string[];
  };
  preconditions: {
    guardConfigPath: string;
    guardConfigExists: boolean;
  };
  verification: {
    command: ["claude", "mcp", "list"];
  };
  writesPerformed: 0;
}

interface ClaudeProjectConfig {
  mcpServers?: Record<string, unknown>;
}

export function buildClaudeConfigPlan(projectRoot: string): ClaudeConfigPlan {
  const cwd = path.resolve(projectRoot);
  const targetPath = path.join(cwd, ".mcp.json");
  const guardConfigPath = path.join(cwd, "mcp-slim-guard.yml");
  const exists = fs.existsSync(targetPath);
  let currentServers: Record<string, unknown> = {};

  if (exists) {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8")) as ClaudeProjectConfig;
    if (parsed.mcpServers !== undefined && (typeof parsed.mcpServers !== "object" || parsed.mcpServers === null)) {
      throw new Error('Invalid Claude Code MCP config: "mcpServers" must be an object');
    }
    currentServers = parsed.mcpServers ?? {};
  }

  const proposedConfig = {
    mcpServers: {
      slim_guard: {
        type: "stdio",
        command: "mcp-slim-guard",
        args: ["start"],
      },
    },
  };

  return {
    schemaVersion: 1,
    kind: "mcp-slim-guard/config-plan",
    mode: "dry-run",
    host: "claude-code",
    support: "supported",
    target: {
      scope: "project",
      path: targetPath,
      exists,
      slimGuardEntry: Object.hasOwn(currentServers, "slim_guard") ? "present" : "absent",
    },
    server: {
      name: "slim_guard",
      transport: "stdio",
      surface: "generic",
      command: "mcp-slim-guard",
      args: ["start"],
    },
    proposedChange: {
      operation: "replace-mcp-servers",
      json: JSON.stringify(proposedConfig, null, 2),
      displacedServerNames: Object.keys(currentServers)
        .filter((name) => name !== "slim_guard")
        .sort(),
    },
    preconditions: {
      guardConfigPath,
      guardConfigExists: fs.existsSync(guardConfigPath),
    },
    verification: {
      command: ["claude", "mcp", "list"],
    },
    writesPerformed: 0,
  };
}
