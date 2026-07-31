import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeConfigPlan } from "../../src/claude-config-plan.js";

describe("buildClaudeConfigPlan", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replaces direct project servers with the verified generic Slim Guard surface", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-claude-plan-"));
    temporaryDirectories.push(projectRoot);
    fs.writeFileSync(
      path.join(projectRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: { command: "github-mcp", env: { TOKEN: "do-not-report" } },
          filesystem: { command: "filesystem-mcp" },
        },
      }),
    );

    const plan = buildClaudeConfigPlan(projectRoot);

    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "mcp-slim-guard/config-plan",
      mode: "dry-run",
      host: "claude-code",
      support: "supported",
      target: {
        scope: "project",
        exists: true,
        slimGuardEntry: "absent",
      },
      server: {
        surface: "generic",
        command: "mcp-slim-guard",
        args: ["start"],
      },
      proposedChange: {
        operation: "replace-mcp-servers",
        displacedServerNames: ["filesystem", "github"],
      },
      verification: {
        command: ["claude", "mcp", "list"],
      },
      writesPerformed: 0,
    });
    expect(JSON.stringify(plan)).not.toContain("do-not-report");
    expect(JSON.parse(plan.proposedChange.json)).toEqual({
      mcpServers: {
        slim_guard: {
          type: "stdio",
          command: "mcp-slim-guard",
          args: ["start"],
        },
      },
    });
  });

  it("reports whether the generated Guard configuration exists", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-claude-plan-"));
    temporaryDirectories.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "mcp-slim-guard.yml"), "version: 1\n");

    const plan = buildClaudeConfigPlan(projectRoot);

    expect(plan.preconditions).toEqual({
      guardConfigPath: path.join(projectRoot, "mcp-slim-guard.yml"),
      guardConfigExists: true,
    });
    expect(fs.existsSync(path.join(projectRoot, ".mcp.json"))).toBe(false);
  });
});
