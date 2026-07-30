import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  InstallationConflictError,
  installTransaction,
  installationTransactionPath,
  rollbackTransaction,
} from "../../src/installation-transaction.js";
import { buildHostInstallationSpec } from "../../src/host-installation.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-slim-guard-install-"));
  temporaryRoots.push(root);
  return root;
}

function jsonSpec(projectRoot: string, content: string) {
  return {
    projectRoot,
    host: "claude-code" as const,
    targetPath: path.join(projectRoot, ".mcp.json"),
    content,
    validate(value: string) {
      const parsed = JSON.parse(value) as { mcpServers?: unknown };
      if (!parsed.mcpServers) throw new Error("missing mcpServers");
    },
  };
}

describe("installation transaction", () => {
  it("backs up the exact previous file, writes atomically, and restores it", () => {
    const project = tempProject();
    const target = path.join(project, ".mcp.json");
    const before = '{"mcpServers":{"legacy":{"command":"node","env":{"TOKEN":"SECRET"}}}}\n';
    const after = '{"mcpServers":{"slim_guard":{"command":"mcp-slim-guard"}}}\n';
    fs.writeFileSync(target, before, "utf8");

    const installed = installTransaction(jsonSpec(project, after));

    expect(fs.readFileSync(target, "utf8")).toBe(after);
    expect(installed.record.state).toBe("installed");
    expect(installed.record.beforeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.record.afterSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.record.backupPath).not.toBeNull();
    expect(fs.readFileSync(installed.record.backupPath!, "utf8")).toBe(before);
    expect(fs.readFileSync(installationTransactionPath(project), "utf8")).not.toContain("SECRET");

    const rolledBack = rollbackTransaction(project);

    expect(rolledBack.status).toBe("rolled_back");
    expect(fs.readFileSync(target, "utf8")).toBe(before);
    expect(JSON.parse(fs.readFileSync(installationTransactionPath(project), "utf8"))).toMatchObject({
      state: "rolled_back",
      beforeExisted: true,
    });
  });

  it("refuses to overwrite a later user edit during rollback", () => {
    const project = tempProject();
    const target = path.join(project, ".mcp.json");
    fs.writeFileSync(target, '{"original":true}\n', "utf8");
    installTransaction(jsonSpec(project, '{"mcpServers":{"slim_guard":true}}\n'));
    fs.writeFileSync(target, '{"user_edit":true}\n', "utf8");

    expect(() => rollbackTransaction(project)).toThrow(InstallationConflictError);
    expect(fs.readFileSync(target, "utf8")).toBe('{"user_edit":true}\n');
  });

  it("removes a newly created target only when its installed hash is unchanged", () => {
    const project = tempProject();
    const installedContent = '{"mcpServers":{"slim_guard":{}}}\n';
    const result = installTransaction(jsonSpec(project, installedContent));

    expect(result.record.beforeExisted).toBe(false);
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(true);
    rollbackTransaction(project);
    expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(false);
  });
});

describe("Host installation renderers", () => {
  it("upserts only the Codex Slim Guard table", () => {
    const project = tempProject();
    fs.mkdirSync(path.join(project, ".codex"));
    fs.writeFileSync(path.join(project, ".codex", "config.toml"), '[mcp_servers.other]\ncommand = "other"\n\n', "utf8");

    const spec = buildHostInstallationSpec(project, "codex");

    expect(spec.content).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(spec.content).toContain("[mcp_servers.slim_guard]");
    expect(spec.content.match(/\[mcp_servers\.slim_guard\]/g)).toHaveLength(1);
    expect(() => spec.validate(spec.content)).not.toThrow();
  });

  it("replaces Claude MCP servers while preserving unrelated top-level settings", () => {
    const project = tempProject();
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({ settings: { scope: "project" }, mcpServers: { legacy: { command: "node" } } }),
      "utf8",
    );

    const spec = buildHostInstallationSpec(project, "claude-code");
    const parsed = JSON.parse(spec.content) as Record<string, unknown>;

    expect(parsed.settings).toEqual({ scope: "project" });
    expect(Object.keys(parsed.mcpServers as object)).toEqual(["slim_guard"]);
    expect(() => spec.validate(spec.content)).not.toThrow();
  });
});
