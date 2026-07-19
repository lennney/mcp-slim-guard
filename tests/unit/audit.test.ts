import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AuditLogger } from "../../src/audit.js";
import type { PolicyContext, PolicyResult } from "../../src/types.js";

/** 创建测试用的策略上下文 */
function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    toolName: "test_tool",
    arguments: { key: "value" },
    serverName: "test_server",
    ...overrides,
  };
}

/** 创建允许的结果 */
function allowed(): PolicyResult {
  return { allowed: true };
}

/** 创建阻止的结果 */
function blocked(reason = "blocked by policy"): PolicyResult {
  return { allowed: false, reason, policy: "test_policy" };
}

describe("AuditLogger", () => {
  let logger: AuditLogger;

  beforeEach(() => {
    logger = new AuditLogger();
  });

  it("logs allowed action with action='allowed'", () => {
    logger.log(ctx(), allowed());
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("allowed");
  });

  it("logs blocked action with action='blocked' and reason", () => {
    logger.log(ctx(), blocked("custom reason"));
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("blocked");
    expect(entries[0].reason).toBe("custom reason");
  });

  it("getEntries returns all logged entries", () => {
    logger.log(ctx({ toolName: "a" }), allowed());
    logger.log(ctx({ toolName: "b" }), allowed());
    logger.log(ctx({ toolName: "c" }), allowed());
    expect(logger.getEntries()).toHaveLength(3);
  });

  it("clear resets entries", () => {
    logger.log(ctx(), allowed());
    expect(logger.getEntries()).toHaveLength(1);
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("timestamp is valid ISO 8601", () => {
    logger.log(ctx(), allowed());
    const ts = logger.getEntries()[0].timestamp;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("durationMs is recorded when provided", () => {
    logger.log(ctx(), allowed(), 42);
    expect(logger.getEntries()[0].durationMs).toBe(42);
  });

  it("durationMs is undefined when not provided", () => {
    logger.log(ctx(), allowed());
    expect(logger.getEntries()[0].durationMs).toBeUndefined();
  });

  it("captures serverName and toolName correctly", () => {
    logger.log(
      ctx({ toolName: "search_repos", serverName: "github" }),
      blocked("not allowed"),
    );
    const entry = logger.getEntries()[0];
    expect(entry.serverName).toBe("github");
    expect(entry.toolName).toBe("search_repos");
  });

  it("captures arguments including edge cases", () => {
    // empty arguments
    logger.log(ctx({ arguments: {} }), allowed());
    expect(logger.getEntries()[0].arguments).toEqual({});

    // nested arguments
    logger.log(
      ctx({ arguments: { nested: { key: "deep", num: 1 } } }),
      allowed(),
    );
    expect(logger.getEntries()[1].arguments).toEqual({
      nested: { key: "deep", num: 1 },
    });

    // null values
    logger.log(ctx({ arguments: { a: null, b: "str" } }), allowed());
    expect(logger.getEntries()[2].arguments).toEqual({ a: null, b: "str" });
  });

  it("handles multiple sequential logs correctly", () => {
    const items = [
      { toolName: "tool_1", action: "allowed" as const },
      { toolName: "tool_2", action: "blocked" as const },
      { toolName: "tool_3", action: "blocked" as const },
      { toolName: "tool_4", action: "allowed" as const },
    ];

    for (const item of items) {
      if (item.action === "allowed") {
        logger.log(ctx({ toolName: item.toolName }), allowed());
      } else {
        logger.log(ctx({ toolName: item.toolName }), blocked());
      }
    }

    const entries = logger.getEntries();
    expect(entries).toHaveLength(4);
    for (let i = 0; i < items.length; i++) {
      expect(entries[i].toolName).toBe(items[i].toolName);
      expect(entries[i].action).toBe(items[i].action);
    }
  });

  it("file output mode creates the file with valid JSON content", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const filePath = join(tmpDir, "audit.log");

    const fileLogger = new AuditLogger({
      output: "file",
      filePath,
      level: "info",
    });

    fileLogger.log(ctx(), allowed(), 15);

    // Flush and close the logger to ensure data is written
    // Use pino's flush to force pending writes
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8").trim();
    expect(content.length).toBeGreaterThan(0);

    // Should be valid JSON lines
    const lines = content.split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty("timestamp");
      expect(parsed).toHaveProperty("toolName", "test_tool");
      expect(parsed).toHaveProperty("serverName", "test_server");
      expect(parsed).toHaveProperty("action", "allowed");
      expect(parsed).toHaveProperty("durationMs", 15);
    }

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
