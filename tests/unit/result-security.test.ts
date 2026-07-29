import { describe, expect, it } from "vitest";
import { ResultSecurityInspector } from "../../src/result-security.js";

describe("ResultSecurityInspector", () => {
  it("detects sensitive key values and exposes only their digest", () => {
    const secret = "not-a-pattern-but-still-sensitive";
    const assessment = new ResultSecurityInspector().inspect({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { api_key: secret },
    });

    expect(assessment.findings).toHaveLength(1);
    expect(assessment.findings[0]).toMatchObject({
      kind: "credential",
      severity: "high",
      path: "$.structuredContent.api_key",
    });
    expect(JSON.stringify(assessment)).not.toContain(secret);
  });

  it("does not label ordinary tool output as a finding", () => {
    const assessment = new ResultSecurityInspector().inspect({
      content: [{ type: "text", text: "Build completed successfully." }],
    });

    expect(assessment).toEqual({
      inspected: true,
      findings: [],
      obligations: [],
    });
  });
});
