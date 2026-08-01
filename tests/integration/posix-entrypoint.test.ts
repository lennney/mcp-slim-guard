import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("installed POSIX CLI entrypoint", () => {
  it.runIf(process.platform !== "win32")("starts when invoked through an npm-style symlink", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "mcp-slim-guard-entrypoint-"));
    const cliPath = path.resolve("dist/cli.js");
    const symlinkPath = path.join(tempDir, "mcp-slim-guard");

    try {
      symlinkSync(cliPath, symlinkPath);
      const output = execFileSync(process.execPath, [symlinkPath, "--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });

      expect(output.trim()).toBe("0.1.1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
