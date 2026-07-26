import * as path from "node:path";
import type { RemoteUpstreamServer, StdioUpstreamServer, UpstreamServer } from "./config-types.js";

const SENSITIVE_FIELD = /authorization|api[-_]?key|token|password|passwd|secret|cookie|credential/i;
const ENV_REFERENCE = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/;
const ENV_REFERENCE_WITH_DEFAULT = /\$\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*:-[^}]*\}/;
const ENV_TEMPLATE = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const ANY_TEMPLATE = /\$\{[^}]+\}/;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ResolvedStdioUpstream {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

export interface ResolvedRemoteUpstream {
  kind: "http" | "sse";
  url: URL;
  headers: Record<string, string>;
}

export type ResolvedUpstream = ResolvedStdioUpstream | ResolvedRemoteUpstream;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOptionalString(value: unknown, field: string, serverName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Invalid upstream "${serverName}": ${field} must be a string`);
  }
  return value;
}

function readStringArray(value: unknown, field: string, serverName: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid upstream "${serverName}": ${field} must be an array of strings`);
  }
  return [...value];
}

function readStringMap(value: unknown, field: string, serverName: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error(`Invalid upstream "${serverName}": ${field} must contain only string values`);
  }
  return { ...(value as Record<string, string>) };
}

function replaceWorkspaceVariables(value: string, workspaceRoot: string): string {
  return value
    .replaceAll("${workspaceFolder}", workspaceRoot)
    .replaceAll("${workspaceFolderBasename}", path.basename(workspaceRoot));
}

function assertEnvironmentBackedValue(serverName: string, field: string, value: string): void {
  if (!ENV_REFERENCE.test(value)) {
    throw new Error(
      `Invalid upstream "${serverName}": sensitive field ${field} must reference an environment variable`,
    );
  }
  if (ENV_REFERENCE_WITH_DEFAULT.test(value)) {
    throw new Error(`Invalid upstream "${serverName}": sensitive field ${field} cannot contain a plaintext fallback`);
  }
}

/**
 * Enforce the configuration trust boundary without resolving or logging secret
 * values. Existing non-sensitive environment entries remain compatible.
 */
export function assertEnvironmentBackedSecrets(serverName: string, server: UpstreamServer): void {
  if ("command" in server) {
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (SENSITIVE_FIELD.test(key)) {
        assertEnvironmentBackedValue(serverName, `env.${key}`, value);
      }
    }
    return;
  }

  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(server.url);
  } catch {
    // URL syntax and resolved credentials are validated at connection time.
  }
  if (parsedUrl) {
    for (const [key, value] of parsedUrl.searchParams) {
      if (SENSITIVE_FIELD.test(key)) {
        assertEnvironmentBackedValue(serverName, `url query ${key}`, value);
      }
    }
  }

  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (SENSITIVE_FIELD.test(key)) {
      assertEnvironmentBackedValue(serverName, `headers.${key}`, value);
    }
  }
}

/**
 * Normalize one entry from a host ecosystem config into Slim Guard's small
 * upstream union. Unknown host-only metadata is intentionally not copied.
 */
export function importUpstreamServer(serverName: string, value: unknown, workspaceRoot: string): UpstreamServer {
  if (!isRecord(value)) {
    throw new Error(`Invalid upstream "${serverName}": expected an object`);
  }

  const type = readOptionalString(value.type, "type", serverName);
  const command = readOptionalString(value.command, "command", serverName);
  const url = readOptionalString(value.url, "url", serverName);

  if (command !== undefined && url !== undefined) {
    throw new Error(`Invalid upstream "${serverName}": choose command or url, not both`);
  }

  if (command !== undefined) {
    if (type !== undefined && type !== "stdio") {
      throw new Error(`Invalid upstream "${serverName}": command requires type "stdio"`);
    }
    const server: StdioUpstreamServer = {
      ...(type === "stdio" ? { type } : {}),
      command: replaceWorkspaceVariables(command, workspaceRoot),
      args: readStringArray(value.args, "args", serverName).map((item) =>
        replaceWorkspaceVariables(item, workspaceRoot),
      ),
      env: Object.fromEntries(
        Object.entries(readStringMap(value.env, "env", serverName)).map(([key, item]) => [
          key,
          replaceWorkspaceVariables(item, workspaceRoot),
        ]),
      ),
    };
    const cwd = readOptionalString(value.cwd, "cwd", serverName);
    if (cwd !== undefined) {
      server.cwd = replaceWorkspaceVariables(cwd, workspaceRoot);
    }
    assertEnvironmentBackedSecrets(serverName, server);
    return server;
  }

  if (url !== undefined) {
    if (type !== undefined && !["http", "streamable-http", "sse"].includes(type)) {
      throw new Error(`Invalid upstream "${serverName}": url requires type "http" or "sse"`);
    }
    const server: RemoteUpstreamServer = {
      ...(type !== undefined ? { type: type as NonNullable<RemoteUpstreamServer["type"]> } : {}),
      url: replaceWorkspaceVariables(url, workspaceRoot),
      headers: Object.fromEntries(
        Object.entries(readStringMap(value.headers, "headers", serverName)).map(([key, item]) => [
          key,
          replaceWorkspaceVariables(item, workspaceRoot),
        ]),
      ),
    };
    assertEnvironmentBackedSecrets(serverName, server);
    return server;
  }

  throw new Error(`Invalid upstream "${serverName}": expected command or url`);
}

function expandEnvironment(serverName: string, field: string, value: string, environment: Environment): string {
  const expanded = value.replace(ENV_TEMPLATE, (_match, name: string, fallback: string | undefined) => {
    const resolved = environment[name];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error(`Upstream "${serverName}" requires environment variable ${name} for ${field}`);
  });

  if (ANY_TEMPLATE.test(expanded)) {
    throw new Error(
      `Invalid upstream "${serverName}": ${field} contains an unsupported variable; use \${NAME} or \${env:NAME}`,
    );
  }
  return expanded;
}

/** Resolve environment-backed values immediately before opening a connection. */
export function resolveUpstreamServer(
  serverName: string,
  server: UpstreamServer,
  environment: Environment = process.env,
): ResolvedUpstream {
  assertEnvironmentBackedSecrets(serverName, server);

  if ("command" in server) {
    const command = expandEnvironment(serverName, "command", server.command, environment);
    if (command.trim() === "") {
      throw new Error(`Invalid upstream "${serverName}": command cannot be empty`);
    }

    return {
      kind: "stdio",
      command,
      args: (server.args ?? []).map((item, index) =>
        expandEnvironment(serverName, `args[${index}]`, item, environment),
      ),
      env: Object.fromEntries(
        Object.entries(server.env ?? {}).map(([key, value]) => [
          key,
          expandEnvironment(serverName, `env.${key}`, value, environment),
        ]),
      ),
      ...(server.cwd !== undefined ? { cwd: expandEnvironment(serverName, "cwd", server.cwd, environment) } : {}),
    };
  }

  const urlValue = expandEnvironment(serverName, "url", server.url, environment);
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid upstream "${serverName}": url must be an absolute URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Invalid upstream "${serverName}": url must use http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`Invalid upstream "${serverName}": credentials must use environment-backed headers`);
  }

  return {
    kind: server.type === "sse" ? "sse" : "http",
    url,
    headers: Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([key, value]) => [
        key,
        expandEnvironment(serverName, `headers.${key}`, value, environment),
      ]),
    ),
  };
}
