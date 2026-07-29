import { describe, expect, it } from "vitest";
import { scoreSecurityCorpus, wilson } from "../../scripts/evaluation/security-accuracy-core.mjs";

describe("security accuracy evaluation", () => {
  it("computes bounded Wilson intervals", () => {
    expect(wilson(0, 400)).toMatchObject({ estimate: 0, lower_95: 0 });
    expect(wilson(0, 400).upper_95).toBeLessThan(0.01);
    expect(wilson(80, 80).lower_95).toBeGreaterThan(0.95);
  });

  it("keeps redaction report-only when a clean result is flagged", () => {
    const score = scoreSecurityCorpus(
      [{ expected: [] }, { expected: ["credential"] }],
      [{ findings: [{ kind: "credential" }] }, { findings: [{ kind: "credential" }] }],
    );
    expect(score.auto_redaction_recommendation).toBe("remain-report-only-and-tune-detector");
  });
});
