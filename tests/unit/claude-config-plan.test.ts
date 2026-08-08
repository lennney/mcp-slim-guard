import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeConfigPlan } from "../../src/claude-config-plan.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-claude-"));
  directories.push(directory);
  return directory;
}
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("buildClaudeConfigPlan", () => {
  it("defaults Claude Code to compact without writing configuration", () => {
    const plan = buildClaudeConfigPlan(temporaryDirectory());
    expect(plan.server).toMatchObject({ mode: "compact", args: ["start", "--mode", "compact"] });
    expect(plan.writesPerformed).toBe(0);
  });

  it("supports the verified extreme Claude Code plan", () => {
    const plan = buildClaudeConfigPlan(temporaryDirectory(), "extreme");
    expect(plan.server.args).toEqual(["start", "--mode", "extreme"]);
  });
});
