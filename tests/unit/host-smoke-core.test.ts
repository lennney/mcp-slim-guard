import { describe, expect, it, vi } from "vitest";
import { runHostSmoke } from "../../scripts/integration/host-smoke-core.mjs";

describe("host smoke runner", () => {
  it("passes only an exact marker and always cleans up", async () => {
    const cleanup = vi.fn();
    const result = await runHostSmoke(
      {
        name: "fake",
        run: async () => ({
          tools: ["find_tool", "call_tool", "read_result"],
          marker: "CATALOG:adapter:en",
        }),
        cleanup,
      },
      {},
      { marker: "CATALOG:adapter:en" },
    );
    expect(result.status).toBe("passed");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("records a timeout instead of discarding it", async () => {
    const result = await runHostSmoke(
      {
        name: "slow",
        run: (_definition: unknown, _expectation: unknown, signal: AbortSignal) =>
          new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      },
      {},
      { marker: "expected" },
      5,
    );
    expect(result.status).toBe("timeout");
  });
});
