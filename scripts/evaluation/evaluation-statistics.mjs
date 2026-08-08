import { createHash } from "node:crypto";

function seededRandom(seed) {
  let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16);
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function pairedBootstrap(baseline, candidate, iterations = 10_000, seed = "slim-guard-host-task-v1") {
  if (baseline.length !== candidate.length || baseline.length === 0) return null;
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
  differences.sort((left, right) => left - right);
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

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * fraction)];
}
