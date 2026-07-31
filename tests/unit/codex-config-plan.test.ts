import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexConfigPlan } from "../../src/codex-config-plan.js";

describe("buildCodexConfigPlan", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("describes a project-scoped native Codex entry without writing it", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-codex-plan-"));
    temporaryDirectories.push(projectRoot);
    const targetPath = path.join(projectRoot, ".codex", "config.toml");

    const plan = buildCodexConfigPlan(projectRoot);

    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "mcp-slim-guard/config-plan",
      mode: "dry-run",
      host: "codex",
      support: "supported",
      target: {
        scope: "project",
        path: targetPath,
        exists: false,
        slimGuardEntry: "absent",
      },
      server: {
        surface: "native",
        command: "mcp-slim-guard",
        args: ["start", "--surface", "native"],
        cwd: projectRoot,
      },
      preconditions: {
        guardConfigPath: path.join(projectRoot, "mcp-slim-guard.yml"),
        guardConfigExists: false,
      },
      verification: {
        command: ["codex", "mcp", "list"],
      },
      writesPerformed: 0,
    });
    expect(plan.proposedChange.toml).toContain("[mcp_servers.slim_guard]");
    expect(fs.existsSync(targetPath)).toBe(false);
  });

  it("reports an existing Slim Guard entry without exposing its contents", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-codex-plan-"));
    temporaryDirectories.push(projectRoot);
    const codexDirectory = path.join(projectRoot, ".codex");
    fs.mkdirSync(codexDirectory);
    fs.writeFileSync(
      path.join(codexDirectory, "config.toml"),
      '[mcp_servers.slim_guard]\nenv = { SECRET = "do-not-report" }\n',
    );

    const plan = buildCodexConfigPlan(projectRoot);

    expect(plan.target).toMatchObject({ exists: true, slimGuardEntry: "present" });
    expect(JSON.stringify(plan)).not.toContain("do-not-report");
  });

  it("reports the generated Guard configuration as an installation precondition", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-codex-plan-"));
    temporaryDirectories.push(projectRoot);
    fs.writeFileSync(path.join(projectRoot, "mcp-slim-guard.yml"), "version: 1\n");

    const plan = buildCodexConfigPlan(projectRoot);

    expect(plan.preconditions).toEqual({
      guardConfigPath: path.join(projectRoot, "mcp-slim-guard.yml"),
      guardConfigExists: true,
    });
  });
});
