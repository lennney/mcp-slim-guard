import { describe, it, expect } from "vitest";
import { PolicyPipeline } from "../../../src/policies/base.js";
import type { Policy, PolicyContext, PolicyResult } from "../../../src/types.js";

describe("PolicyPipeline", () => {
  it("allows when all policies pass", async () => {
    const allowAll: Policy = {
      name: "allow_all",
      phase: "tool_call",
      async check(_ctx: PolicyContext): Promise<PolicyResult> {
        return { allowed: true };
      },
    };
    const pipeline = new PolicyPipeline([allowAll, allowAll]);
    const result = await pipeline.execute({
      toolName: "test_tool",
      arguments: {},
      serverName: "test",
    });
    expect(result.allowed).toBe(true);
  });

  it("short-circuits on first deny", async () => {
    let secondCalled = false;

    const deny: Policy = {
      name: "deny_first",
      phase: "tool_call",
      async check(_ctx: PolicyContext): Promise<PolicyResult> {
        return { allowed: false, reason: "denied", policy: "deny_first" };
      },
    };

    const track: Policy = {
      name: "track",
      phase: "tool_call",
      async check(_ctx: PolicyContext): Promise<PolicyResult> {
        secondCalled = true;
        return { allowed: true };
      },
    };

    const pipeline = new PolicyPipeline([deny, track]);
    const result = await pipeline.execute({
      toolName: "test",
      arguments: {},
      serverName: "test",
    });

    // TypeScript discriminated union narrowing
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toBe("denied");
    }
    expect(secondCalled).toBe(false); // 短路：第二个未执行
  });

  it("reports policy names", () => {
    const a: Policy = {
      name: "a",
      phase: "tool_call",
      async check() {
        return { allowed: true };
      },
    };
    const b: Policy = {
      name: "b",
      phase: "tool_call",
      async check() {
        return { allowed: true };
      },
    };
    const pipeline = new PolicyPipeline([a, b]);
    expect(pipeline.getPolicyNames()).toEqual(["a", "b"]);
  });

  it("handles empty pipeline", async () => {
    const pipeline = new PolicyPipeline([]);
    const result = await pipeline.execute({
      toolName: "test",
      arguments: {},
      serverName: "test",
    });
    expect(result.allowed).toBe(true);
  });

  it("executeWithTrail records allowed-with-reason as a warn step", async () => {
    const warnPolicy: Policy = {
      name: "ssrf_log",
      phase: "tool_call",
      async check(_ctx: PolicyContext): Promise<PolicyResult> {
        return { allowed: true, reason: "SSRF log: private IP hit" };
      },
    };
    const passPolicy: Policy = {
      name: "ratelimit",
      phase: "tool_call",
      async check(_ctx: PolicyContext): Promise<PolicyResult> {
        return { allowed: true };
      },
    };
    const pipeline = new PolicyPipeline([warnPolicy, passPolicy]);
    const { result, trail } = await pipeline.executeWithTrail({
      toolName: "t",
      arguments: { url: "http://10.0.0.1" },
      serverName: "s",
    });
    // 仍允许通过
    expect(result.allowed).toBe(true);
    // 第一个策略记为 warn（带 reason），第二个记为 pass
    expect(trail).toEqual([
      { policy: "ssrf_log", result: "warn", reason: "SSRF log: private IP hit" },
      { policy: "ratelimit", result: "pass" },
    ]);
  });
});
