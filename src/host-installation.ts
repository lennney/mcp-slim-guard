import * as fs from "node:fs";
import * as path from "node:path";
import { buildClaudeConfigPlan, type ClaudeConfigPlan } from "./claude-config-plan.js";
import { buildCodexConfigPlan, type CodexConfigPlan } from "./codex-config-plan.js";
import type { InstallationHost, InstallationSpec } from "./installation-transaction.js";
import { assertClaudeInstallationMode, type ClaudeInstallationMode, type GuardMode } from "./modes.js";

export type HostConfigPlan = CodexConfigPlan | ClaudeConfigPlan;

export interface HostInstallationSpec extends InstallationSpec {
  plan: HostConfigPlan;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function tomlTableHeader(line: string): boolean {
  return /^\s*\[{1,2}[^\]]+\]{1,2}\s*$/u.test(line);
}

function slimGuardTable(line: string): boolean {
  return /^\s*\[mcp_servers\.slim_guard\]\s*$/u.test(line);
}

function renderCodexConfig(current: string, fragment: string): string {
  const normalized = normalizeNewlines(current);
  const lines = normalized.split("\n");
  const tableIndices = lines.flatMap((line, index) => (slimGuardTable(line) ? [index] : []));
  if (tableIndices.length > 1) throw new Error("Codex config contains duplicate Slim Guard tables.");
  const blockLines = normalizeNewlines(fragment).trim().split("\n");

  if (tableIndices.length === 0) {
    const base = normalized.replace(/\n+$/u, "");
    return `${base}${base ? "\n\n" : ""}${blockLines.join("\n")}\n`;
  }

  const start = tableIndices[0];
  if (start === undefined) throw new Error("Codex config Slim Guard table is missing.");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tomlTableHeader(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const rendered = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join("\n");
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function validateCodexConfig(content: string, fragment: string): void {
  const normalized = normalizeNewlines(content);
  const lines = normalized.split("\n");
  const indices = lines.flatMap((line, index) => (slimGuardTable(line) ? [index] : []));
  if (indices.length !== 1) throw new Error("Written Codex config has an invalid Slim Guard table.");
  const start = indices[0];
  if (start === undefined) throw new Error("Written Codex config has an invalid Slim Guard table.");
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tomlTableHeader(lines[index] ?? "")) {
      end = index;
      break;
    }
  }
  const actual = lines.slice(start, end).join("\n").trim();
  if (actual !== normalizeNewlines(fragment).trim()) {
    throw new Error("Written Codex config does not match the planned Slim Guard entry.");
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("Claude Code MCP config is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Claude Code MCP config must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function assertConfigTargetIsRegular(targetPath: string): void {
  try {
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink()) throw new Error("Host configuration target must not be a symbolic link.");
    if (!stat.isFile()) throw new Error("Host configuration target must be a regular file.");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function renderClaudeConfig(targetPath: string, plan: ClaudeConfigPlan): string {
  const current = readJsonObject(targetPath);
  const proposed = JSON.parse(plan.proposedChange.json) as { mcpServers: Record<string, unknown> };
  return `${JSON.stringify({ ...current, mcpServers: proposed.mcpServers }, null, 2)}\n`;
}

function validateClaudeConfig(content: string, expectedMode: ClaudeInstallationMode): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Written Claude Code MCP config is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Written Claude Code MCP config must be a JSON object.");
  }
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Written Claude Code MCP config has no valid mcpServers object.");
  }
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== "slim_guard") {
    throw new Error("Written Claude Code MCP config contains an unexpected server set.");
  }
  const entry = (servers as Record<string, unknown>).slim_guard;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Written Claude Code MCP config has an invalid Slim Guard entry.");
  }
  const server = entry as Record<string, unknown>;
  if (
    server.type !== "stdio" ||
    server.command !== "mcp-slim-guard" ||
    JSON.stringify(server.args) !== JSON.stringify(["start", "--mode", expectedMode])
  ) {
    throw new Error("Written Claude Code MCP config does not match the planned Slim Guard entry.");
  }
}

export function buildHostInstallationSpec(
  projectRoot: string,
  host: InstallationHost,
  mode?: GuardMode,
): HostInstallationSpec {
  const cwd = path.resolve(projectRoot);
  if (host === "codex") {
    assertConfigTargetIsRegular(path.join(cwd, ".codex", "config.toml"));
    const plan = buildCodexConfigPlan(cwd, mode ?? "native");
    const current = plan.target.exists ? fs.readFileSync(plan.target.path, "utf8") : "";
    const content = renderCodexConfig(current, plan.proposedChange.toml);
    return {
      projectRoot: cwd,
      host,
      targetPath: plan.target.path,
      content,
      validate: (value) => validateCodexConfig(value, plan.proposedChange.toml),
      plan,
    };
  }

  assertConfigTargetIsRegular(path.join(cwd, ".mcp.json"));
  const selectedMode = mode ?? "compact";
  assertClaudeInstallationMode(selectedMode);
  const plan = buildClaudeConfigPlan(cwd, selectedMode);
  const content = renderClaudeConfig(plan.target.path, plan);
  return {
    projectRoot: cwd,
    host,
    targetPath: plan.target.path,
    content,
    validate: (value) => validateClaudeConfig(value, selectedMode),
    plan,
  };
}
