import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexConfigPlan } from "../../src/codex-config-plan.js";

const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slim-guard-codex-"));
  directories.push(directory);
  return directory;
}
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("buildCodexConfigPlan", () => {
  it("defaults Codex to native without writing configuration", () => {
    const directory = temporaryDirectory();
    const plan = buildCodexConfigPlan(directory);

    expect(plan.server).toMatchObject({ mode: "native", args: ["start", "--mode", "native"] });
    expect(plan.writesPerformed).toBe(0);
  });

  it.each(["compact", "extreme"] as const)("supports the %s Codex mode", (mode) => {
    const plan = buildCodexConfigPlan(temporaryDirectory(), mode);
    expect(plan.server.args).toEqual(["start", "--mode", mode]);
  });
});
