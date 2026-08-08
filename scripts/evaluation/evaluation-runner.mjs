import { createEvaluationMeasurement, evaluationSha256, normalizedEvaluationWire } from "./evaluation-measurement.mjs";
import { pairedBootstrap, percentile } from "./evaluation-statistics.mjs";

export const EVALUATION_REPORT_SCHEMA_VERSION = 1;
export const EVALUATION_SUITE_SCHEMA_VERSION = 1;

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const SUITE_KINDS = new Set([
  "protocol-replay",
  "result-projection",
  "selective-retrieval",
  "tool-retrieval",
  "stress",
  "host-task",
]);
const HOST_ARMS = new Set(["direct", "oracle", "native", "compact", "extreme"]);
const HOST_CORE_ARMS = ["direct", "compact", "extreme"];
const RETRYABLE_INFRASTRUCTURE_ERRORS = new Set(["rate_limit", "network", "host_startup"]);
const INFRASTRUCTURE_ERRORS = new Set([
  ...RETRYABLE_INFRASTRUCTURE_ERRORS,
  "host_runtime",
  "adapter_exception",
  "adapter_cleanup",
  "timeout",
]);
const HOST_STATUSES = new Set(["completed", "product_error", "infrastructure_error"]);
const UNKNOWN_DIGEST = "0".repeat(64);
function digest(value) {
  return evaluationSha256(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalDigest(value) {
  return digest(canonicalJson(value));
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function validateRequest(request) {
  assertObject(request, "evaluation request");
  assertObject(request.suite, "suite");
  if (request.suite.schema_version !== EVALUATION_SUITE_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported evaluation suite schema version: ${request.suite.schema_version}`);
  }
  if (!SUITE_KINDS.has(request.suite.kind)) {
    throw new TypeError(`Unsupported evaluation suite kind: ${request.suite.kind}`);
  }
  const hostTask = request.suite.kind === "host-task";
  if (!hostTask || request.suite.fixture_digest !== undefined) {
    assertDigest(request.suite.fixture_digest, "suite.fixture_digest");
  }
  if (!Array.isArray(request.suite.profiles) || request.suite.profiles.length === 0) {
    throw new TypeError("suite.profiles must not be empty");
  }
  if (!Array.isArray(request.suite.cases) || request.suite.cases.length === 0) {
    throw new TypeError("suite.cases must not be empty");
  }

  if (hostTask && request.suite.profiles.some((profile) => !HOST_ARMS.has(profile))) {
    throw new TypeError("host-task profiles must be evaluation arms");
  }

  if (hostTask && request.suite.required_evidence !== undefined) {
    assertObject(request.suite.required_evidence, "host-task suite.required_evidence");
    const toolSearchArms = request.suite.required_evidence.tool_search_arms;
    if (
      !Array.isArray(toolSearchArms) ||
      toolSearchArms.length === 0 ||
      new Set(toolSearchArms).size !== toolSearchArms.length ||
      toolSearchArms.some((arm) => !request.suite.profiles.includes(arm))
    ) {
      throw new TypeError("host-task required_evidence.tool_search_arms must contain unique selected arms");
    }
    for (const suiteCase of request.suite.cases) {
      if (suiteCase.expected_no_match === true) continue;
      const expectedTool = suiteCase.expected_tool;
      const expectedSchema =
        suiteCase.tool_schemas?.[expectedTool]?.inputSchema ?? suiteCase.tool_schemas?.[expectedTool]?.input_schema;
      if (typeof expectedTool !== "string" || !expectedSchema || typeof expectedSchema !== "object") {
        throw new TypeError(
          `host-task Tool Search case ${suiteCase.id} must provide expected_tool and its original input schema`,
        );
      }
    }
  }

  if (request.suite.kind === "tool-retrieval") {
    assertDigest(request.suite.corpus_digest, "suite.corpus_digest");
    if (
      !Array.isArray(request.suite.pool_sizes) ||
      request.suite.pool_sizes.length === 0 ||
      new Set(request.suite.pool_sizes).size !== request.suite.pool_sizes.length ||
      request.suite.pool_sizes.some((value) => !Number.isInteger(value) || value < 1)
    ) {
      throw new TypeError("tool-retrieval suite.pool_sizes must contain unique positive integers");
    }
    for (const suiteCase of request.suite.cases) {
      assertDigest(suiteCase.task_digest, `tool-retrieval case ${suiteCase.id} task_digest`);
      if (typeof suiteCase.language !== "string" || typeof suiteCase.retrieval_cohort !== "string") {
        throw new TypeError(`tool-retrieval case ${suiteCase.id} language and retrieval_cohort are required`);
      }
      assertObject(suiteCase.catalog_digests, `tool-retrieval case ${suiteCase.id} catalog_digests`);
      for (const poolSize of request.suite.pool_sizes) {
        assertDigest(
          suiteCase.catalog_digests[String(poolSize)],
          `tool-retrieval case ${suiteCase.id} catalog digest for ${poolSize}`,
        );
      }
      const noMatch = suiteCase.expected_no_match === true;
      if (noMatch) {
        if (suiteCase.expected_tool !== undefined || suiteCase.expected_schema_sha256 !== undefined) {
          throw new TypeError(`tool-retrieval no-match case ${suiteCase.id} must not define a positive Tool`);
        }
      } else {
        if (typeof suiteCase.expected_tool !== "string" || !suiteCase.expected_tool) {
          throw new TypeError(`tool-retrieval positive case ${suiteCase.id} expected_tool is required`);
        }
        assertDigest(
          suiteCase.expected_schema_sha256,
          `tool-retrieval positive case ${suiteCase.id} expected_schema_sha256`,
        );
      }
      if (!Array.isArray(suiteCase.denied_tools)) {
        throw new TypeError(`tool-retrieval case ${suiteCase.id} denied_tools are required`);
      }
    }
  }

  if (!hostTask || request.candidate !== undefined) {
    assertObject(request.candidate, "candidate");
    assertDigest(request.candidate.digest, "candidate.digest");
    if (typeof request.candidate.kind !== "string" || typeof request.candidate.package_version !== "string") {
      throw new TypeError("candidate kind and package_version are required");
    }
  }

  assertObject(request.environment, "environment");
  for (const field of ["node", "platform", "arch", "tokenizer"]) {
    if (typeof request.environment[field] !== "string" || !request.environment[field]) {
      throw new TypeError(`environment.${field} is required`);
    }
  }

  assertObject(request.adapter, "adapter");
  if (typeof request.adapter.id !== "string" || typeof request.adapter.run !== "function") {
    throw new TypeError("adapter id and run() are required");
  }
}

function gate(expected, actual, passed) {
  return { passed, expected, actual };
}

function summarize(results) {
  return {
    tasks: results.length,
    successful_tasks: results.filter((result) => result.success).length,
    protocol_events: results.reduce((sum, result) => sum + result.protocol_events, 0),
    upstream_calls: results.reduce((sum, result) => sum + result.upstream_calls, 0),
    exact_recoveries: results.filter((result) => result.exact_recovery).length,
    advertised_tool_counts: [...new Set(results.map((result) => result.advertised_tool_count))],
    total_tokens: results.reduce((sum, result) => sum + result.total_tokens, 0),
    recovery_verification_tokens: results.reduce((sum, result) => sum + result.recovery_verification_tokens, 0),
    total_with_recovery_verification_tokens: results.reduce(
      (sum, result) => sum + result.total_with_recovery_verification_tokens,
      0,
    ),
  };
}

function reduction(reference, candidate) {
  if (reference === 0) return 0;
  return Number((((reference - candidate) / reference) * 100).toFixed(2));
}

function containsProjection(events) {
  for (const event of events) {
    if (event.kind !== "invoke") continue;
    const block = event.response?.content?.[0];
    if (!block || block.type !== "text") continue;
    try {
      const value = JSON.parse(block.text);
      if (typeof value?.result_ref === "string" && value.replay_cursor !== undefined) return true;
    } catch {
      // Exact pass-through text is not a projection capsule.
    }
  }
  return false;
}

function deriveObservation(raw, suiteCase, measurement) {
  const events = Array.isArray(raw.events) ? raw.events : [];
  const upstreamInvocations = Array.isArray(raw.upstream_invocations) ? raw.upstream_invocations : [];
  const advertisedTools = Array.isArray(raw.advertised_tools) ? raw.advertised_tools : [];
  const eventMeasurements = events.map((event) => {
    const requestWire = normalizedEvaluationWire(event.request);
    const responseWire = normalizedEvaluationWire(event.response);
    const requestTokens = measurement.tokens(requestWire);
    const responseTokens = measurement.tokens(responseWire);
    return {
      kind: event.kind,
      request_chars: requestWire.length,
      response_chars: responseWire.length,
      request_tokens: requestTokens,
      response_tokens: responseTokens,
      total_tokens: requestTokens + responseTokens,
      request_sha256: digest(requestWire),
      response_sha256: digest(responseWire),
    };
  });
  const finalResultWire = normalizedEvaluationWire(raw.final_result);
  const expectedInvocation =
    upstreamInvocations.length === 1 && upstreamInvocations[0]?.tool === suiteCase.expected_tool;
  const markerFound = finalResultWire.includes(suiteCase.expected_marker);
  const recoveryHash =
    raw.recovered_result === null || raw.recovered_result === undefined ? null : digest(raw.recovered_result?.content);
  const resultHash = digest(raw.final_result?.content);
  const taskTokens = eventMeasurements
    .filter((event) => event.kind !== "recovery")
    .reduce((sum, event) => sum + event.total_tokens, 0);
  const recoveryTokens = eventMeasurements
    .filter((event) => event.kind === "recovery")
    .reduce((sum, event) => sum + event.total_tokens, 0);
  const promptTokens = measurement.tokens(suiteCase.prompt);
  const projectionObserved = containsProjection(events);

  return {
    profile: raw.profile,
    task_id: raw.case_id,
    language: suiteCase.language,
    success: markerFound && expectedInvocation,
    prompt_tokens: promptTokens,
    protocol_events: eventMeasurements.length,
    advertised_tool_count: advertisedTools.length,
    advertised_tools_sha256: digest([...advertisedTools].sort()),
    upstream_calls: upstreamInvocations.length,
    retries: Math.max(0, upstreamInvocations.length - 1),
    projection_observed: projectionObserved,
    exact_recovery: recoveryHash !== null,
    result_content_sha256: resultHash,
    recovered_content_sha256: recoveryHash,
    event_tokens: taskTokens,
    recovery_verification_tokens: recoveryTokens,
    total_tokens: promptTokens + taskTokens,
    total_with_recovery_verification_tokens: promptTokens + taskTokens + recoveryTokens,
    events: eventMeasurements,
  };
}

function assessProtocolReplay(suite, rawObservations, measurement) {
  const expectedPairs = new Set(
    suite.profiles.flatMap((profile) => suite.cases.map((suiteCase) => `${profile}\u0000${suiteCase.id}`)),
  );
  const seenPairs = new Set();
  const observations = [];

  for (const raw of rawObservations) {
    const suiteCase = suite.cases.find((candidate) => candidate.id === raw.case_id);
    if (!suiteCase || !suite.profiles.includes(raw.profile)) continue;
    const pair = `${raw.profile}\u0000${raw.case_id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    observations.push(deriveObservation(raw, suiteCase, measurement));
  }

  const grouped = Object.fromEntries(
    suite.profiles.map((profile) => [profile, observations.filter((entry) => entry.profile === profile)]),
  );
  const summary = Object.fromEntries(
    Object.entries(grouped).map(([profile, results]) => [profile, summarize(results)]),
  );
  const baseline = summary.baseline;
  const comparisons = baseline
    ? Object.fromEntries(
        suite.profiles
          .filter((profile) => profile !== "baseline")
          .map((profile) => [
            `${profile}_vs_baseline_percent`,
            reduction(baseline.total_tokens, summary[profile].total_tokens),
          ]),
      )
    : {};

  const recoveryMismatches = observations.filter((entry) => {
    if (entry.projection_observed && !entry.exact_recovery) return true;
    if (!entry.exact_recovery) return false;
    const baselineEntry = grouped.baseline?.find((candidate) => candidate.task_id === entry.task_id);
    return !baselineEntry || baselineEntry.result_content_sha256 !== entry.recovered_content_sha256;
  });
  const toolCountMismatches = observations.filter(
    (entry) =>
      suite.expected_advertised_tool_counts?.[entry.profile] !== undefined &&
      suite.expected_advertised_tool_counts[entry.profile] !== entry.advertised_tool_count,
  );

  const hardGates = {
    complete_matrix: gate(expectedPairs.size, seenPairs.size, expectedPairs.size === seenPairs.size),
    all_tasks_successful: gate(
      observations.length,
      observations.filter((entry) => entry.success).length,
      observations.length === expectedPairs.size && observations.every((entry) => entry.success),
    ),
    one_upstream_call: gate(
      observations.length,
      observations.filter((entry) => entry.upstream_calls === 1).length,
      observations.length === expectedPairs.size && observations.every((entry) => entry.upstream_calls === 1),
    ),
    advertised_tool_counts: gate(0, toolCountMismatches.length, toolCountMismatches.length === 0),
    exact_recovery: gate(0, recoveryMismatches.length, recoveryMismatches.length === 0),
  };

  return { observations, summary, comparisons, hardGates };
}

function sanitizeProjectionObservation(raw, suiteCase) {
  const observation = structuredClone(raw);
  const evidence = observation._evidence;
  if (evidence && typeof evidence === "object") {
    const sourceAvailable = evidence.source_result !== undefined;
    const recoveredAvailable = evidence.recovered_result !== undefined;
    observation.source_result_sha256 = sourceAvailable ? digest(evidence.source_result) : null;
    observation.recovered_result_sha256 = recoveredAvailable ? digest(evidence.recovered_result) : null;
    observation.exact_recovery =
      sourceAvailable && recoveredAvailable && observation.source_result_sha256 === observation.recovered_result_sha256;

    if (typeof suiteCase.expected_marker === "string") {
      const marker = suiteCase.expected_marker;
      const initialContains = normalizedEvaluationWire(evidence.initial_delivery).includes(marker);
      const targetedResponses = Array.isArray(evidence.targeted_responses) ? evidence.targeted_responses : [];
      observation.initial_contains_marker = initialContains;
      observation.target_contains_marker =
        initialContains || targetedResponses.some((response) => normalizedEvaluationWire(response).includes(marker));
      if (evidence.query_response !== undefined && evidence.query_response !== null) {
        observation.query_contains_marker = normalizedEvaluationWire(evidence.query_response).includes(marker);
      } else {
        delete observation.query_contains_marker;
      }
    }

    if (typeof suiteCase.expected_content_kind === "string" && typeof observation.content_kind === "string") {
      observation.content_kind_matches = observation.content_kind === suiteCase.expected_content_kind;
    } else {
      delete observation.content_kind_matches;
    }
    delete observation._evidence;
  }
  if (observation.deterministic_projection?.preview !== undefined) {
    observation.deterministic_projection.preview_sha256 = digest(observation.deterministic_projection.preview);
    delete observation.deterministic_projection.preview;
  }
  return observation;
}

function stableProjectionObservation(raw, suiteCase) {
  const observation = sanitizeProjectionObservation(raw, suiteCase);
  delete observation.compression_cpu_ms;
  delete observation.observed_peak_heap_bytes;
  delete observation.heap_delta_bytes;
  return observation;
}

function summarizeProjection(results) {
  const queryTargets = results.filter((entry) => entry.query_contains_marker !== undefined);
  return {
    cases: results.length,
    projected: results.filter((entry) => entry.projection !== undefined).length,
    exact_pass_through: results.filter((entry) => entry.delivery === "exact-pass-through").length,
    exact_recoveries: results.filter((entry) => entry.exact_recovery).length,
    query_targets: queryTargets.length,
    query_hits: queryTargets.filter((entry) => entry.query_contains_marker).length,
  };
}

function assessResultProjection(suite, adapterResult) {
  const expectedPairs = new Set(
    suite.profiles.flatMap((profile) => suite.cases.map((suiteCase) => `${profile}\u0000${suiteCase.id}`)),
  );
  const seenPairs = new Set();
  const observations = [];
  for (const raw of adapterResult.observations) {
    if (!suite.profiles.includes(raw.profile) || !suite.cases.some((entry) => entry.id === raw.case_id)) continue;
    const pair = `${raw.profile}\u0000${raw.case_id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const suiteCase = suite.cases.find((entry) => entry.id === raw.case_id);
    observations.push(sanitizeProjectionObservation(raw, suiteCase));
  }

  const repeatObservations = Array.isArray(adapterResult.repeat_observations)
    ? adapterResult.repeat_observations
        .filter((raw) => suite.profiles.includes(raw.profile) && suite.cases.some((entry) => entry.id === raw.case_id))
        .map((raw) =>
          stableProjectionObservation(
            raw,
            suite.cases.find((entry) => entry.id === raw.case_id),
          ),
        )
    : [];
  const firstStable = observations.map((observation) => stableProjectionObservation(observation, {}));
  const firstHash = digest(firstStable);
  const secondHash = repeatObservations.length ? digest(repeatObservations) : null;
  const queryTargets = observations.filter((entry) => entry.query_contains_marker !== undefined);
  const sequentialTargets = observations.filter((entry) => entry.target_contains_marker !== undefined);
  const classifiedResults = observations.filter((entry) => entry.content_kind_matches !== undefined);
  const cpuMeasurements = observations.filter((entry) => entry.compression_cpu_ms !== undefined);
  const summary = Object.fromEntries(
    suite.profiles.map((profile) => [
      profile,
      summarizeProjection(observations.filter((entry) => entry.profile === profile)),
    ]),
  );
  const comparisons = Object.fromEntries(
    suite.profiles.map((profile) => {
      const results = observations.filter(
        (entry) =>
          entry.profile === profile &&
          typeof entry.target_total_tokens === "number" &&
          typeof entry.query_total_tokens === "number",
      );
      const sequential = results.reduce((sum, entry) => sum + entry.target_total_tokens, 0);
      const queried = results.reduce((sum, entry) => sum + entry.query_total_tokens, 0);
      return [`${profile}_query_vs_sequential_percent`, reduction(sequential, queried)];
    }),
  );
  const hardGates = {
    complete_matrix: gate(expectedPairs.size, seenPairs.size, expectedPairs.size === seenPairs.size),
    exact_recovery: gate(
      observations.length,
      observations.filter((entry) => entry.exact_recovery).length,
      observations.length === expectedPairs.size && observations.every((entry) => entry.exact_recovery),
    ),
    literal_query_retrieval: gate(
      queryTargets.length,
      queryTargets.filter((entry) => entry.query_contains_marker).length,
      queryTargets.every((entry) => entry.query_contains_marker),
    ),
    sequential_retrieval: gate(
      sequentialTargets.length,
      sequentialTargets.filter((entry) => entry.target_contains_marker).length,
      sequentialTargets.every((entry) => entry.target_contains_marker),
    ),
    content_classification: gate(
      classifiedResults.length,
      classifiedResults.filter((entry) => entry.content_kind_matches).length,
      classifiedResults.every((entry) => entry.content_kind_matches),
    ),
    deterministic_capture: gate(
      firstHash,
      secondHash,
      repeatObservations.length === expectedPairs.size && secondHash !== null && firstHash === secondHash,
    ),
    fixture_cpu_budget: gate(
      cpuMeasurements.length,
      cpuMeasurements.filter((entry) => entry.compression_cpu_ms < 10).length,
      cpuMeasurements.every((entry) => entry.compression_cpu_ms < 10),
    ),
  };
  return { observations, summary, comparisons, hardGates };
}

function expectedDelivery(suiteCase, profile) {
  if (typeof suiteCase.expected_delivery === "string") return suiteCase.expected_delivery;
  return suiteCase.expected_delivery_by_profile?.[profile];
}

function deriveSelectiveRetrievalObservation(raw, suiteCase, measurement) {
  const evidence = raw._evidence && typeof raw._evidence === "object" ? raw._evidence : {};
  const sourceAvailable = evidence.source_result !== undefined;
  const deliveredAvailable = evidence.delivered_result !== undefined;
  const recoveredAvailable = evidence.recovered_result !== undefined;
  const marker = typeof suiteCase.expected_marker === "string" ? suiteCase.expected_marker : null;
  const initialContains = marker !== null && normalizedEvaluationWire(evidence.delivered_result).includes(marker);
  const queryContains =
    marker !== null &&
    evidence.query_response !== undefined &&
    normalizedEvaluationWire(evidence.query_response).includes(marker);
  const sequentialResponses = Array.isArray(evidence.sequential_responses) ? evidence.sequential_responses : [];
  const recoveryResponses = Array.isArray(evidence.recovery_responses) ? evidence.recovery_responses : [];
  const sequentialContains =
    initialContains ||
    (marker !== null && sequentialResponses.some((response) => normalizedEvaluationWire(response).includes(marker)));
  const initialTokens = deliveredAvailable ? measurement.tokens(evidence.delivered_result) : 0;
  const queryResponseTokens = evidence.query_response === undefined ? 0 : measurement.tokens(evidence.query_response);
  const sequentialResponseTokens = sequentialResponses.reduce(
    (total, response) => total + measurement.tokens(response),
    0,
  );
  const recoveryResponseTokens = recoveryResponses.reduce((total, response) => total + measurement.tokens(response), 0);
  const directResultTokens = sourceAvailable ? measurement.tokens(evidence.source_result) : 0;
  const queryTotalTokens = initialTokens + queryResponseTokens;
  const sequentialTotalTokens = initialTokens + sequentialResponseTokens;
  const forcedRecoveryTotalTokens = initialTokens + recoveryResponseTokens;
  const sourceChars = sourceAvailable ? normalizedEvaluationWire(evidence.source_result).length : 0;
  const deliveredChars = deliveredAvailable ? normalizedEvaluationWire(evidence.delivered_result).length : 0;
  const upstreamEvents = Array.isArray(raw.upstream_events) ? raw.upstream_events : [];
  const businessCalls = upstreamEvents.filter((event) => event.phase === "business").length;
  const recoveryCalls = upstreamEvents.filter((event) => event.phase !== "business").length;
  const queryMatchCount = Number.isInteger(raw.query_match_count) ? raw.query_match_count : 0;
  const queryOutcome = evidence.query_response?.isError === true ? "no-match" : raw.query_outcome;
  const sourceHash = sourceAvailable ? digest(evidence.source_result) : null;
  const recoveredHash = recoveredAvailable ? digest(evidence.recovered_result) : null;

  return {
    profile: raw.profile,
    case_id: raw.case_id,
    category: suiteCase.category,
    query_cohort: suiteCase.query_cohort,
    delivery: raw.delivery,
    delivery_reason: raw.delivery_reason ?? null,
    expected_delivery: expectedDelivery(suiteCase, raw.profile) ?? null,
    initial_tokens: initialTokens,
    initial_contains_target: initialContains,
    query_outcome: queryOutcome ?? null,
    query_match_count: queryMatchCount,
    query_contains_target: queryContains,
    query_response_tokens: queryResponseTokens,
    query_total_tokens: queryTotalTokens,
    sequential_calls: sequentialResponses.length,
    sequential_contains_target: sequentialContains,
    sequential_response_tokens: sequentialResponseTokens,
    sequential_total_tokens: sequentialTotalTokens,
    direct_result_tokens: directResultTokens,
    forced_recovery_calls: recoveryResponses.length,
    forced_recovery_response_tokens: recoveryResponseTokens,
    forced_recovery_total_tokens: forcedRecoveryTotalTokens,
    target_reduction_percent: reduction(sequentialTotalTokens, queryTotalTokens),
    initial_reduction_percent: reduction(sourceChars, deliveredChars),
    business_upstream_calls: businessCalls,
    recovery_upstream_calls: recoveryCalls,
    exact_recovery: sourceHash !== null && recoveredHash !== null && sourceHash === recoveredHash,
    source_result_sha256: sourceHash,
    delivered_result_sha256: deliveredAvailable ? digest(evidence.delivered_result) : null,
    recovered_result_sha256: recoveredHash,
    query_response_sha256: evidence.query_response === undefined ? null : digest(evidence.query_response),
    sequential_responses_sha256: digest(sequentialResponses),
    recovery_responses_sha256: digest(recoveryResponses),
    ...(typeof raw.query_cpu_ms === "number" ? { query_cpu_ms: raw.query_cpu_ms } : {}),
    ...(typeof raw.observed_peak_heap_bytes === "number"
      ? { observed_peak_heap_bytes: raw.observed_peak_heap_bytes }
      : {}),
  };
}

function stableSelectiveObservation(observation) {
  const stable = structuredClone(observation);
  delete stable.query_cpu_ms;
  delete stable.observed_peak_heap_bytes;
  return stable;
}

function assessSelectiveRetrieval(suite, adapterResult, measurement) {
  const expectedPairs = new Set(
    suite.profiles.flatMap((profile) => suite.cases.map((suiteCase) => `${profile}\u0000${suiteCase.id}`)),
  );
  const seenPairs = new Set();
  const observations = [];
  for (const raw of adapterResult.observations) {
    const suiteCase = suite.cases.find((entry) => entry.id === raw.case_id);
    if (!suiteCase || !suite.profiles.includes(raw.profile)) continue;
    const pair = `${raw.profile}\u0000${raw.case_id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    observations.push(deriveSelectiveRetrievalObservation(raw, suiteCase, measurement));
  }

  const repeatObservations = Array.isArray(adapterResult.repeat_observations)
    ? adapterResult.repeat_observations
        .filter((raw) => suite.profiles.includes(raw.profile) && suite.cases.some((entry) => entry.id === raw.case_id))
        .map((raw) =>
          stableSelectiveObservation(
            deriveSelectiveRetrievalObservation(
              raw,
              suite.cases.find((entry) => entry.id === raw.case_id),
              measurement,
            ),
          ),
        )
    : [];
  const firstStable = observations.map(stableSelectiveObservation);
  const firstHash = digest(firstStable);
  const secondHash = repeatObservations.length ? digest(repeatObservations) : null;
  const literalTargets = observations.filter((entry) =>
    ["exact", "multiple-terms", "punctuation-case", "ambiguous"].includes(entry.query_cohort),
  );
  const zeroMatches = observations.filter((entry) => entry.query_cohort === "zero-match");
  const paraphrases = observations.filter((entry) => entry.query_cohort === "paraphrase");
  const efficiencyTargets = observations.filter((entry) => {
    const suiteCase = suite.cases.find((candidate) => candidate.id === entry.case_id);
    return (
      literalTargets.includes(entry) && !entry.initial_contains_target && suiteCase?.expected_query_outcome === "match"
    );
  });
  const deliveryMatches = observations.filter(
    (entry) => entry.expected_delivery === null || entry.delivery === entry.expected_delivery,
  );
  const extremeProjections = observations.filter(
    (entry) => entry.profile === "extreme" && entry.delivery === "projected",
  );
  const boundedQueries = observations.filter(
    (entry) =>
      entry.query_match_count >= 0 &&
      entry.query_match_count <= 3 &&
      (entry.query_cohort !== "ambiguous" || entry.query_match_count >= 2),
  );

  const summary = Object.fromEntries(
    suite.profiles.map((profile) => {
      const results = observations.filter((entry) => entry.profile === profile);
      const targeted = results.filter((entry) => !entry.initial_contains_target && entry.query_contains_target);
      return [
        profile,
        {
          cases: results.length,
          projected: results.filter((entry) => entry.delivery === "projected").length,
          pass_through: results.filter((entry) => entry.delivery === "pass-through").length,
          literal_targets: results.filter((entry) => literalTargets.includes(entry)).length,
          literal_hits: results.filter((entry) => literalTargets.includes(entry) && entry.query_contains_target).length,
          zero_matches: results.filter((entry) => zeroMatches.includes(entry)).length,
          paraphrase_misses: results.filter(
            (entry) => paraphrases.includes(entry) && entry.query_outcome === "no-match",
          ).length,
          targeted_cases: targeted.length,
          minimum_target_reduction_percent:
            targeted.length === 0 ? null : Math.min(...targeted.map((entry) => entry.target_reduction_percent)),
          exact_recoveries: results.filter((entry) => entry.exact_recovery).length,
          path_tokens: {
            direct: results.reduce((sum, entry) => sum + entry.direct_result_tokens, 0),
            initial: results.reduce((sum, entry) => sum + entry.initial_tokens, 0),
            targeted: results.reduce((sum, entry) => sum + entry.query_total_tokens, 0),
            forced_recovery: results.reduce((sum, entry) => sum + entry.forced_recovery_total_tokens, 0),
          },
          forced_recovery_calls: results.reduce((sum, entry) => sum + entry.forced_recovery_calls, 0),
        },
      ];
    }),
  );
  const comparisons = Object.fromEntries(
    suite.profiles.flatMap((profile) => {
      const allResults = observations.filter((entry) => entry.profile === profile);
      const targets = efficiencyTargets.filter((entry) => entry.profile === profile);
      const sequential = targets.reduce((sum, entry) => sum + entry.sequential_total_tokens, 0);
      const queried = targets.reduce((sum, entry) => sum + entry.query_total_tokens, 0);
      const direct = allResults.reduce((sum, entry) => sum + entry.direct_result_tokens, 0);
      const initial = allResults.reduce((sum, entry) => sum + entry.initial_tokens, 0);
      const forced = allResults.reduce((sum, entry) => sum + entry.forced_recovery_total_tokens, 0);
      return [
        [`${profile}_targeted_vs_sequential_percent`, targets.length === 0 ? null : reduction(sequential, queried)],
        [`${profile}_initial_vs_direct_percent`, reduction(direct, initial)],
        [`${profile}_forced_recovery_vs_direct_percent`, reduction(direct, forced)],
      ];
    }),
  );
  const hardGates = {
    complete_matrix: gate(expectedPairs.size, seenPairs.size, expectedPairs.size === seenPairs.size),
    exact_recovery: gate(
      observations.length,
      observations.filter((entry) => entry.exact_recovery).length,
      observations.length === expectedPairs.size && observations.every((entry) => entry.exact_recovery),
    ),
    forced_recovery_accounting: gate(
      observations.length,
      observations.filter((entry) =>
        entry.delivery === "projected"
          ? entry.forced_recovery_calls > 0 && entry.forced_recovery_total_tokens >= entry.initial_tokens
          : entry.forced_recovery_calls === 0 && entry.forced_recovery_total_tokens === entry.initial_tokens,
      ).length,
      observations.length === expectedPairs.size &&
        observations.every((entry) =>
          entry.delivery === "projected"
            ? entry.forced_recovery_calls > 0 && entry.forced_recovery_total_tokens >= entry.initial_tokens
            : entry.forced_recovery_calls === 0 && entry.forced_recovery_total_tokens === entry.initial_tokens,
        ),
    ),
    one_business_upstream_call: gate(
      observations.length,
      observations.filter((entry) => entry.business_upstream_calls === 1).length,
      observations.length === expectedPairs.size && observations.every((entry) => entry.business_upstream_calls === 1),
    ),
    zero_recovery_upstream_calls: gate(
      0,
      observations.reduce((sum, entry) => sum + entry.recovery_upstream_calls, 0),
      observations.every((entry) => entry.recovery_upstream_calls === 0),
    ),
    literal_target_recall: gate(
      literalTargets.length,
      literalTargets.filter((entry) => entry.query_contains_target).length,
      literalTargets.every((entry) => entry.query_contains_target),
    ),
    deterministic_zero_match: gate(
      zeroMatches.length,
      zeroMatches.filter((entry) => entry.query_outcome === "no-match" && entry.query_match_count === 0).length,
      zeroMatches.every((entry) => entry.query_outcome === "no-match" && entry.query_match_count === 0),
    ),
    literal_paraphrase_boundary: gate(
      paraphrases.length,
      paraphrases.filter((entry) => entry.query_outcome === "no-match" && entry.query_match_count === 0).length,
      paraphrases.every((entry) => entry.query_outcome === "no-match" && entry.query_match_count === 0),
    ),
    deterministic_bounded_results: gate(
      firstHash,
      secondHash,
      boundedQueries.length === observations.length &&
        repeatObservations.length === expectedPairs.size &&
        secondHash !== null &&
        firstHash === secondHash,
    ),
    selective_token_reduction: gate(
      efficiencyTargets.length,
      efficiencyTargets.filter((entry) => {
        const suiteCase = suite.cases.find((candidate) => candidate.id === entry.case_id);
        const threshold = suiteCase?.minimum_target_reduction_percent ?? 50;
        return entry.target_reduction_percent >= threshold;
      }).length,
      efficiencyTargets.every((entry) => {
        const suiteCase = suite.cases.find((candidate) => candidate.id === entry.case_id);
        const threshold = suiteCase?.minimum_target_reduction_percent ?? 50;
        return entry.target_reduction_percent >= threshold;
      }),
    ),
    delivery_contract: gate(observations.length, deliveryMatches.length, deliveryMatches.length === expectedPairs.size),
    extreme_initial_savings: gate(
      extremeProjections.length,
      extremeProjections.filter((entry) => entry.initial_reduction_percent >= 50).length,
      extremeProjections.every((entry) => entry.initial_reduction_percent >= 50),
    ),
  };
  return { observations, summary, comparisons, hardGates };
}

function schemaTypeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function matchesJsonSchema(value, schema) {
  if (schema === true || schema === undefined) return true;
  if (schema === false || !schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (schema.const !== undefined && normalizedEvaluationWire(value) !== normalizedEvaluationWire(schema.const))
    return false;
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((entry) => normalizedEvaluationWire(entry) === normalizedEvaluationWire(value))
  ) {
    return false;
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => matchesJsonSchema(value, entry))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => matchesJsonSchema(value, entry))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((entry) => matchesJsonSchema(value, entry)).length !== 1)
    return false;

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => schemaTypeMatches(value, type))) return false;
  }

  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return false;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return false;
      } catch {
        return false;
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return false;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return false;
    if (schema.items !== undefined && !value.every((entry) => matchesJsonSchema(entry, schema.items))) return false;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Array.isArray(schema.required) && schema.required.some((name) => !(name in value))) return false;
    for (const [name, entry] of Object.entries(value)) {
      if (properties[name] !== undefined) {
        if (!matchesJsonSchema(entry, properties[name])) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        if (!matchesJsonSchema(entry, schema.additionalProperties)) return false;
      }
    }
  }

  return true;
}

function hostRepetitions(suite, arm) {
  const value = suite.repetitions?.[arm] ?? 1;
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new TypeError(`host-task repetition count for ${arm} must be between 1 and 10`);
  }
  return value;
}

function hostRunId(suite, suiteCase, arm, repetition) {
  return digest({
    suite: suite.id,
    fixture: suite.fixture_digest ?? UNKNOWN_DIGEST,
    task: suiteCase.id,
    arm,
    repetition,
  });
}

function hostSchedule(suite) {
  const blocks = [];
  const maximumRepetitions = Math.max(...suite.profiles.map((arm) => hostRepetitions(suite, arm)));
  for (let repetition = 1; repetition <= maximumRepetitions; repetition++) {
    for (const suiteCase of suite.cases) {
      const block = suite.profiles
        .filter((arm) => repetition <= hostRepetitions(suite, arm))
        .map((arm) => ({
          arm,
          repetition,
          suiteCase,
          run_id: hostRunId(suite, suiteCase, arm, repetition),
        }))
        .sort((left, right) =>
          digest(`${suite.order_seed ?? "slim-guard-host-task-v1"}\u0000${left.run_id}`).localeCompare(
            digest(`${suite.order_seed ?? "slim-guard-host-task-v1"}\u0000${right.run_id}`),
          ),
        );
      blocks.push(...block);
    }
  }
  return blocks;
}

function hostAdapterInput(suite, scheduled) {
  const suiteCase = scheduled.suiteCase;
  const timeoutMs = suiteCase.limits?.timeout_ms ?? suite.limits?.timeout_ms ?? 180_000;
  const maxMcpCalls = suiteCase.limits?.max_mcp_calls ?? suite.limits?.max_mcp_calls ?? 20;
  return {
    run_id: scheduled.run_id,
    arm: scheduled.arm,
    repetition: scheduled.repetition,
    prompt: suiteCase.prompt,
    server_definition: structuredClone(suiteCase.server_definitions?.[scheduled.arm] ?? null),
    output_schema: structuredClone(suiteCase.output_schema ?? null),
    limits: { timeout_ms: timeoutMs, max_mcp_calls: maxMcpCalls },
  };
}

function safeAttempt(raw, attempt) {
  const category = raw?.infrastructure_error?.category;
  return {
    attempt,
    status: HOST_STATUSES.has(raw?.status) ? raw.status : "product_error",
    infrastructure_category: INFRASTRUCTURE_ERRORS.has(category) ? category : category ? "other" : null,
    before_first_mcp_event: raw?.infrastructure_error?.before_first_mcp_event === true,
    duration_ms: typeof raw?.duration_ms === "number" ? raw.duration_ms : null,
  };
}

async function collectHostTaskAdapterResult(request) {
  const observations = [];
  const schedule = hostSchedule(request.suite);
  let consecutiveInfrastructureErrors = 0;
  let abortedReason = null;

  for (const scheduled of schedule) {
    const attempts = [];
    let raw;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        raw = await request.adapter.run(hostAdapterInput(request.suite, scheduled));
        assertObject(raw, "host adapter result");
      } catch (error) {
        raw = {
          status: "infrastructure_error",
          duration_ms: null,
          infrastructure_error: {
            category: "adapter_exception",
            before_first_mcp_event: true,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
      attempts.push(safeAttempt(raw, attempt));
      const retryable =
        raw.status === "infrastructure_error" &&
        raw.infrastructure_error?.before_first_mcp_event === true &&
        RETRYABLE_INFRASTRUCTURE_ERRORS.has(raw.infrastructure_error?.category);
      if (!retryable || attempt === 2) break;
    }

    observations.push({
      ...raw,
      _runner: {
        run_id: scheduled.run_id,
        arm: scheduled.arm,
        repetition: scheduled.repetition,
        case_id: scheduled.suiteCase.id,
        attempts,
      },
    });

    if (raw.status === "infrastructure_error") {
      consecutiveInfrastructureErrors += 1;
      if (consecutiveInfrastructureErrors >= 2) {
        abortedReason = "two_consecutive_infrastructure_errors";
        break;
      }
    } else {
      consecutiveInfrastructureErrors = 0;
    }
  }

  return { observations, expected_runs: schedule.length, aborted_reason: abortedReason };
}

function normalizeProviderUsage(value) {
  const source = value && typeof value === "object" ? value : {};
  const fields = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"];
  const output = Object.fromEntries(
    fields.map((field) => [field, typeof source[field] === "number" ? source[field] : null]),
  );
  return {
    status: output.input_tokens === null || output.output_tokens === null ? "unavailable" : "reported",
    ...output,
  };
}

function hostIdentityComplete(environment) {
  const host = environment.host;
  return Boolean(
    host &&
    typeof host === "object" &&
    typeof host.name === "string" &&
    host.name &&
    typeof host.version === "string" &&
    host.version &&
    typeof host.model === "string" &&
    host.model,
  );
}

function hostIdentityMatches(expected, actual) {
  if (!expected || !actual || typeof actual !== "object") return false;
  return ["name", "version", "model", "reasoning_effort"].every(
    (field) => expected[field] === undefined || expected[field] === actual[field],
  );
}

function deriveHostTaskObservation(raw, suiteCase, suite, environment, measurement) {
  const evidence = raw._evidence && typeof raw._evidence === "object" ? raw._evidence : {};
  const arm = raw._runner.arm;
  const deniedTools = new Set(Array.isArray(suiteCase.denied_tools) ? suiteCase.denied_tools : []);
  const toolCalls = Array.isArray(evidence.tool_calls) ? evidence.tool_calls : [];
  const upstreamEvents = Array.isArray(evidence.upstream_events) ? evidence.upstream_events : [];
  const discoveredTools = Array.isArray(evidence.discovered_tools) ? evidence.discovered_tools : [];
  const rankedTools = Array.isArray(evidence.ranked_tools) ? evidence.ranked_tools : [];
  const builtinToolCalls = Array.isArray(evidence.builtin_tool_calls) ? evidence.builtin_tool_calls : [];
  const mcpEvents = Array.isArray(evidence.mcp_events) ? evidence.mcp_events : [];
  const requiredToolSearchArms = Array.isArray(suite.required_evidence?.tool_search_arms)
    ? suite.required_evidence.tool_search_arms
    : [];
  const toolSearchRequired = requiredToolSearchArms.includes(arm);
  const toolSearch = evidence.tool_search && typeof evidence.tool_search === "object" ? evidence.tool_search : null;
  const toolSearchRequest = toolSearch?.request && typeof toolSearch.request === "object" ? toolSearch.request : null;
  const toolSearchReferences = Array.isArray(toolSearch?.references) ? toolSearch.references : null;
  const businessCalls = upstreamEvents.filter((event) => event.phase === "business");
  const recoveryCalls = upstreamEvents.filter((event) => event.phase !== "business");
  const firstBusinessCall = toolCalls.find((event) => event.phase === undefined || event.phase === "business") ?? null;
  const expectedTool = typeof suiteCase.expected_tool === "string" ? suiteCase.expected_tool : null;
  const expectedSchema = expectedTool
    ? (suiteCase.tool_schemas?.[expectedTool]?.inputSchema ?? suiteCase.tool_schemas?.[expectedTool]?.input_schema)
    : undefined;
  const selectedToolCorrect =
    expectedTool === null ? firstBusinessCall === null : firstBusinessCall?.tool === expectedTool;
  const firstArgumentsValid =
    expectedTool === null
      ? firstBusinessCall === null
      : selectedToolCorrect && matchesJsonSchema(firstBusinessCall?.arguments, expectedSchema);
  const expectedToolReference =
    expectedTool === null || toolSearchReferences === null
      ? null
      : (toolSearchReferences.find((reference) => reference?.tool === expectedTool) ?? null);
  const searchRequestSequence = toolSearchRequest?.sequence;
  const referenceSequence = expectedToolReference?.sequence;
  const callSequence = firstBusinessCall?.sequence;
  const toolSearchEvidenceComplete = !toolSearchRequired
    ? null
    : expectedTool === null
      ? Number.isInteger(searchRequestSequence) && toolSearchReferences !== null
      : Number.isInteger(searchRequestSequence) &&
        toolSearchReferences !== null &&
        Number.isInteger(referenceSequence) &&
        expectedToolReference?.input_schema !== undefined &&
        Number.isInteger(callSequence);
  const toolSearchEventOrderValid = !toolSearchRequired
    ? null
    : expectedTool === null
      ? toolSearchEvidenceComplete && toolSearchReferences.length === 0 && firstBusinessCall === null
      : toolSearchEvidenceComplete && searchRequestSequence < referenceSequence && referenceSequence < callSequence;
  const expandedSchemaMatch =
    !toolSearchRequired || expectedTool === null || expectedToolReference?.input_schema === undefined
      ? null
      : canonicalDigest(expectedToolReference.input_schema) === canonicalDigest(expectedSchema);
  const precomputedExpectedStateHash = typeof suiteCase.expected_final_state_sha256 === "string";
  const expectedStateHash = precomputedExpectedStateHash
    ? suiteCase.expected_final_state_sha256
    : suiteCase.expected_final_state === undefined
      ? null
      : canonicalDigest(suiteCase.expected_final_state);
  const actualStateHash =
    evidence.final_state === undefined
      ? null
      : precomputedExpectedStateHash
        ? digest(evidence.final_state)
        : canonicalDigest(evidence.final_state);
  const finalResponse = raw.final_response;
  const markerVisible =
    typeof suiteCase.expected_marker !== "string" ||
    normalizedEvaluationWire(finalResponse).includes(suiteCase.expected_marker);
  const noMatch = suiteCase.expected_no_match === true;
  const finalNoMatch = finalResponse?.status === "no_match";
  const finalStateMatches =
    suiteCase.expected_no_match === true
      ? true
      : expectedStateHash !== null && actualStateHash !== null && expectedStateHash === actualStateHash;
  const unauthorizedDiscoveries = [
    ...new Set([
      ...discoveredTools,
      ...(toolSearchReferences ?? []).map((reference) => reference?.tool).filter(Boolean),
    ]),
  ].filter((tool) => deniedTools.has(tool));
  const unauthorizedCalls = toolCalls.filter((event) => deniedTools.has(event.tool));
  const mcpVisibleTokens = mcpEvents.reduce(
    (total, event) => total + measurement.tokens(event.request ?? "") + measurement.tokens(event.response ?? ""),
    0,
  );
  const expectedRank = expectedTool === null ? 0 : rankedTools.indexOf(expectedTool) + 1;
  const projectionUsed = evidence.projection_used === true;
  const sourceHash = evidence.source_result === undefined ? null : digest(evidence.source_result);
  const recoveredHash = evidence.recovered_result === undefined ? null : digest(evidence.recovered_result);
  const exactRecovery = projectionUsed ? sourceHash !== null && sourceHash === recoveredHash : null;
  const maxMcpCalls = suiteCase.limits?.max_mcp_calls ?? suite.limits?.max_mcp_calls ?? 20;
  const mcpCallCount = Number.isInteger(evidence.mcp_call_count) ? evidence.mcp_call_count : toolCalls.length;
  const status = HOST_STATUSES.has(raw.status) ? raw.status : "product_error";
  const infrastructureCategory = raw.infrastructure_error?.category;
  const taskCompletion =
    status === "completed" &&
    unauthorizedDiscoveries.length === 0 &&
    unauthorizedCalls.length === 0 &&
    builtinToolCalls.length === 0 &&
    mcpCallCount <= maxMcpCalls &&
    (noMatch
      ? firstBusinessCall === null && businessCalls.length === 0 && finalNoMatch
      : firstArgumentsValid && finalStateMatches && markerVisible && businessCalls.length === 1);

  return {
    _case_id: suiteCase.id,
    run_id: raw._runner.run_id,
    task_sha256: digest({ fixture: suite.fixture_digest ?? UNKNOWN_DIGEST, task: suiteCase.id }),
    arm,
    repetition: raw._runner.repetition,
    language: suiteCase.language ?? null,
    side_effecting: suiteCase.side_effecting === true,
    expected_no_match: noMatch,
    status,
    infrastructure_category: INFRASTRUCTURE_ERRORS.has(infrastructureCategory)
      ? infrastructureCategory
      : infrastructureCategory
        ? "other"
        : null,
    attempts: raw._runner.attempts,
    host_identity_match: hostIdentityMatches(environment.host, raw.host),
    selected_tool_correct: selectedToolCorrect,
    first_arguments_valid: firstArgumentsValid,
    final_state_match: finalStateMatches,
    marker_visible: markerVisible,
    task_completion: taskCompletion,
    retrieval_rank: expectedRank,
    recall_at_1: expectedTool === null ? null : expectedRank === 1,
    recall_at_3: expectedTool === null ? null : expectedRank >= 1 && expectedRank <= 3,
    reciprocal_rank: expectedRank > 0 ? 1 / expectedRank : 0,
    ndcg: expectedRank > 0 ? 1 / Math.log2(expectedRank + 1) : 0,
    no_match_correct: noMatch ? rankedTools.length === 0 : null,
    discovered_tool_count: discoveredTools.length,
    unauthorized_discoveries: unauthorizedDiscoveries.length,
    unauthorized_calls: unauthorizedCalls.length,
    builtin_tool_calls: builtinToolCalls.length,
    mcp_calls: mcpCallCount,
    max_mcp_calls: maxMcpCalls,
    business_upstream_calls: businessCalls.length,
    recovery_upstream_calls: recoveryCalls.length,
    projection_used: projectionUsed,
    exact_recovery: exactRecovery,
    source_result_sha256: sourceHash,
    recovered_result_sha256: recoveredHash,
    mcp_visible_tokens: mcpVisibleTokens,
    provider_usage: normalizeProviderUsage(raw.provider_usage),
    duration_ms: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
    tool_search_required: toolSearchRequired,
    tool_search_evidence_complete: toolSearchEvidenceComplete,
    tool_search_event_order_valid: toolSearchEventOrderValid,
    expanded_schema_match: expandedSchemaMatch,
    expanded_schema_sha256:
      expectedToolReference?.input_schema === undefined ? null : canonicalDigest(expectedToolReference.input_schema),
  };
}

function rate(values) {
  return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function groupByTask(observations) {
  const grouped = new Map();
  for (const observation of observations) {
    const values = grouped.get(observation.task_sha256) ?? [];
    values.push(observation);
    grouped.set(observation.task_sha256, values);
  }
  return grouped;
}

function hostArmSummary(results) {
  const tasks = [...groupByTask(results).values()];
  const providerReported = results.length > 0 && results.every((entry) => entry.provider_usage.status === "reported");
  const ranks = results.filter((entry) => !entry.expected_no_match).map((entry) => entry.retrieval_rank);
  const noMatches = results.filter((entry) => entry.expected_no_match);
  const repetitions = results.length === 0 ? 0 : Math.max(...results.map((entry) => entry.repetition));
  return {
    runs: results.length,
    tasks: tasks.length,
    repetitions,
    infrastructure_errors: results.filter((entry) => entry.status === "infrastructure_error").length,
    task_completion_rate: rate(results.map((entry) => entry.task_completion)),
    first_valid_arguments_rate: rate(
      results.filter((entry) => !entry.expected_no_match).map((entry) => entry.first_arguments_valid),
    ),
    pass_at_1: rate(results.map((entry) => entry.task_completion)),
    pass_at_k: rate(tasks.map((entries) => entries.some((entry) => entry.task_completion))),
    pass_power_k: rate(
      tasks.map((entries) => entries.length === repetitions && entries.every((entry) => entry.task_completion)),
    ),
    retrieval: {
      recall_at_1: ranks.length === 0 ? null : rate(ranks.map((rank) => rank === 1)),
      recall_at_3: ranks.length === 0 ? null : rate(ranks.map((rank) => rank >= 1 && rank <= 3)),
      mrr: ranks.length === 0 ? null : ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / rank : 0), 0) / ranks.length,
      ndcg:
        ranks.length === 0
          ? null
          : ranks.reduce((sum, rank) => sum + (rank > 0 ? 1 / Math.log2(rank + 1) : 0), 0) / ranks.length,
      no_match_precision: noMatches.length === 0 ? null : rate(noMatches.map((entry) => entry.no_match_correct)),
    },
    model_visible_mcp_tokens: results.reduce((sum, entry) => sum + entry.mcp_visible_tokens, 0),
    provider_usage: providerReported
      ? {
          status: "reported",
          input_tokens: results.reduce((sum, entry) => sum + entry.provider_usage.input_tokens, 0),
          output_tokens: results.reduce((sum, entry) => sum + entry.provider_usage.output_tokens, 0),
          cache_read_tokens: results.reduce((sum, entry) => sum + (entry.provider_usage.cache_read_tokens ?? 0), 0),
          cache_write_tokens: results.reduce((sum, entry) => sum + (entry.provider_usage.cache_write_tokens ?? 0), 0),
          cost_usd: results.every((entry) => entry.provider_usage.cost_usd !== null)
            ? results.reduce((sum, entry) => sum + entry.provider_usage.cost_usd, 0)
            : null,
        }
      : { status: "unavailable" },
    latency_ms: {
      p50: percentile(
        results.map((entry) => entry.duration_ms).filter((value) => value !== null),
        0.5,
      ),
      p95: percentile(
        results.map((entry) => entry.duration_ms).filter((value) => value !== null),
        0.95,
      ),
    },
  };
}

function taskAverages(observations, arm, selector) {
  return new Map(
    [...groupByTask(observations.filter((entry) => entry.arm === arm)).entries()].map(([task, entries]) => [
      task,
      entries.reduce((sum, entry) => sum + Number(selector(entry)), 0) / entries.length,
    ]),
  );
}

function pairedHostComparison(observations, baselineArm, candidateArm, selector, seed) {
  const baseline = taskAverages(observations, baselineArm, selector);
  const candidate = taskAverages(observations, candidateArm, selector);
  const tasks = [...baseline.keys()].filter((task) => candidate.has(task));
  if (tasks.length === 0) return null;
  return pairedBootstrap(
    tasks.map((task) => baseline.get(task)),
    tasks.map((task) => candidate.get(task)),
    10_000,
    seed,
  );
}

function pairedHostReduction(observations, baselineArm, candidateArm, selector) {
  const baseline = taskAverages(observations, baselineArm, selector);
  const candidate = taskAverages(observations, candidateArm, selector);
  const tasks = [...baseline.keys()].filter((task) => candidate.has(task));
  if (tasks.length === 0) return null;
  const baselineTotal = tasks.reduce((sum, task) => sum + baseline.get(task), 0);
  const candidateTotal = tasks.reduce((sum, task) => sum + candidate.get(task), 0);
  return baselineTotal === 0 ? null : reduction(baselineTotal, candidateTotal);
}

function hostComparisons(observations) {
  const pairs = [
    ["direct", "compact", "product_value"],
    ["direct", "extreme", "product_value"],
    ["oracle", "compact", "retrieval_headroom"],
    ["oracle", "extreme", "retrieval_headroom"],
    ["direct", "native", "proxy_compatibility"],
  ];
  return Object.fromEntries(
    pairs.map(([baselineArm, candidateArm, purpose]) => {
      const selected = observations.filter((entry) => [baselineArm, candidateArm].includes(entry.arm));
      const completion = pairedHostComparison(
        selected,
        baselineArm,
        candidateArm,
        (entry) => entry.task_completion,
        `${baselineArm}-${candidateArm}-completion-v1`,
      );
      const providerAvailable =
        selected.length > 0 && selected.every((entry) => entry.provider_usage.status === "reported");
      const pairedTasks = [...taskAverages(selected, baselineArm, (entry) => entry.task_completion).keys()].filter(
        (task) => taskAverages(selected, candidateArm, (entry) => entry.task_completion).has(task),
      ).length;
      return [
        `${candidateArm}_vs_${baselineArm}`,
        {
          purpose,
          paired_tasks: completion === null ? 0 : pairedTasks,
          task_completion: completion,
          model_visible_mcp_token_reduction_percent: pairedHostReduction(
            selected,
            baselineArm,
            candidateArm,
            (entry) => entry.mcp_visible_tokens,
          ),
          provider_input_token_reduction_percent: !providerAvailable
            ? "unavailable"
            : pairedHostReduction(selected, baselineArm, candidateArm, (entry) => entry.provider_usage.input_tokens),
        },
      ];
    }),
  );
}

function assessHostTask(suite, adapterResult, environment, candidate, measurement) {
  const expectedRuns = hostSchedule(suite);
  const expectedRunIds = new Set(expectedRuns.map((entry) => entry.run_id));
  const seen = new Set();
  const internalObservations = [];
  for (const raw of adapterResult.observations) {
    if (!raw?._runner || !expectedRunIds.has(raw._runner.run_id) || seen.has(raw._runner.run_id)) continue;
    const suiteCase = suite.cases.find((entry) => entry.id === raw._runner.case_id);
    if (!suiteCase) continue;
    seen.add(raw._runner.run_id);
    internalObservations.push(deriveHostTaskObservation(raw, suiteCase, suite, environment, measurement));
  }

  const observations = internalObservations.map((entry) => {
    const output = structuredClone(entry);
    delete output._case_id;
    return output;
  });
  const summary = Object.fromEntries(
    suite.profiles.map((arm) => [arm, hostArmSummary(internalObservations.filter((entry) => entry.arm === arm))]),
  );
  const comparisons = hostComparisons(internalObservations);
  const provenanceComplete = Boolean(candidate && suite.fixture_digest && DIGEST_PATTERN.test(suite.fixture_digest));
  const identityComplete = hostIdentityComplete(environment);
  const identityMatches = internalObservations.filter((entry) => entry.host_identity_match).length;
  const infrastructureErrors = internalObservations.filter((entry) => entry.status === "infrastructure_error");
  const selectedArms = new Set(suite.profiles);
  const pairedBaseline =
    selectedArms.has("direct") &&
    internalObservations
      .filter((entry) => entry.arm !== "direct")
      .every((entry) =>
        internalObservations.some(
          (candidateEntry) => candidateEntry.arm === "direct" && candidateEntry.task_sha256 === entry.task_sha256,
        ),
      );
  const sideEffectRegressions = internalObservations.filter((entry) => {
    if (!entry.side_effecting || entry.arm === "direct" || entry.expected_no_match) return false;
    const directSucceeded = internalObservations.some(
      (candidateEntry) =>
        candidateEntry.arm === "direct" &&
        candidateEntry.task_sha256 === entry.task_sha256 &&
        candidateEntry.task_completion,
    );
    return directSucceeded && !entry.first_arguments_valid;
  });
  const projected = internalObservations.filter((entry) => entry.projection_used);
  const completedBusiness = internalObservations.filter((entry) => entry.task_completion && !entry.expected_no_match);
  const toolSearchRequired = internalObservations.filter((entry) => entry.tool_search_required);
  const toolSearchSchemaRequired = toolSearchRequired.filter((entry) => !entry.expected_no_match);
  const selectedNonInferiorityArms = HOST_CORE_ARMS.filter((arm) => arm !== "direct" && selectedArms.has(arm));
  const nonInferiorityValues = selectedNonInferiorityArms
    .map((arm) => comparisons[`${arm}_vs_direct`]?.task_completion)
    .filter(Boolean);
  const hardGates = {
    complete_matrix: gate(expectedRuns.length, seen.size, expectedRuns.length === seen.size),
    provenance_complete: gate(true, provenanceComplete, provenanceComplete),
    host_identity_complete: gate(true, identityComplete, identityComplete),
    host_identity_match: gate(
      internalObservations.length,
      identityMatches,
      identityMatches === internalObservations.length,
    ),
    paired_direct_baseline: gate(true, pairedBaseline, pairedBaseline),
    infrastructure_clear: gate(0, infrastructureErrors.length, infrastructureErrors.length === 0),
    paired_task_non_inferiority: gate(
      ">= -0.05 lower 95% bound",
      nonInferiorityValues.map((entry) => entry.lower_95),
      nonInferiorityValues.length === selectedNonInferiorityArms.length &&
        nonInferiorityValues.every((entry) => entry.lower_95 >= -0.05),
    ),
    side_effecting_first_arguments: gate(0, sideEffectRegressions.length, sideEffectRegressions.length === 0),
    unauthorized_tool_exposure: gate(
      0,
      internalObservations.reduce((sum, entry) => sum + entry.unauthorized_discoveries + entry.unauthorized_calls, 0),
      internalObservations.every((entry) => entry.unauthorized_discoveries === 0 && entry.unauthorized_calls === 0),
    ),
    no_disallowed_builtin_tools: gate(
      0,
      internalObservations.reduce((sum, entry) => sum + entry.builtin_tool_calls, 0),
      internalObservations.every((entry) => entry.builtin_tool_calls === 0),
    ),
    mcp_call_limit: gate(
      internalObservations.length,
      internalObservations.filter((entry) => entry.mcp_calls <= entry.max_mcp_calls).length,
      internalObservations.every((entry) => entry.mcp_calls <= entry.max_mcp_calls),
    ),
    at_most_one_business_upstream_call: gate(
      completedBusiness.length,
      completedBusiness.filter((entry) => entry.business_upstream_calls === 1).length,
      completedBusiness.every((entry) => entry.business_upstream_calls === 1) &&
        internalObservations
          .filter((entry) => entry.expected_no_match)
          .every((entry) => entry.business_upstream_calls === 0),
    ),
    zero_recovery_upstream_calls: gate(
      0,
      internalObservations.reduce((sum, entry) => sum + entry.recovery_upstream_calls, 0),
      internalObservations.every((entry) => entry.recovery_upstream_calls === 0),
    ),
    exact_recovery: gate(
      projected.length,
      projected.filter((entry) => entry.exact_recovery).length,
      projected.every((entry) => entry.exact_recovery),
    ),
    ...(toolSearchRequired.length > 0
      ? {
          tool_search_evidence_complete: gate(
            toolSearchRequired.length,
            toolSearchRequired.filter((entry) => entry.tool_search_evidence_complete).length,
            toolSearchRequired.every((entry) => entry.tool_search_evidence_complete),
          ),
          tool_search_event_order: gate(
            toolSearchRequired.length,
            toolSearchRequired.filter((entry) => entry.tool_search_event_order_valid).length,
            toolSearchRequired.every((entry) => entry.tool_search_event_order_valid),
          ),
          tool_search_schema_identity: gate(
            toolSearchSchemaRequired.length,
            toolSearchSchemaRequired.filter((entry) => entry.expanded_schema_match).length,
            toolSearchSchemaRequired.every((entry) => entry.expanded_schema_match),
          ),
        }
      : {}),
  };
  const inconclusive = [
    hardGates.complete_matrix,
    hardGates.provenance_complete,
    hardGates.host_identity_complete,
    hardGates.host_identity_match,
    hardGates.paired_direct_baseline,
    hardGates.infrastructure_clear,
    hardGates.tool_search_evidence_complete,
  ]
    .filter(Boolean)
    .some((entry) => !entry.passed);
  return {
    observations,
    summary: {
      ...summary,
      attempted_runs: internalObservations.reduce((sum, entry) => sum + entry.attempts.length, 0),
      planned_runs: expectedRuns.length,
      aborted_reason: adapterResult.aborted_reason ?? null,
    },
    comparisons,
    hardGates,
    inconclusive,
  };
}

function assessStress(suite, rawObservations) {
  const expectedPairs = new Set(
    suite.profiles.flatMap((profile) => suite.cases.map((suiteCase) => `${profile}\u0000${suiteCase.id}`)),
  );
  const seenPairs = new Set();
  const observations = [];
  for (const raw of rawObservations) {
    if (!suite.profiles.includes(raw.profile) || !suite.cases.some((entry) => entry.id === raw.case_id)) continue;
    const pair = `${raw.profile}\u0000${raw.case_id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    observations.push(structuredClone(raw));
  }

  const upstreamSafe = observations.filter(
    (entry) =>
      entry.normal_path?.upstream_calls === 1 &&
      entry.integrity?.upstream_calls === 1 &&
      entry.forced_full_recovery?.upstream_calls === 0,
  );
  const exactRecoveries = observations.filter(
    (entry) =>
      entry.forced_full_recovery?.exact_hash_match === true &&
      entry.integrity?.direct_result_sha256 === entry.integrity?.recovered_result_sha256,
  );
  const fixedSurfaces = observations.filter((entry) => entry.normal_path?.advertised_tools === 3);
  const visibleTargets = observations.filter((entry) => entry.normal_path?.target_visible_in_initial_delivery === true);
  const summary = Object.fromEntries(
    suite.profiles.map((profile) => {
      const result = observations.find((entry) => entry.profile === profile);
      if (!result) return [profile, null];
      const { profile: _profile, case_id: _caseId, ...metrics } = result;
      return [profile, metrics];
    }),
  );
  const comparisons = Object.fromEntries(
    observations.map((entry) => [
      `${entry.profile}_normal_reduction_percent`,
      entry.normal_path?.reduction_percent ?? null,
    ]),
  );
  const hardGates = {
    complete_matrix: gate(expectedPairs.size, seenPairs.size, expectedPairs.size === seenPairs.size),
    fixed_three_tool_surface: gate(
      observations.length,
      fixedSurfaces.length,
      fixedSurfaces.length === expectedPairs.size,
    ),
    one_upstream_call: gate(observations.length, upstreamSafe.length, upstreamSafe.length === expectedPairs.size),
    exact_recovery: gate(observations.length, exactRecoveries.length, exactRecoveries.length === expectedPairs.size),
    target_visible: gate(observations.length, visibleTargets.length, visibleTargets.length === expectedPairs.size),
  };
  return { observations, summary, comparisons, hardGates };
}

function numericSamples(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
}

function parseFindToolResult(value) {
  const block = value?.content?.[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") return null;
  try {
    const parsed = JSON.parse(block.text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.matches)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toolNameSet(tools) {
  return new Set(
    Array.isArray(tools)
      ? tools.map((tool) => tool?.name).filter((name) => typeof name === "string" && name.length > 0)
      : [],
  );
}

function summarizeNumericSamples(samples) {
  return {
    sample_count: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

function deriveToolRetrievalObservation(raw, suiteCase) {
  const evidence = raw?._evidence && typeof raw._evidence === "object" ? raw._evidence : {};
  const authorizedTools = Array.isArray(evidence.authorized_tools) ? evidence.authorized_tools : [];
  const sourceTools = Array.isArray(evidence.source_tools) ? evidence.source_tools : [];
  const orderedAuthorizedTools = [...authorizedTools].sort((left, right) =>
    String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
  );
  const computedCatalogDigest = digest(orderedAuthorizedTools);
  const expectedCatalogDigest = suiteCase.catalog_digests?.[String(raw.pool_size)] ?? null;
  const parsed = parseFindToolResult(evidence.find_result);
  const matches = parsed?.matches ?? [];
  const matchNames = matches.map((match) => (typeof match?.name === "string" ? match.name : null));
  const returnedSchemaDigests = matches.map((match) =>
    match?.input_schema && typeof match.input_schema === "object" ? digest(match.input_schema) : null,
  );
  const expectedIndex = suiteCase.expected_no_match ? -1 : matchNames.indexOf(suiteCase.expected_tool);
  const returnedSchemaSha256 = expectedIndex >= 0 ? returnedSchemaDigests[expectedIndex] : null;
  const deniedNames = new Set(Array.isArray(suiteCase.denied_tools) ? suiteCase.denied_tools : []);
  const sourceNames = toolNameSet(sourceTools);
  const authorizedNames = toolNameSet(authorizedTools);
  const deniedExposureCount = matchNames.filter((name) => name !== null && deniedNames.has(name)).length;
  const authorizationFilterValid = [...deniedNames].every(
    (name) => sourceNames.has(name) && !authorizedNames.has(name),
  );
  const querySamples = numericSamples(raw.query_cpu_us_samples);
  const rankingSignature = digest(
    matches.map((match, index) => ({
      name: matchNames[index],
      input_schema_sha256: returnedSchemaDigests[index],
    })),
  );
  const evidenceAvailable =
    Array.isArray(evidence.authorized_tools) &&
    Array.isArray(evidence.source_tools) &&
    parsed !== null &&
    typeof raw.pool_size === "number";

  return {
    shareable: {
      profile: raw.profile,
      task_sha256: suiteCase.task_digest,
      language: suiteCase.language,
      retrieval_cohort: suiteCase.retrieval_cohort,
      pool_size: raw.pool_size,
      expected_no_match: suiteCase.expected_no_match === true,
      rank: expectedIndex >= 0 ? expectedIndex + 1 : null,
      match_count: matches.length,
      predicted_no_match: matches.length === 0,
      catalog_sha256: computedCatalogDigest,
      ranking_sha256: rankingSignature,
      returned_schema_sha256: returnedSchemaSha256,
      catalog_digest_match:
        evidenceAvailable &&
        computedCatalogDigest === expectedCatalogDigest &&
        parsed?.catalog_digest === computedCatalogDigest,
      schema_digest_match:
        suiteCase.expected_no_match === true ||
        expectedIndex < 0 ||
        returnedSchemaSha256 === suiteCase.expected_schema_sha256,
      maximum_three_matches: matches.length <= 3,
      denied_exposure_count: deniedExposureCount,
      authorization_filter_valid: authorizationFilterValid,
      query_cpu_us: summarizeNumericSamples(querySamples),
    },
    rankingSignature,
    querySamples,
    evidenceAvailable,
  };
}

function collectToolRetrievalMatrix(rawObservations, suite) {
  const expectedCases = new Map(suite.cases.map((suiteCase) => [suiteCase.id, suiteCase]));
  const allowedPools = new Set(suite.pool_sizes);
  const observations = new Map();
  let duplicates = 0;
  let invalid = 0;
  for (const raw of Array.isArray(rawObservations) ? rawObservations : []) {
    const suiteCase = expectedCases.get(raw?.case_id);
    if (!suiteCase || !suite.profiles.includes(raw?.profile) || !allowedPools.has(raw?.pool_size)) {
      invalid += 1;
      continue;
    }
    const key = `${raw.profile}\u0000${raw.case_id}\u0000${raw.pool_size}`;
    if (observations.has(key)) {
      duplicates += 1;
      continue;
    }
    observations.set(key, { raw, suiteCase, derived: deriveToolRetrievalObservation(raw, suiteCase) });
  }
  return { observations, duplicates, invalid };
}

function roundedRatio(numerator, denominator) {
  if (denominator === 0) return null;
  return Number((numerator / denominator).toFixed(6));
}

function toolRetrievalMetrics(entries) {
  const positives = entries.filter((entry) => !entry.expected_no_match);
  const predictedNoMatch = entries.filter((entry) => entry.predicted_no_match);
  const trueNoMatch = predictedNoMatch.filter((entry) => entry.expected_no_match);
  const reciprocalRanks = positives.map((entry) => (entry.rank === null ? 0 : 1 / entry.rank));
  const discountedGains = positives.map((entry) =>
    entry.rank === null || entry.rank > 3 ? 0 : 1 / Math.log2(entry.rank + 1),
  );
  return {
    observations: entries.length,
    positive_queries: positives.length,
    no_match_queries: entries.length - positives.length,
    recall_at_1: roundedRatio(positives.filter((entry) => entry.rank === 1).length, positives.length),
    recall_at_3: roundedRatio(
      positives.filter((entry) => entry.rank !== null && entry.rank <= 3).length,
      positives.length,
    ),
    mean_reciprocal_rank:
      positives.length === 0
        ? null
        : Number((reciprocalRanks.reduce((sum, value) => sum + value, 0) / positives.length).toFixed(6)),
    ndcg_at_3:
      positives.length === 0
        ? null
        : Number((discountedGains.reduce((sum, value) => sum + value, 0) / positives.length).toFixed(6)),
    no_match_precision: roundedRatio(trueNoMatch.length, predictedNoMatch.length),
    correct_no_match: trueNoMatch.length,
    predicted_no_match: predictedNoMatch.length,
  };
}

function groupedToolRetrievalMetrics(observations, key) {
  const groups = new Map();
  for (const observation of observations) {
    const value = String(observation[key]);
    const entries = groups.get(value) ?? [];
    entries.push(observation);
    groups.set(value, entries);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([value, entries]) => [value, toolRetrievalMetrics(entries)]),
  );
}

function deriveToolRetrievalPerformance(adapterResult, suite, derivedEntries) {
  const expectedKeys = new Set(
    suite.profiles.flatMap((profile) => suite.pool_sizes.map((poolSize) => `${profile}\u0000${poolSize}`)),
  );
  const samplesByKey = new Map();
  let duplicates = 0;
  let invalid = 0;
  for (const raw of Array.isArray(adapterResult.performance) ? adapterResult.performance : []) {
    const key = `${raw?.profile}\u0000${raw?.pool_size}`;
    const buildSamples = numericSamples(raw?.build_cpu_us_samples);
    const retainedSamples = numericSamples(raw?.retained_heap_bytes_samples);
    if (!expectedKeys.has(key) || buildSamples.length === 0 || retainedSamples.length === 0) {
      invalid += 1;
      continue;
    }
    if (samplesByKey.has(key)) {
      duplicates += 1;
      continue;
    }
    samplesByKey.set(key, {
      profile: raw.profile,
      pool_size: raw.pool_size,
      buildSamples,
      retainedSamples,
    });
  }

  const summary = {};
  for (const profile of suite.profiles) {
    summary[profile] = {};
    for (const poolSize of suite.pool_sizes) {
      const key = `${profile}\u0000${poolSize}`;
      const performance = samplesByKey.get(key);
      const querySamples = derivedEntries
        .filter((entry) => entry.shareable.profile === profile && entry.shareable.pool_size === poolSize)
        .flatMap((entry) => entry.querySamples);
      summary[profile][String(poolSize)] = {
        query_cpu_us: summarizeNumericSamples(querySamples),
        build_cpu_us: summarizeNumericSamples(performance?.buildSamples ?? []),
        retained_heap_bytes: summarizeNumericSamples(performance?.retainedSamples ?? []),
      };
    }
  }
  const complete =
    samplesByKey.size === expectedKeys.size &&
    duplicates === 0 &&
    invalid === 0 &&
    derivedEntries.every((entry) => entry.querySamples.length > 0);
  return { summary, complete, expected: expectedKeys.size, actual: samplesByKey.size, duplicates, invalid };
}

function assessToolRetrieval(suite, adapterResult) {
  const expectedKeys = new Set(
    suite.profiles.flatMap((profile) =>
      suite.cases.flatMap((suiteCase) =>
        suite.pool_sizes.map((poolSize) => `${profile}\u0000${suiteCase.id}\u0000${poolSize}`),
      ),
    ),
  );
  const primary = collectToolRetrievalMatrix(adapterResult.observations, suite);
  const repeat = collectToolRetrievalMatrix(adapterResult.repeat_observations, suite);
  const derivedEntries = [...primary.observations.values()].map((entry) => entry.derived);
  const observations = derivedEntries.map((entry) => entry.shareable);
  const deterministicMismatches = [];
  for (const key of expectedKeys) {
    const first = primary.observations.get(key)?.derived;
    const second = repeat.observations.get(key)?.derived;
    if (first && second && first.rankingSignature !== second.rankingSignature) deterministicMismatches.push(key);
  }
  const performance = deriveToolRetrievalPerformance(adapterResult, suite, derivedEntries);
  const exactExpected =
    suite.profiles.length *
    suite.pool_sizes.length *
    suite.cases.filter((suiteCase) => suiteCase.retrieval_cohort === "exact-identifier").length;
  const exactSuccessful = observations.filter(
    (entry) => entry.retrieval_cohort === "exact-identifier" && entry.rank !== null && entry.rank <= 3,
  ).length;
  const catalogMismatches = observations.filter((entry) => !entry.catalog_digest_match);
  const schemaMismatches = observations.filter((entry) => !entry.schema_digest_match);
  const oversized = observations.filter((entry) => !entry.maximum_three_matches);
  const deniedExposure = observations.reduce((sum, entry) => sum + entry.denied_exposure_count, 0);
  const authorizationFailures = observations.filter((entry) => !entry.authorization_filter_valid);
  const missingEvidence = derivedEntries.filter((entry) => !entry.evidenceAvailable);
  const completePrimary = primary.observations.size === expectedKeys.size;
  const completeRepeat = repeat.observations.size === expectedKeys.size;
  const uniqueMatrix =
    primary.duplicates === 0 && repeat.duplicates === 0 && primary.invalid === 0 && repeat.invalid === 0;

  const hardGates = {
    complete_matrix: gate(
      expectedKeys.size * 2,
      primary.observations.size + repeat.observations.size,
      completePrimary && completeRepeat,
    ),
    unique_matrix: gate(0, primary.duplicates + repeat.duplicates + primary.invalid + repeat.invalid, uniqueMatrix),
    complete_performance: gate(performance.expected, performance.actual, performance.complete),
    raw_evidence: gate(0, missingEvidence.length, missingEvidence.length === 0),
    catalog_digest: gate(0, catalogMismatches.length, catalogMismatches.length === 0),
    deterministic_ranking: gate(0, deterministicMismatches.length, deterministicMismatches.length === 0),
    maximum_three_matches: gate(0, oversized.length, oversized.length === 0),
    exact_identifier_recall_at_3: gate(
      exactExpected,
      exactSuccessful,
      exactExpected > 0 && exactSuccessful === exactExpected,
    ),
    denied_exposure: gate(0, deniedExposure, deniedExposure === 0),
    authorization_filter: gate(0, authorizationFailures.length, authorizationFailures.length === 0),
    schema_digest: gate(0, schemaMismatches.length, schemaMismatches.length === 0),
  };
  const summary = {
    observation_count: observations.length,
    expected_observation_count: expectedKeys.size,
    metrics: {
      overall: toolRetrievalMetrics(observations),
      by_profile: groupedToolRetrievalMetrics(observations, "profile"),
      by_pool_size: groupedToolRetrievalMetrics(observations, "pool_size"),
      by_cohort: groupedToolRetrievalMetrics(observations, "retrieval_cohort"),
      by_language: groupedToolRetrievalMetrics(observations, "language"),
    },
    performance: performance.summary,
  };
  const inconclusive = !completePrimary || !completeRepeat || !uniqueMatrix || !performance.complete;
  return { observations, summary, comparisons: {}, hardGates, inconclusive };
}

function methodology(kind, adapterId) {
  if (kind === "host-task") {
    return {
      kind: "paired real-Host task completion with runner-owned scoring",
      adapter: adapterId,
      accounting: "provider-reported usage when complete, plus independently counted model-visible MCP payloads",
      exact_recovery:
        "Projected snapshots are forcibly recovered after the task and compared with the immutable source outside the normal task path.",
      upstream_call_accounting:
        "The Runner derives business and recovery counts from captured fixture events; Adapter-authored counts are ignored.",
      limitation:
        "A report is inconclusive without complete candidate, fixture, Host, model, paired-arm, and infrastructure evidence.",
    };
  }
  if (kind === "result-projection") {
    return {
      kind: "deterministic quota-free result projection and exact recovery",
      adapter: adapterId,
      accounting: "model-visible MCP response payloads for initial delivery, targeted retrieval, and full recovery",
      exact_recovery: "Every projected fixture is reconstructed and compared with its immutable source result.",
      upstream_call_accounting: "The in-process result fixture performs no external or model calls.",
      limitation: "Literal-query fixture evidence does not measure semantic retrieval or real Host task completion.",
    };
  }
  if (kind === "stress") {
    return {
      kind: "deterministic 100-tool and 8,000-row protocol stress replay",
      adapter: adapterId,
      accounting: "prompt plus every model-visible MCP request and response payload",
      exact_recovery: "The Runner requires the recovered result hash to equal the immutable direct-result hash.",
      upstream_call_accounting: "The Runner requires one business call and zero additional calls during recovery.",
      limitation: "The synthetic stress fixture does not measure model tool selection or a typical session.",
    };
  }
  if (kind === "selective-retrieval") {
    return {
      kind: "deterministic selective retrieval from immutable local result snapshots",
      adapter: adapterId,
      accounting:
        "Runner-owned model-visible tokens for direct result, initial delivery, targeted query, sequential reading, and forced full recovery",
      exact_recovery: "The Runner compares immutable source and complete cursor-recovery hashes.",
      upstream_call_accounting: "The Runner requires one business call and zero query or recovery-time upstream calls.",
      limitation:
        "Forced full recovery is separate verification traffic; literal-query fixtures do not establish semantic retrieval or real Host task completion.",
    };
  }
  if (kind === "tool-retrieval") {
    return {
      kind: "deterministic authorized Tool retrieval from frozen private catalogs",
      adapter: adapterId,
      accounting: "Runner-derived ranks and quality metrics plus Adapter-measured local CPU and retained heap samples",
      exact_recovery: "Not applicable; this suite evaluates find_tool discovery and complete schema identity only.",
      upstream_call_accounting:
        "find_tool is exercised through the in-process Kernel and must not invoke an upstream Tool.",
      limitation:
        "Deterministic retrieval quality and local performance do not establish real Host task completion or provider savings.",
    };
  }
  return {
    kind: "deterministic successful protocol replay by mode",
    adapter: adapterId,
    accounting: "prompt plus every captured MCP tools/list and tools/call request and response payload",
    exact_recovery: "Recovered content hashes are compared with the direct baseline result for the same case.",
    upstream_call_accounting: "The Runner counts fixture audit observations and requires one business call per case.",
    limitation: "No model selects Tools; this report measures successful-path protocol cost, not model accuracy.",
  };
}

export async function evaluate(request) {
  validateRequest(request);
  const hostTask = request.suite.kind === "host-task";
  const adapterResult = hostTask
    ? await collectHostTaskAdapterResult(request)
    : await request.adapter.run({ suite: structuredClone(request.suite) });
  assertObject(adapterResult, "adapter result");
  if (!Array.isArray(adapterResult.observations)) {
    throw new TypeError("adapter result observations must be an array");
  }

  const candidate = request.candidate ?? {
    kind: "unidentified",
    digest: UNKNOWN_DIGEST,
    package_version: "unknown",
  };
  const fixtureDigest = request.suite.fixture_digest ?? UNKNOWN_DIGEST;
  const measurement = createEvaluationMeasurement(request.environment.tokenizer);
  try {
    const assessment = hostTask
      ? assessHostTask(request.suite, adapterResult, request.environment, request.candidate, measurement)
      : request.suite.kind === "result-projection"
        ? assessResultProjection(request.suite, adapterResult)
        : request.suite.kind === "selective-retrieval"
          ? assessSelectiveRetrieval(request.suite, adapterResult, measurement)
          : request.suite.kind === "tool-retrieval"
            ? assessToolRetrieval(request.suite, adapterResult)
            : request.suite.kind === "stress"
              ? assessStress(request.suite, adapterResult.observations)
              : assessProtocolReplay(request.suite, adapterResult.observations, measurement);
    const passed = Object.values(assessment.hardGates).every((entry) => entry.passed);
    const verdict = assessment.inconclusive
      ? "inconclusive"
      : assessment.hardGates.complete_matrix.passed
        ? passed
          ? "pass"
          : "fail"
        : "inconclusive";
    return {
      schema_version: EVALUATION_REPORT_SCHEMA_VERSION,
      candidate: structuredClone(candidate),
      suite: {
        schema_version: request.suite.schema_version,
        id: request.suite.id,
        kind: request.suite.kind,
        manifest_sha256: digest(request.suite),
        fixture_sha256: fixtureDigest,
        case_count: request.suite.cases.length,
        profiles: [...request.suite.profiles],
        ...(request.suite.kind === "tool-retrieval"
          ? {
              corpus_sha256: request.suite.corpus_digest,
              pool_sizes: [...request.suite.pool_sizes],
            }
          : {}),
      },
      environment: structuredClone(request.environment),
      methodology: methodology(request.suite.kind, request.adapter.id),
      observations: assessment.observations,
      comparisons: assessment.comparisons,
      hard_gates: assessment.hardGates,
      verdict,
      summary: assessment.summary,
    };
  } finally {
    measurement.close();
  }
}
