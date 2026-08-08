import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../../src/cli.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential("installation CLI", () => {
  it("installs and rolls back the Claude Code project configuration through the public commands", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slim-guard-cli-install-"));
    temporaryRoots.push(project);
    const original =
      JSON.stringify(
        {
          settings: { scope: "project" },
          mcpServers: { legacy: { command: "legacy-mcp", env: { TOKEN: "local-secret" } } },
        },
        null,
        2,
      ) + "\n";
    const target = path.join(project, ".mcp.json");
    fs.writeFileSync(target, original, "utf8");
    fs.writeFileSync(path.join(project, "mcp-slim-guard.yml"), "version: 2\n", "utf8");

    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(project);
      await main(["node", "cli.js", "install", "--host", "claude-code", "--json"]);

      const installSummary = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      expect(installSummary).toMatchObject({
        kind: "mcp-slim-guard/installation",
        mode: "installed",
        status: "installed",
        host: "claude-code",
        validation: "passed",
      });
      expect(JSON.stringify(installSummary)).not.toContain("local-secret");
      const installed = JSON.parse(fs.readFileSync(target, "utf8")) as Record<string, unknown>;
      expect(installed.settings).toEqual({ scope: "project" });
      expect(Object.keys(installed.mcpServers as object)).toEqual(["slim_guard"]);

      await main(["node", "cli.js", "rollback", "--json"]);

      const rollbackSummary = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      expect(rollbackSummary).toMatchObject({
        kind: "mcp-slim-guard/installation",
        mode: "rolled_back",
        status: "rolled_back",
        validation: "restored_exact_before_sha256",
      });
      expect(fs.readFileSync(target, "utf8")).toBe(original);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      vi.restoreAllMocks();
    }
  });

  it("installs and rolls back the Codex project configuration through the public commands", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slim-guard-cli-codex-"));
    temporaryRoots.push(project);
    const codexDirectory = path.join(project, ".codex");
    fs.mkdirSync(codexDirectory);
    const original = '[mcp_servers.other]\ncommand = "other-mcp"\n';
    const target = path.join(codexDirectory, "config.toml");
    fs.writeFileSync(target, original, "utf8");
    fs.writeFileSync(path.join(project, "mcp-slim-guard.yml"), "version: 2\n", "utf8");

    const previousCwd = process.cwd();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.chdir(project);
      await main(["node", "cli.js", "install", "--host", "codex", "--json"]);

      const installSummary = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
      expect(installSummary).toMatchObject({
        host: "codex",
        mode: "installed",
        status: "installed",
        validation: "passed",
      });
      const installed = fs.readFileSync(target, "utf8");
      expect(installed).toContain('[mcp_servers.other]\ncommand = "other-mcp"');
      expect(installed).toContain("[mcp_servers.slim_guard]");
      expect(installed).toContain('args = ["start","--mode","native"]');

      await main(["node", "cli.js", "rollback", "--host", "codex", "--json"]);

      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        host: "codex",
        mode: "rolled_back",
        status: "rolled_back",
      });
      expect(fs.readFileSync(target, "utf8")).toBe(original);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(previousCwd);
      vi.restoreAllMocks();
    }
  });
});
