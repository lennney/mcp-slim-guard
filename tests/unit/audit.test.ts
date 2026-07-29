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
    logger = new AuditLogger({ level: "silent" });
  });

  it("logs allowed action with action='allowed'", () => {
    expect(logger.log(ctx(), allowed(), [], "s1", 1)).toBe(true);
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("allowed");
  });

  it("logs blocked action with action='blocked' and reason", () => {
    logger.log(
      ctx(),
      blocked("custom reason"),
      [{ policy: "test_policy", result: "block", reason: "custom reason" }],
      "s1",
      1,
    );
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("blocked");
    expect(entries[0].reason).toBe("test_policy blocked request");
  });

  it("getEntries returns all logged entries", () => {
    logger.log(ctx({ toolName: "a" }), allowed(), [], "s1", 1);
    logger.log(ctx({ toolName: "b" }), allowed(), [], "s1", 2);
    logger.log(ctx({ toolName: "c" }), allowed(), [], "s1", 3);
    expect(logger.getEntries()).toHaveLength(3);
  });

  it("clear resets entries", () => {
    logger.log(ctx(), allowed(), [], "s1", 1);
    expect(logger.getEntries()).toHaveLength(1);
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });

  it("timestamp is valid ISO 8601", () => {
    logger.log(ctx(), allowed(), [], "s1", 1);
    const ts = logger.getEntries()[0].timestamp;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });

  it("durationMs is recorded when provided", () => {
    logger.log(ctx(), allowed(), [], "s1", 1, 42);
    expect(logger.getEntries()[0].durationMs).toBe(42);
  });

  it("durationMs is undefined when not provided", () => {
    logger.log(ctx(), allowed(), [], "s1", 1);
    expect(logger.getEntries()[0].durationMs).toBeUndefined();
  });

  it("captures serverName and toolName correctly", () => {
    logger.log(
      ctx({ toolName: "search_repos", serverName: "github" }),
      blocked("not allowed"),
      [{ policy: "whitelist", result: "block", reason: "not allowed" }],
      "s1",
      1,
    );
    const entry = logger.getEntries()[0];
    expect(entry.serverName).toBe("github");
    expect(entry.toolName).toBe("search_repos");
  });

  it("keeps tool arguments content-free for every shape", () => {
    // empty arguments
    logger.log(ctx({ arguments: {} }), allowed(), [], "s1", 1);
    expect(logger.getEntries()[0].arguments).toEqual({});

    // nested arguments
    logger.log(ctx({ arguments: { nested: { key: "deep", num: 1 } } }), allowed(), [], "s1", 2);
    expect(logger.getEntries()[1].arguments).toEqual({});

    // null values
    logger.log(ctx({ arguments: { a: null, b: "str" } }), allowed(), [], "s1", 3);
    expect(logger.getEntries()[2].arguments).toEqual({});
  });

  it("omits credential-like and ordinary argument fields alike", () => {
    logger.log(
      ctx({
        arguments: {
          token: "top-secret",
          nested: {
            api_key: "key-value",
            safe: "visible",
            headers: { Authorization: "Bearer secret" },
          },
          tool_ref: "tool-capability",
          result_ref: "result-capability",
          entries: [{ password: "p@ss" }, { value: 1 }],
        },
      }),
      allowed(),
      [],
      "s1",
      1,
    );

    expect(logger.getEntries()[0].arguments).toEqual({});
  });

  it("records correlated stage outcomes with redacted metadata", () => {
    logger.log(ctx(), allowed(), [], "s1", 1, 7, {
      traceId: "t_test",
      event: "upstream",
      outcome: "upstream_error",
      metadata: {
        result_ref: "result-capability",
        referenceId: "safe-digest",
        isError: true,
      },
    });

    expect(logger.getEntries()[0]).toMatchObject({
      traceId: "t_test",
      event: "upstream",
      outcome: "upstream_error",
      action: "allowed",
      metadata: {
        result_ref: "[REDACTED]",
        referenceId: "safe-digest",
        isError: true,
      },
    });
  });

  it("does not block execution when the configured audit sink throws", () => {
    (
      logger as unknown as {
        logger: { info(): never };
      }
    ).logger = {
      info() {
        throw new Error("audit sink unavailable");
      },
    };

    expect(
      logger.log(ctx(), allowed(), [], "s1", 1, 1, {
        traceId: "t_non_blocking",
        event: "upstream",
        outcome: "success",
      }),
    ).toBe(false);
    expect(() => logger.logDiscovery("s1", 2, "projection", 3, ["find_tool"])).not.toThrow();
    expect(logger.getEntries()).toHaveLength(2);
  });

  it("excludes complete tool arguments and credential values by default", () => {
    const credential = "Bearer FAKE_AUDIT_CREDENTIAL_1234567890";

    logger.log(
      ctx({
        arguments: {
          message: credential,
          project: "private-project-name",
          nested: { ordinaryKey: "private-value" },
        },
      }),
      allowed(),
      [],
      "s1",
      1,
    );

    const entry = logger.getEntries()[0];
    expect(entry.arguments).toEqual({});
    expect(JSON.stringify(entry)).not.toContain(credential);
    expect(JSON.stringify(entry)).not.toContain("private-project-name");
    expect(JSON.stringify(entry)).not.toContain("private-value");
  });

  it("handles multiple sequential logs correctly", () => {
    const items = [
      { toolName: "tool_1", action: "allowed" as const },
      { toolName: "tool_2", action: "blocked" as const },
      { toolName: "tool_3", action: "blocked" as const },
      { toolName: "tool_4", action: "allowed" as const },
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.action === "allowed") {
        logger.log(ctx({ toolName: item.toolName }), allowed(), [], "s1", i + 1);
      } else {
        logger.log(ctx({ toolName: item.toolName }), blocked(), [{ policy: "test", result: "block" }], "s1", i + 1);
      }
    }

    const entries = logger.getEntries();
    expect(entries).toHaveLength(4);
    for (let i = 0; i < items.length; i++) {
      expect(entries[i].toolName).toBe(items[i].toolName);
      expect(entries[i].action).toBe(items[i].action);
    }
  });

  it("file output mode creates the file with valid JSON content", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    const filePath = join(tmpDir, "audit.log");

    const fileLogger = new AuditLogger({
      output: "file",
      filePath,
      level: "info",
    });

    expect(fileLogger.log(ctx(), allowed(), [], "s1", 1, 15)).toBe(true);

    // Flush and close the logger to ensure data is written
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
      expect(parsed).toHaveProperty("sessionId", "s1");
      expect(parsed).toHaveProperty("requestId", 1);
      expect(parsed).toHaveProperty("durationMs", 15);
    }

    await expect(fileLogger.close()).resolves.toBeUndefined();
    await expect(fileLogger.close()).resolves.toBeUndefined();

    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a closed file destination before log returns", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "audit-closed-test-"));
    const fileLogger = new AuditLogger({
      output: "file",
      filePath: join(tmpDir, "audit.log"),
      level: "info",
    });

    await fileLogger.close();

    expect(fileLogger.log(ctx(), allowed(), [], "s1", 1)).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("newSession generates unique session IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const id = logger.newSession();
      expect(ids.has(id)).toBe(false);
      expect(id).toMatch(/^s\d+_[a-f0-9]{32}$/);
      ids.add(id);
    }
  });

  it("newTrace generates opaque unique trace IDs", () => {
    const first = logger.newTrace();
    const second = logger.newTrace();

    expect(first).toMatch(/^t_[a-f0-9]{32}$/);
    expect(second).toMatch(/^t_[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  it("logDiscovery records discovery events", () => {
    logger.logDiscovery("s_test", 0, "search", 8, ["search_free_search", "search_free_extract"]);
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe("discovery");
    expect(entries[0].event).toBe("discovery");
    expect(entries[0].outcome).toBe("success");
    expect(entries[0].toolName).toBe("tools/list");
    expect(entries[0].arguments).toEqual({ count: 8, tools: ["search_free_search", "search_free_extract"] });
  });

  it("decisionTrail is recorded for blocked calls", () => {
    const trail = [{ policy: "ssrf", result: "block" as const, reason: "private IP" }];
    logger.log(ctx(), blocked("private IP"), trail, "s1", 1);
    const entry = logger.getEntries()[0];
    expect(entry.decisionTrail).toEqual([{ policy: "ssrf", result: "block" }]);
  });
});
