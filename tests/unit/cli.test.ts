/**
 * CLI unit tests
 *
 * Tests the commander-based CLI for mcp-guard.
 * Uses vi.mock() for all external deps; no real processes spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  },
}));

vi.mock("../../src/index.js", () => ({
  VERSION: "0.1.0",
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

vi.mock("../../src/server-manager.js", () => ({
  ServerManager: vi.fn(),
}));

// GuardProxy mock — store .start reference so tests can verify it was called
vi.mock("../../src/proxy.js", () => {
  const start = vi.fn<(transport: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const GuardProxy = vi.fn().mockImplementation(() => ({ start }));
  return { GuardProxy };
});

vi.mock("js-yaml", () => ({
  dump: vi.fn<(obj: unknown) => string>().mockReturnValue("version: 1"),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────

import { main } from "../../src/cli.js";
import * as ConfigLoaderModule from "../../src/config-loader.js";
import { GuardProxy } from "../../src/proxy.js";

// ── Typed mock helpers ────────────────────────────────────────────────

const MockConfigLoader = ConfigLoaderModule as unknown as {
  ConfigLoader: {
    discoverMCPConfig: ReturnType<typeof vi.fn>;
    generateGuardConfig: ReturnType<typeof vi.fn>;
    loadGuardConfig: ReturnType<typeof vi.fn>;
    findAndLoad: ReturnType<typeof vi.fn>;
  };
};

// ── Fixtures ───────────────────────────────────────────────────────────

const MOCK_GUARD_CONFIG: Record<string, unknown> = {
  version: 1,
  tools: { allow: ["github_*"], deny: ["delete_*"] },
  ssrf: {
    mode: "block",
    block_private_ips: true,
    allow_domains: [],
    block_domains: [],
  },
  rate_limit: { default: "60/min" },
  injection_detection: { enabled: false, sensitivity: "medium" },
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

    // Reset GuardProxy mock
    vi.mocked(GuardProxy).mockClear();
    // Reset mock implementation (so each test gets a fresh start function)
    vi.mocked(GuardProxy).mockReset();
    // Re-apply the mock implementation
    vi.mocked(GuardProxy).mockImplementation(() => ({
      start: vi.fn<(transport: unknown) => Promise<void>>().mockResolvedValue(undefined),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── init ─────────────────────────────────────────────────────────

  describe("init", () => {
    it("discovers MCP config and generates mcp-guard.yml → prints success", async () => {
      MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReturnValue("/fake/path/.mcp.json");
      MockConfigLoader.ConfigLoader.generateGuardConfig.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "init"]);

      expect(MockConfigLoader.ConfigLoader.discoverMCPConfig).toHaveBeenCalledWith(
        expect.stringContaining("mcp-guard"),
      );
      expect(MockConfigLoader.ConfigLoader.generateGuardConfig).toHaveBeenCalledWith(
        "/fake/path/.mcp.json",
      );
      expect(consoleLogSpy).toHaveBeenCalledWith("✅ Generated mcp-guard.yml");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Servers: 1"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Policies:"));
    });

    it("prints error and exits 1 when no MCP config found", async () => {
      MockConfigLoader.ConfigLoader.discoverMCPConfig.mockReturnValue(null);

      await main(["node", "cli.js", "init"]);

      expect(MockConfigLoader.ConfigLoader.discoverMCPConfig).toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith("Error: No MCP configuration file found.");
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ── start ────────────────────────────────────────────────────────

  describe("start", () => {
    it("loads config and starts proxy → prints started message", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "start"]);

      expect(MockConfigLoader.ConfigLoader.findAndLoad).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith("🛡️ mcp-guard started");
      expect(consoleLogSpy).toHaveBeenCalledWith("   Listening on STDIO transport");
      // GuardProxy constructor was called
      expect(vi.mocked(GuardProxy)).toHaveBeenCalled();
      // proxy.start was called on the returned instance
      const instance = vi.mocked(GuardProxy).mock.results[0]?.value as {
        start: ReturnType<typeof vi.fn>;
      };
      expect(instance.start).toHaveBeenCalled();
    });
  });

  // ── status ───────────────────────────────────────────────────────

  describe("status", () => {
    it("prints config summary", async () => {
      MockConfigLoader.ConfigLoader.findAndLoad.mockReturnValue(MOCK_GUARD_CONFIG);

      await main(["node", "cli.js", "status"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("🛡️ mcp-guard status");
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Servers: 1"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("Policies:"));
      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining("github"));
    });
  });

  // ── log ──────────────────────────────────────────────────────────

  describe("log", () => {
    it("shows log command", async () => {
      await main(["node", "cli.js", "log"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("Audit log entries:");
    });

    it("shows tail mode with --tail", async () => {
      await main(["node", "cli.js", "log", "--tail"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("Tailing audit log...");
    });
  });

  // ── uninit ───────────────────────────────────────────────────────

  describe("uninit", () => {
    it("shows removal instructions", async () => {
      await main(["node", "cli.js", "uninit"]);

      expect(consoleLogSpy).toHaveBeenCalledWith("To remove mcp-guard:");
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("Delete mcp-guard.yml"),
      );
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
      expect(stdoutWriteSpy).toHaveBeenCalledWith(expect.stringContaining("0.1.0"));
    });

    it("shows help text with --help", async () => {
      await main(["node", "cli.js", "--help"]);

      // Commander writes help to stdout
      expect(stdoutWriteSpy).toHaveBeenCalled();
      // Help text should contain the command descriptions
      const allCalls = stdoutWriteSpy.mock.calls
        .map((call) => String(call[0]))
        .join("");
      expect(allCalls).toContain("init");
      expect(allCalls).toContain("start");
      expect(allCalls).toContain("status");
      expect(allCalls).toContain("log");
      expect(allCalls).toContain("uninit");
    });
  });
});
