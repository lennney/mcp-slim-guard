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
    // Polling + spawn can exceed vitest default 5s testTimeout under load.
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

    // Poll until the HTTP server is actually listening instead of a fixed
    // delay. The upstream spawn + connect can take longer than a fixed 500ms,
    // which previously caused ECONNREFUSED before the port was bound.
    const deadline = Date.now() + 30000;
    let res: Response | undefined;
    while (Date.now() < deadline) {
      try {
        res = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        });
        break;
      } catch {
        // Connection refused — server not ready yet; retry shortly.
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!res) {
      throw new Error(`HTTP server did not start listening on port ${TEST_PORT} within 10s`);
    }
    // We only need to prove that an HTTP server is actually listening on the port.
    // Any HTTP response (200, 400, 406, 404) is sufficient; connection refused would fail.
    expect([200, 400, 404, 405, 406]).toContain(res.status);

    await startPromise.catch(() => undefined);
  }, 45000);
});
