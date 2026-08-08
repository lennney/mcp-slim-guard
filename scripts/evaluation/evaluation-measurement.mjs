import { createHash } from "node:crypto";
import { get_encoding } from "tiktoken";

const RESULT_REF_PATTERN = /result_[a-f0-9]{32}/gu;
const TOOL_REF_PATTERN = /tool_[a-f0-9]{16}_\d+/gu;
const CATALOG_DIGEST_PATTERN = /"catalog_digest":"[a-f0-9]{64}"/gu;

export function normalizedEvaluationWire(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return "";
  return serialized
    .replace(RESULT_REF_PATTERN, `result_${"0".repeat(32)}`)
    .replace(TOOL_REF_PATTERN, "tool_0000000000000000_0")
    .replace(CATALOG_DIGEST_PATTERN, `"catalog_digest":"${"0".repeat(64)}"`);
}

export function evaluationSha256(value) {
  const input = typeof value === "string" ? value : normalizedEvaluationWire(value);
  return createHash("sha256").update(input).digest("hex");
}

export function createEvaluationMeasurement(tokenizerName = "o200k_base") {
  const tokenizer = get_encoding(tokenizerName);
  return {
    tokenizer: tokenizerName,
    normalizedWire: normalizedEvaluationWire,
    sha256: evaluationSha256,
    tokens(value) {
      const input = typeof value === "string" ? value : normalizedEvaluationWire(value);
      return tokenizer.encode(input).length;
    },
    close() {
      tokenizer.free();
    },
  };
}
