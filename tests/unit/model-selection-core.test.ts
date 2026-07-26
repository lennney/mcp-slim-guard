import { describe, expect, it } from "vitest";
import {
  pairedBootstrap,
  redactCapture,
  summarizeModelRuns,
  validateModelOutcome,
} from "../../scripts/evaluation/model-selection-core.mjs";

const scenario = {
  tool: "search_catalog",
  required: ["query", "locale"],
  values: { query: "adapter", locale: "en" },
  marker: "CATALOG:adapter:en",
};

describe("model selection evaluation", () => {
  it("scores tool, arguments, and actual marker separately", () => {
    expect(
      validateModelOutcome(
        {
          selected_tool: "search_catalog",
          arguments: { query: "adapter", locale: "en" },
          marker: "not a tool result",
        },
        scenario,
      ),
    ).toEqual({
      selected_tool_correct: true,
      first_arguments_valid: true,
      task_success: false,
      reason: "missing fixture marker",
    });
  });

  it("produces a deterministic paired interval", () => {
    expect(pairedBootstrap([1, 1, 0, 1], [1, 1, 1, 1], 1000)).toEqual(
      pairedBootstrap([1, 1, 0, 1], [1, 1, 1, 1], 1000),
    );
  });

  it("redacts captures and counts infrastructure failures", () => {
    expect(redactCapture("Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(
      summarizeModelRuns([
        { status: "completed", profile: "baseline", score: { selected_tool_correct: true, first_arguments_valid: true, task_success: true } },
        { status: "error", profile: "slim-guard" },
      ]),
    ).toMatchObject({ attempted: 2, completed: 1, infrastructure_errors: 1 });
  });
});
