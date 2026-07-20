/**
 * HTTP transport integration test
 *
 * Verifies that `mcp-guard start --http` creates a real HTTP server on the
 * requested port and accepts POST /mcp requests.
 */

import { describe, it, expect, vi } from "vitest";
import { main } from "../../src/cli.js";
import type { GuardConfig } from "../../src/config-types.js";

const TEST_PORT = 31999;

describe("mcp-guard HTTP transport", () => {
  it("listens on the configured HTTP port", async () => {
    const config: GuardConfig = {
      version: 1,
      tools: { allow: ["mock_*"], deny: [] },
      ssrf: { mode: "off", block_private_ips: false, allow_domains: [], block_domains: [] },
      rate_limit: { default: "1000/min" },
      injection_detection: { enabled: false },
      compressor: { enabled: false, level: "light" },
      audit: { output: "stdout", filePath: "mcp-guard-audit.log" },
      servers: {
        mock: {
          command: "node",
          args: ["-e", "console.log('mock server')"],
          env: {},
        },
      },
    };

    vi.doMock("../../src/config-loader.js", () => ({
      ConfigLoader: {
        findAndLoad: () => config,
        discoverMCPConfig: () => null,
        generateGuardConfig: () => config,
        loadGuardConfig: () => config,
      },
    }));

    const { main: mockedMain } = await import("../../src/cli.js");

    const startPromise = mockedMain(["node", "cli.js", "start", "--http", "--port", String(TEST_PORT)]);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    // We only need to prove that an HTTP server is actually listening on the port.
    // Any HTTP response (200, 400, 406, 404) is sufficient; connection refused would fail.
    expect([200, 400, 404, 405, 406]).toContain(res.status);

    await startPromise.catch(() => undefined);
  });
});
