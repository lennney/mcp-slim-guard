import { describe, expect, it } from "vitest";
import { createModeProtocolSuite } from "../../scripts/evaluation/mode-protocol-replay.mjs";

describe("mode protocol replay suite", () => {
  it("binds the existing 24 bilingual tasks to the four-profile evaluation manifest", () => {
    const suite = createModeProtocolSuite();

    expect(suite).toMatchObject({
      schema_version: 1,
      id: "three-modes-24-task",
      kind: "protocol-replay",
      profiles: ["baseline", "native", "compact", "extreme"],
      expected_advertised_tool_counts: {
        baseline: 12,
        native: 13,
        compact: 3,
        extreme: 3,
      },
    });
    expect(suite.fixture_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(suite.cases).toHaveLength(24);
    expect(new Set(suite.cases.map((entry: { language: string }) => entry.language))).toEqual(new Set(["en", "zh"]));
    expect(suite.cases.every((entry: { expected_tool: string }) => !entry.expected_tool.startsWith("fixture_"))).toBe(
      true,
    );
  });
});
