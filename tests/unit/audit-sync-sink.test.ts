import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PolicyContext, PolicyResult } from "../../src/types.js";

const fsState = vi.hoisted(() => ({
  writes: [] as Array<{ fd: number; text: string }>,
  failingDescriptors: new Set<number>(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: ((fd: number, data: string | Uint8Array) => {
      if (fsState.failingDescriptors.has(fd)) throw new Error(`descriptor ${fd} unavailable`);
      const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
      fsState.writes.push({ fd, text });
      return Buffer.byteLength(text);
    }) as typeof actual.writeSync,
  };
});

import { AuditLogger } from "../../src/audit.js";

const context: PolicyContext = {
  toolName: "fixture_tool",
  arguments: {},
  serverName: "fixture",
};
const allowed: PolicyResult = { allowed: true };

describe("AuditLogger synchronous descriptors", () => {
  beforeEach(() => {
    fsState.writes = [];
    fsState.failingDescriptors.clear();
  });

  it("defaults to synchronous stderr and reports a descriptor failure before log returns", () => {
    const logger = new AuditLogger();

    expect(logger.log(context, allowed, [], "s1", 1)).toBe(true);
    expect(fsState.writes).toHaveLength(1);
    expect(fsState.writes[0]).toMatchObject({ fd: 2 });
    expect(fsState.writes.some(({ fd }) => fd === 1)).toBe(false);

    fsState.failingDescriptors.add(2);
    expect(logger.log(context, allowed, [], "s1", 2)).toBe(false);
    expect(fsState.writes).toHaveLength(1);
  });

  it("keeps explicit stdout synchronous and observable", () => {
    const logger = new AuditLogger({ output: "stdout" });

    expect(logger.log(context, allowed, [], "s1", 1)).toBe(true);
    expect(fsState.writes).toHaveLength(1);
    expect(fsState.writes[0]).toMatchObject({ fd: 1 });

    fsState.failingDescriptors.add(1);
    expect(logger.log(context, allowed, [], "s1", 2)).toBe(false);
    expect(fsState.writes).toHaveLength(1);
  });
});
