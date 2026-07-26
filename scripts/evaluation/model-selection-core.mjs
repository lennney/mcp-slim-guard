import { createHash } from "node:crypto";

export function validateModelOutcome(outcome, scenario) {
  if (!outcome || typeof outcome !== "object") {
    return { selected_tool_correct: false, first_arguments_valid: false, task_success: false, reason: "invalid outcome" };
  }
  const selectedTool = String(outcome.selected_tool ?? "");
  const args = outcome.arguments && typeof outcome.arguments === "object" ? outcome.arguments : {};
  const selectedToolCorrect =
    selectedTool === scenario.tool || selectedTool.endsWith(`_${scenario.tool}`);
  const requiredValid = scenario.required.every((name) => name in args);
  const valuesValid = Object.entries(scenario.values).every(([name, value]) =>
    name in args ? JSON.stringify(args[name]).includes(String(value)) : false,
  );
  const marker = String(outcome.marker ?? "");
  return {
    selected_tool_correct: selectedToolCorrect,
    first_arguments_valid: selectedToolCorrect && requiredValid && valuesValid,
    task_success: marker.includes(scenario.marker),
    reason: selectedToolCorrect
      ? requiredValid && valuesValid
        ? marker.includes(scenario.marker)
          ? ""
          : "missing fixture marker"
        : "invalid arguments"
      : "wrong tool",
  };
}

export function redactCapture(value) {
  return String(value)
    .replace(/(?:sk-|gh[pousr]_)[a-z0-9_-]{12,}/giu, "[REDACTED_CREDENTIAL]")
    .replace(/Bearer\s+[a-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]")
    .replace(/result_[a-f0-9]{32}/gu, "result_[REDACTED]")
    .replace(/[a-f0-9]{64}/gu, "[SHA256]");
}

function seededRandom(seed) {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function pairedBootstrap(baseline, candidate, iterations = 10_000, seed = "slim-guard-model-selection-v1") {
  if (baseline.length !== candidate.length || baseline.length === 0) {
    throw new Error("pairedBootstrap requires equal non-empty samples");
  }
  const random = seededRandom(seed);
  const differences = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let difference = 0;
    for (let index = 0; index < baseline.length; index++) {
      const sampled = Math.floor(random() * baseline.length);
      difference += Number(candidate[sampled]) - Number(baseline[sampled]);
    }
    differences.push(difference / baseline.length);
  }
  differences.sort((a, b) => a - b);
  const quantile = (fraction) => differences[Math.floor((differences.length - 1) * fraction)];
  return {
    estimate:
      candidate.reduce((sum, value) => sum + Number(value), 0) / candidate.length -
      baseline.reduce((sum, value) => sum + Number(value), 0) / baseline.length,
    lower_95: quantile(0.025),
    upper_95: quantile(0.975),
    iterations,
  };
}

export function summarizeModelRuns(runs) {
  const completed = runs.filter((run) => run.status === "completed");
  const byProfile = Object.fromEntries(
    ["baseline", "slim-guard"].map((profile) => {
      const selected = completed.filter((run) => run.profile === profile);
      const rate = (field) =>
        selected.length === 0
          ? null
          : selected.filter((run) => run.score[field]).length / selected.length;
      return [
        profile,
        {
          completed: selected.length,
          selected_tool_accuracy: rate("selected_tool_correct"),
          first_valid_argument_rate: rate("first_arguments_valid"),
          task_success_rate: rate("task_success"),
        },
      ];
    }),
  );
  return { attempted: runs.length, completed: completed.length, infrastructure_errors: runs.length - completed.length, by_profile: byProfile };
}
