export function wilson(successes, total, z = 1.959963984540054) {
  if (total === 0) return { estimate: null, lower_95: null, upper_95: null };
  const estimate = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = estimate + (z * z) / (2 * total);
  const spread = z * Math.sqrt((estimate * (1 - estimate) + (z * z) / (4 * total)) / total);
  return {
    estimate,
    lower_95: successes === 0 ? 0 : Math.max(0, (centre - spread) / denominator),
    upper_95: successes === total ? 1 : Math.min(1, (centre + spread) / denominator),
  };
}

export function scoreSecurityCorpus(samples, assessments) {
  if (samples.length !== assessments.length) throw new Error("samples and assessments must have equal length");
  const kinds = ["credential", "personal_data", "untrusted_instruction"];
  const byKind = {};
  for (const kind of kinds) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    samples.forEach((sample, index) => {
      const expected = sample.expected.includes(kind);
      const actual = assessments[index].findings.some((finding) => finding.kind === kind);
      if (expected && actual) tp++;
      else if (!expected && actual) fp++;
      else if (expected) fn++;
      else tn++;
    });
    byKind[kind] = {
      confusion: { tp, fp, fn, tn },
      precision: wilson(tp, tp + fp),
      recall: wilson(tp, tp + fn),
      false_positive_rate: wilson(fp, fp + tn),
    };
  }
  const credential = byKind.credential;
  const cleanCredentialFalsePositives = samples.filter(
    (sample, index) =>
      sample.expected.length === 0 && assessments[index].findings.some((finding) => finding.kind === "credential"),
  ).length;
  return {
    by_kind: byKind,
    auto_redaction_recommendation:
      cleanCredentialFalsePositives === 0 && credential.confusion.fn === 0 && credential.precision.lower_95 >= 0.95
        ? "eligible-for-separate-recoverable-credential-redaction-design"
        : "remain-report-only-and-tune-detector",
    clean_credential_false_positives: cleanCredentialFalsePositives,
  };
}
