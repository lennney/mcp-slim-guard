import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UpstreamServer } from "../../src/config-types.js";
import {
  assertEnvironmentBackedSecrets,
  importUpstreamServer,
  resolveUpstreamServer,
} from "../../src/upstream-config.js";

describe("upstream config compatibility", () => {
  it("imports stdio entries and resolves VS Code workspace variables", () => {
    const workspace = path.resolve("tests", "workspace");
    const server = importUpstreamServer(
      "local",
      {
        type: "stdio",
        command: "node",
        args: ["${workspaceFolder}/server.js"],
        cwd: "${workspaceFolder}",
        env: { MODE: "test" },
        hostOnlyMetadata: true,
      },
      workspace,
    );

    expect(server).toMatchObject({
      type: "stdio",
      command: "node",
      cwd: workspace,
      env: { MODE: "test" },
    });
    expect("args" in server ? path.normalize(server.args?.[0] ?? "") : "").toBe(path.join(workspace, "server.js"));
  });

  it("imports remote entries without copying host-only metadata", () => {
    const server = importUpstreamServer(
      "remote",
      {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer ${REMOTE_AUTH}" },
        gallery: "ignored",
      },
      process.cwd(),
    );

    expect(server).toEqual({
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer ${REMOTE_AUTH}" },
    });
  });

  it("requires exactly one of command or url", () => {
    expect(() =>
      importUpstreamServer("broken", { command: "node", url: "https://mcp.example.test/mcp" }, process.cwd()),
    ).toThrow("choose command or url");
    expect(() => importUpstreamServer("broken", {}, process.cwd())).toThrow("expected command or url");
  });

  it("rejects transport types that do not match the entry shape", () => {
    expect(() => importUpstreamServer("broken", { type: "http", command: "node" }, process.cwd())).toThrow(
      'command requires type "stdio"',
    );
    expect(() =>
      importUpstreamServer("broken", { type: "custom", url: "https://mcp.example.test/mcp" }, process.cwd()),
    ).toThrow('url requires type "http" or "sse"');
  });

  it("requires sensitive env and header values to come from the environment", () => {
    expect(() =>
      assertEnvironmentBackedSecrets("remote", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "" },
      }),
    ).toThrow("must reference an environment variable");

    expect(() =>
      assertEnvironmentBackedSecrets("local", {
        command: "node",
        env: { API_KEY: "${TEST_API_KEY:-not-allowed}" },
      }),
    ).toThrow("cannot contain a plaintext fallback");

    expect(() =>
      assertEnvironmentBackedSecrets("remote", {
        url: "https://mcp.example.test/mcp?api_key=",
      }),
    ).toThrow("must reference an environment variable");

    expect(() =>
      assertEnvironmentBackedSecrets("local", {
        command: "node",
        env: { API_KEY: "${TEST_API_KEY}" },
      }),
    ).not.toThrow();
  });

  it("resolves Claude and VS Code environment templates at connection time", () => {
    const local = resolveUpstreamServer(
      "local",
      {
        command: "${env:RUNTIME}",
        args: ["${SCRIPT}", "${MODE:-safe}"],
        env: { API_KEY: "${TEST_API_KEY}" },
      },
      {
        RUNTIME: "node",
        SCRIPT: "server.js",
        TEST_API_KEY: "resolved-value",
      },
    );

    expect(local).toEqual({
      kind: "stdio",
      command: "node",
      args: ["server.js", "safe"],
      env: { API_KEY: "resolved-value" },
    });

    const remote = resolveUpstreamServer(
      "remote",
      {
        url: "https://mcp.example.test/${ROUTE}",
        headers: {
          Authorization: "Bearer ${REMOTE_AUTH}",
          "X-Mode": "${MODE:-safe}",
        },
      },
      { ROUTE: "mcp", REMOTE_AUTH: "resolved-value" },
    );

    expect(remote.kind).toBe("http");
    if (remote.kind === "http") {
      expect(remote.url.href).toBe("https://mcp.example.test/mcp");
      expect(remote.headers).toEqual({
        Authorization: "Bearer resolved-value",
        "X-Mode": "safe",
      });
    }
  });

  it("fails clearly for missing, interactive, or unsupported variables", () => {
    expect(() => resolveUpstreamServer("local", { command: "${MISSING}" }, {})).toThrow(
      "requires environment variable MISSING",
    );
    expect(() => resolveUpstreamServer("local", { command: "${input:runtime}" }, {})).toThrow("unsupported variable");
  });

  it.each<UpstreamServer>([{ url: "file:///tmp/server" }, { url: "https://user@example.test/mcp" }])(
    "rejects unsafe remote URL credentials or protocols",
    (server) => {
      expect(() => resolveUpstreamServer("remote", server, {})).toThrow(/http or https|credentials/);
    },
  );
});
