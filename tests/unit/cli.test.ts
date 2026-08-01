/**
 * CLI unit tests
 *
 * Tests the commander-based CLI for mcp-guard.
 * Uses vi.mock() for all external deps; no real processes spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const { mockOpen } = vi.hoisted(() => ({ mockOpen: vi.fn().mockResolvedValue(undefined) }));

vi.mock("open", () => ({ default: mockOpen }));

// ── Mock all CLI dependencies ──────────────────────────────────────────
// NOTE: vi.mock() is hoisted to top. Factories execute when module loads.

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../../src/config-loader.js", () => ({
  ConfigLoader: {
    discoverMCPConfig: vi.fn<(cwd: string) => string | null>(),
    generateGuardConfig: vi.fn<(path: string) => Record<string, unknown>>(),
    loadGuardConfig: vi.fn<(path: string) => Record<string, unknown>>(),
    findAndLoad: vi.fn<(cwd: string) => Record<string, unknown> | null>(),
    serializeGeneratedConfig: vi.fn<(config: Record<string, unknown>) => string>(),
  },
}));

vi.mock("../../src/version.js", () => ({
  VERSION: "0.1.1-alpha.1",
}));

vi.mock("../../src/policies/base.js", () => ({
  PolicyPipeline: vi.fn(),
}));

vi.mock("../../src/policies/whitelist.js", () => ({
  WhitelistPolicy: vi.fn(),
}));

vi.mock("../../src/policies/ssrf.js", () => ({
  SSRFPolicy: vi.fn(),
}));

vi.mock("../../src/policies/ratelimit.js", () => ({
  RateLimitPolicy: vi.fn(),
}));

vi.mock("../../src/audit.js", () => ({
  AuditLogger: vi.fn(),
}));

const { ServerManager: MockServerManager, mockManagerCallTool } = vi.hoisted(() => {
  const getTools = vi.fn().mockReturnValue([]);
  const callTool = vi.fn();
  const start = vi.fn().mockResolvedValue({
    configured: 1,
    connected: [{ serverName: "github", transportKind: "stdio", toolCount: 0 }],
    failed: [],
  });
  const stop = vi.fn().mockResolvedValue({ closed: ["github"], failed: [] });
  return {
    ServerManager: vi.fn().mockImplementation(() => ({ getTools, callTool, start, stop })),
    mockManagerCallTool: callTool,
  };
});

vi.mock("../../src/server-manager.js", () => ({
  ServerManager: MockServerManager,
}));

// GuardProxy mock — store .start reference so tests can verify it was called
vi.mock("../../src/proxy.js", () => {
  const start = vi.fn<(transport: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const recordLifecycle = vi.fn();
  const GuardProxy = vi.fn().mockImplementation(() => ({ start, stop, recordLifecycle }));
  return { GuardProxy };
});

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ size: 0 }),
  watch: vi.fn().mockReturnValue({ close: vi.fn() }),
  unlinkSync: vi.fn(),
  openSync: vi.fn().mockReturnValue(0),
  readSync: vi.fn(),
  closeSync: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────

import { main, buildAuditOptions } from "../../src/cli.js";
import * as ConfigLoaderModule from "../../src/config-loader.js";
import { GuardProxy } from "../../src/proxy.js";

// ── Typed mock helpers ────────────────────────────────────────────────

const MockConfigLoader = ConfigLoaderModule as unknown as {
  ConfigLoader: {
    discoverMCPConfig: ReturnType<typeof vi.fn>;
    generateGuardConfig: ReturnType<typeof vi.fn>;
    loadGuardConfig: ReturnType<typeof vi.fn>;
    findAndLoad: ReturnType<typeof vi.fn>;
    serializeGeneratedConfig: ReturnType<typeof vi.fn>;
  };
};

// ── Fixtures ───────────────────────────────────────────────────────────

const MOCK_GUARD_CONFIG: Record<string, unknown> = {
  version: 1,
  tools: { allow: ["github_*"], deny: ["*_delete_*"] },
  ssrf: {
    mode: "block",
    block_private_ips: true,
    allow_domains: [],
    block_domains: [],
  },
  rate_limit: { default: "60/min" },
  injection_detection: { enabled: false, sensitivity: "medium" },
  compressor: { enabled: false, level: "light" },
  audit: {
    output: "file",
    filePath: "mcp-guard-audit.log",
    maxSize: "10MB",
    maxFiles: 5,
    compress: false,
  },
  servers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: {} },
  },
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("CLI", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Reset all ConfigLoader mocks
    MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReset();
    MockConfigLoader.ConfigLoader.generateGuardConfig.mockReset();
    MockConfigLoader.ConfigLoader.loadGuardConfig.mockReset();
    MockConfigLoader.ConfigLoader.findAndLoad.mockReset();
    MockConfigLoader.ConfigLoader.serializeGeneratedConfig.mockReset();
    MockConfigLoader.ConfigLoader.serializeGeneratedConfig.mockReturnValue("version: 1\n");
    mockOpen.mockReset();
    mockOpen.mockResolvedValue(undefined);

    // Reset GuardProxy mock
    vi.mocked(GuardProxy).mockClear();
    // Reset mock implementation (so each test gets a fresh start function)
    vi.mocked(GuardProxy).mockReset();
    // Re-apply the mock implementation
    vi.mocked(GuardProxy).mockImplementation(() => ({
      start: vi.fn<(transport: unknown) => Promise<void>>().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      recordLifecycle: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── init ─────────────────────────────────────────────────────────

  describe("analyze", () => {
    it("prints a read-only JSON report without writing files or invoking an upstream Tool", async () => {
      MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReturnValue("/fake/path/.mcp.json");
      MockConfigLoader.ConfigLoader.generateGuardConfig.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "analyze"]);

      expect(MockConfigLoader.ConfigLoader.discoverMCPConfig).toHaveBeenCalledWith(expect.any(String));
      expect(MockConfigLoader.ConfigLoader.generateGuardConfig).toHaveBeenCalledWith("/fake/path/.mcp.json");
      expect(vi.mocked(await import("node:fs")).writeFileSync).not.toHaveBeenCalled();
      expect(mockManagerCallTool).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      const output = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(output).toMatchObject({
        schemaVersion: 1,
        kind: "mcp-slim-guard/analyze",
        mode: "read-only",
        estimator: { id: "chars-div-4-v1" },
        operations: ["tools/list"],
      });
      expect(JSON.stringify(output)).not.toContain("/fake/path");
    });
  });

  describe("profile", () => {
    it("reads the configured audit segment without starting an upstream manager or writing files", async () => {
      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((candidate: string) =>
        candidate.endsWith("mcp-guard-audit.log"),
      );
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        [
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 1,
            toolName: "runtime/starting",
            serverName: "system",
            action: "allowed",
            decisionTrail: [],
            event: "lifecycle",
            outcome: "success",
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 2,
            toolName: "runtime/ready",
            serverName: "system",
            action: "allowed",
            decisionTrail: [],
            event: "lifecycle",
            outcome: "success",
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 3,
            toolName: "tools/list",
            serverName: "projection",
            action: "discovery",
            decisionTrail: [],
            event: "discovery",
            outcome: "success",
            metadata: {
              directCatalog: { tools: 1, characters: 100 },
              hostFacingCatalog: { tools: 3, characters: 200 },
            },
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 4,
            traceId: "t_profile",
            toolName: "github_read",
            serverName: "github",
            action: "allowed",
            decisionTrail: [],
            event: "upstream",
            outcome: "success",
            metadata: { resultChars: 100, upstreamToolName: "read" },
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 5,
            traceId: "t_profile",
            toolName: "github_read",
            serverName: "projection",
            action: "allowed",
            decisionTrail: [],
            event: "projection",
            outcome: "pass_through",
            metadata: {
              upstreamServerName: "github",
              upstreamToolName: "read",
              upstreamResultChars: 100,
              deliveredResultChars: 100,
              capsule: { phase: "delivery", outcome: "pass_through" },
            },
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 6,
            toolName: "runtime/stopping",
            serverName: "system",
            action: "allowed",
            decisionTrail: [],
            event: "lifecycle",
            outcome: "success",
          }),
          JSON.stringify({
            sessionId: "s_profile",
            requestId: 7,
            toolName: "runtime/stopped",
            serverName: "system",
            action: "allowed",
            decisionTrail: [],
            event: "lifecycle",
            outcome: "success",
          }),
        ].join("\n"),
      );

      await main(["node", "cli.js", "profile", "--json"]);

      expect(MockConfigLoader.ConfigLoader.findAndLoad).toHaveBeenCalledWith(expect.any(String));
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mockManagerCallTool).not.toHaveBeenCalled();
      const output = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(output).toMatchObject({
        schemaVersion: 1,
        kind: "mcp-slim-guard/profile",
        mode: "read-only",
        segment: { coverage: "complete" },
        delivery: { observedResults: 1, upstream: { characters: 100 }, host: { characters: 100 } },
      });
    });

    it("prints one allowlisted share report without upstream calls or writes", async () => {
      const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((candidate: string) =>
        candidate.endsWith("mcp-guard-audit.log"),
      );
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        [
          { event: "lifecycle", outcome: "success", toolName: "runtime/starting", serverName: "system", requestId: 1 },
          { event: "lifecycle", outcome: "success", toolName: "runtime/ready", serverName: "system", requestId: 2 },
          {
            event: "upstream",
            outcome: "success",
            toolName: "SECRET_TOOL",
            serverName: "SECRET_SERVER",
            traceId: "SECRET_ID",
            requestId: 3,
            arguments: { path: "C:/private" },
            metadata: { resultChars: 400, upstreamToolName: "SECRET_UPSTREAM" },
          },
          {
            event: "projection",
            outcome: "projected",
            toolName: "SECRET_TOOL",
            serverName: "projection",
            traceId: "SECRET_ID",
            requestId: 4,
            metadata: {
              upstreamServerName: "SECRET_SERVER",
              upstreamToolName: "SECRET_UPSTREAM",
              upstreamResultChars: 400,
              deliveredResultChars: 120,
              capsule: { phase: "delivery", outcome: "projected", referenceId: "SECRET_REF" },
            },
          },
          { event: "lifecycle", outcome: "success", toolName: "runtime/stopping", serverName: "system", requestId: 5 },
          { event: "lifecycle", outcome: "success", toolName: "runtime/stopped", serverName: "system", requestId: 6 },
        ]
          .map((entry) =>
            JSON.stringify({ sessionId: "SECRET_SESSION", action: "allowed", decisionTrail: [], ...entry }),
          )
          .join("\n"),
      );

      await main(["node", "cli.js", "profile", "--share", "--json"]);

      const outputText = String(consoleLogSpy.mock.calls[0]?.[0]);
      const output = JSON.parse(outputText) as Record<string, unknown>;
      expect(output).toMatchObject({
        kind: "mcp-slim-guard/share-report",
        scope: "latest-runtime-segment",
        payload: { change: { kind: "reduction", percent: 70 } },
        calls: { upstreamExecutions: 1, recoveryPageReads: 0 },
      });
      for (const forbidden of ["SECRET_TOOL", "SECRET_SERVER", "SECRET_ID", "SECRET_REF", "C:/private"]) {
        expect(outputText).not.toContain(forbidden);
      }
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mockManagerCallTool).not.toHaveBeenCalled();
    });

    it("opens a prefilled Issue after printing the safe terminal report", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((candidate: string) =>
        candidate.endsWith("mcp-guard-audit.log"),
      );
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        ["starting", "ready", "stopping", "stopped"]
          .map((name, requestId) =>
            JSON.stringify({
              sessionId: "s",
              requestId,
              toolName: `runtime/${name}`,
              serverName: "system",
              action: "allowed",
              decisionTrail: [],
              event: "lifecycle",
              outcome: "success",
            }),
          )
          .join("\n"),
      );

      await main(["node", "cli.js", "profile", "--open-report"]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("MCP Slim Guard Report"));
      expect(mockOpen).toHaveBeenCalledOnce();
      expect(String(mockOpen.mock.calls[0]?.[0])).toContain("compatibility-report.yml");

      mockOpen.mockRejectedValueOnce(new Error("browser unavailable"));
      await main(["node", "cli.js", "profile", "--open-report"]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Could not open a browser. Open the template and paste the report below:",
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(
        "https://github.com/lennney/mcp-slim-guard/issues/new?template=compatibility-report.yml",
      );
    });
  });

  describe("plan", () => {
    it("prints a Codex dry-run plan without writing configuration", async () => {
      await main(["node", "cli.js", "plan", "--host", "codex"]);

      expect(vi.mocked(await import("node:fs")).writeFileSync).not.toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);

      const output = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(output).toMatchObject({
        schemaVersion: 1,
        kind: "mcp-slim-guard/config-plan",
        mode: "dry-run",
        host: "codex",
        support: "supported",
        server: {
          surface: "native",
          command: "mcp-slim-guard",
          args: ["start", "--surface", "native"],
        },
        writesPerformed: 0,
      });
    });
  });

  describe("init", () => {
    it("discovers MCP config and generates mcp-slim-guard.yml → prints success", async () => {
      MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReturnValue("/fake/path/.mcp.json");
      MockConfigLoader.ConfigLoader.generateGuardConfig.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "init"]);

      expect(MockConfigLoader.ConfigLoader.discoverMCPConfig).toHaveBeenCalledWith(expect.any(String));
      expect(MockConfigLoader.ConfigLoader.generateGuardConfig).toHaveBeenCalledWith("/fake/path/.mcp.json");
      expect(MockConfigLoader.ConfigLoader.serializeGeneratedConfig).toHaveBeenCalledWith(MOCK_GUARD_CONFIG);
      expect(consoleLogSpy).toHaveBeenCalledWith("✅ Generated mcp-slim-guard.yml");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Imported servers: 1"));
      expect(consoleLogSpy).toHaveBeenCalledWith("   Next: mcp-slim-guard install --host <codex|claude-code>");
    });

    it("prints error and exits 1 when no MCP config found", async () => {
      MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReturnValue(null);

      await main(["node", "cli.js", "init"]);

      expect(MockConfigLoader.ConfigLoader.discoverMCPConfig).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith("Error: No MCP configuration file found.");
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(".vscode/mcp.json"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── start ────────────────────────────────────────────────────────

  describe("start", () => {
    it("loads config and keeps human status messages off protocol stdout", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "start"]);

      expect(MockConfigLoader.ConfigLoader.findAndLoad).toHaveBeenCalled();
      expect(consoleLogSpy).not.toHaveBeenCalledWith("🛡️ mcp-slim-guard started");
      expect(consoleErrorSpy).toHaveBeenCalledWith("🛡️ mcp-slim-guard started");
      expect(consoleErrorSpy).toHaveBeenCalledWith("   Listening on STDIO transport");
      // GuardProxy constructor was called
      expect(vi.mocked(GuardProxy)).toHaveBeenCalledWith(
        MOCK_GUARD_CONFIG,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { surface: "generic" },
      );
      // proxy.start was called on the returned instance
      const instance = vi.mocked(GuardProxy).mock.results[0]?.value as {
        start: ReturnType<typeof vi.fn>;
      };
      expect(instance.start).toHaveBeenCalled();
    });

    it("starts the explicit native Tool surface without changing the default", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "start", "--surface", "native"]);

      expect(vi.mocked(GuardProxy)).toHaveBeenCalledWith(
        MOCK_GUARD_CONFIG,
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { surface: "native" },
      );
    });
  });

  // ── status ───────────────────────────────────────────────────────

  describe("status", () => {
    it("prints config summary", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "status"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("🛡️ mcp-slim-guard configuration");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Servers: 1"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Policies:"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("github"));
    });
  });

  describe("doctor", () => {
    it("reports a structured upstream connection failure instead of treating zero tools as healthy", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);
      vi.mocked(MockServerManager).mockImplementationOnce(
        () =>
          ({
            start: vi.fn().mockResolvedValue({
              configured: 1,
              connected: [],
              failed: [{ serverName: "github", errorType: "McpError" }],
            }),
            getTools: vi.fn().mockReturnValue([]),
            stop: vi.fn().mockResolvedValue({ closed: [], failed: [] }),
          }) as never,
      );

      await main(["node", "cli.js", "doctor"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("❌ FAIL — McpError");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("0 server(s) OK, 1 failed"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── log ──────────────────────────────────────────────────────────

  describe("log", () => {
    it("shows message when no audit log file exists", async () => {
      // fs.existsSync mocked to return false by default
      await main(["node", "cli.js", "log"]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("No audit log found"));
    });

    it("shows tail mode with --tail", async () => {
      const { existsSync, readFileSync, statSync } = await import("node:fs");
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{"toolName":"test","action":"allowed"}\n');
      (statSync as ReturnType<typeof vi.fn>).mockReturnValue({ size: 50 });

      await main(["node", "cli.js", "log", "--tail"]);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Tailing"));
    });

    it("renders trace stage and upstream outcome", async () => {
      const { existsSync, readFileSync } = await import("node:fs");
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        `${JSON.stringify({
          timestamp: "2026-07-26T13:22:48.000Z",
          traceId: "t_1234567890abcdef",
          requestId: 3,
          serverName: "agent_search",
          toolName: "agent_search_free_search_advanced",
          action: "allowed",
          event: "upstream",
          outcome: "upstream_error",
          durationMs: 4,
        })}\n`,
      );

      await main(["node", "cli.js", "log"]);

      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("[t_12345678] #3 agent_search:agent_search_free_search_advanced"),
      );
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("upstream/upstream_error (4ms)"));
    });
  });

  // ── uninit ───────────────────────────────────────────────────────

  describe("uninit", () => {
    it("shows removal instructions", async () => {
      await main(["node", "cli.js", "uninit"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("To remove mcp-slim-guard:");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("uninit --force"));
    });
  });

  // ── help and version ─────────────────────────────────────────────

  describe("help and version", () => {
    it("shows error for unknown command", async () => {
      await main(["node", "cli.js", "unknown"]);

      // Commander outputs error to stderr for unknown commands
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrWriteSpy).toHaveBeenCalled();
    });

    it("shows version with --version", async () => {
      await main(["node", "cli.js", "--version"]);

      // Commander writes version to stdout
      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("0.1.1"));
    });

    it("shows help text with --help", async () => {
      await main(["node", "cli.js", "--help"]);

      // Commander writes help to stdout
      expect(stdoutWriteSpy).toHaveBeenCalled();
      // Help text should contain the command descriptions
      const allCalls = stdoutWriteSpy.mock.calls.map((call) => String(call[0])).join("");
      expect(allCalls).toContain("init");
      expect(allCalls).toContain("start");
      expect(allCalls).toContain("status");
      expect(allCalls).toContain("log");
      expect(allCalls).toContain("uninit");
    });
  });
});

describe("buildAuditOptions", () => {
  it("forwards rotation + memory options from audit config", () => {
    const opts = buildAuditOptions(
      { output: "file", filePath: "x.log", maxSize: "2MB", maxFiles: 3, compress: true, maxMemoryEntries: 500 },
      "/tmp",
    );
    expect(opts.output).toBe("file");
    expect(opts.filePath).toBe("x.log");
    expect(opts.maxSize).toBe("2MB");
    expect(opts.maxFiles).toBe(3);
    expect(opts.compress).toBe(true);
    expect(opts.maxMemoryEntries).toBe(500);
  });

  it("falls back to default filePath and omits unset options", () => {
    const opts = buildAuditOptions({ output: "file" }, "/tmp");
    expect(opts.output).toBe("file");
    expect(opts.filePath).toBe(path.join("/tmp", "mcp-slim-guard-audit.log"));
    expect(opts.maxSize).toBeUndefined();
  });

  it("does not set filePath for stdout output", () => {
    const opts = buildAuditOptions({ output: "stdout" }, "/tmp");
    expect(opts.output).toBe("stdout");
    expect(opts.filePath).toBeUndefined();
  });
});
