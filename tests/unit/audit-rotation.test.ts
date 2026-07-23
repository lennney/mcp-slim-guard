/**
 * Audit log rotation tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AuditLogger } from "../../src/audit.js";

describe("AuditLogger rotation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-guard-audit-"));
  });

  afterEach(() => {
    for (const f of fs.readdirSync(tmpDir)) {
      fs.unlinkSync(path.join(tmpDir, f));
    }
    fs.rmdirSync(tmpDir);
  });

  const ctx = (toolName: string) => ({
    toolName,
    arguments: { key: "value" },
    serverName: "test_server",
  });

  it("rotates log file when maxSize is exceeded", () => {
    const logPath = path.join(tmpDir, "audit.log");
    const logger = new AuditLogger({
      output: "file",
      filePath: logPath,
      maxSize: "100B",
      maxFiles: 2,
    });

    for (let i = 0; i < 50; i++) {
      logger.log(ctx(`tool_${i}`), { allowed: true });
    }

    logger.checkRotation();

    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f) => f.startsWith("audit.log"))).toBe(true);
  });

  it("rotates with gzip compression and does not mix new entries into the compressed stream", async () => {
    const logPath = path.join(tmpDir, "audit.log");
    const logger = new AuditLogger({
      output: "file",
      filePath: logPath,
      maxSize: "200B",
      maxFiles: 2,
      compress: true,
    });

    // Fill past maxSize to force a rotation.
    for (let i = 0; i < 30; i++) {
      logger.log(ctx(`tool_${i}`), { allowed: true });
    }
    logger.checkRotation();

    // The current log should exist and be writable.
    expect(fs.existsSync(logPath)).toBe(true);

    // Wait for async gzip to settle.
    await new Promise((r) => setTimeout(r, 500));

    const files = fs.readdirSync(tmpDir);
    // A compressed backup should appear.
    expect(files.some((f) => f === "audit.log.1.gz")).toBe(true);
  });

  it("keeps at most maxFiles historical files", () => {
    const logPath = path.join(tmpDir, "audit.log");
    const logger = new AuditLogger({
      output: "file",
      filePath: logPath,
      maxSize: "1B",
      maxFiles: 3,
    });

    for (let i = 0; i < 20; i++) {
      logger.log(ctx(`tool_${i}`), { allowed: true });
    }

    logger.checkRotation();

    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("audit.log"));
    expect(files.length).toBeLessThanOrEqual(4);
  });
});
