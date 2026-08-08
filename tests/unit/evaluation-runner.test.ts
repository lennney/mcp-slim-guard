import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluationSha256 } from "../../scripts/evaluation/evaluation-measurement.mjs";
import { evaluate } from "../../scripts/evaluation/evaluation-runner.mjs";

const digest = "a".repeat(64);

const retrievalSchema = {
  type: "object",
  properties: {
    repository: { type: "string", description: "private schema marker" },
  },
  required: ["repository"],
  additionalProperties: false,
};

function retrievalTool(name: string, description = "Read a repository") {
  return {
    name,
    title: `Title for ${name}`,
    description,
    inputSchema: structuredClone(retrievalSchema),
  };
}

function retrievalCatalogDigest(tools: Array<ReturnType<typeof retrievalTool>>) {
  return evaluationSha256([...tools].sort((left, right) => left.name.localeCompare(right.name)));
}

function retrievalResponse(catalogDigest: string, tools: Array<ReturnType<typeof retrievalTool>>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          catalog_digest: catalogDigest,
          matches: tools.map(({ inputSchema, ...metadata }, index) => ({
            ...metadata,
            tool_ref: `tool_${catalogDigest.slice(0, 16)}_${index}`,
            input_schema: inputSchema,
          })),
        }),
      },
    ],
  };
}

describe("evaluation runner", () => {
  it("derives a failing verdict from observations instead of trusting adapter claims", async () => {
    const report = await evaluate({
      candidate: {
        kind: "working-tree",
        digest,
        package_version: "0.2.0-alpha.1",
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "forged-adapter-contract",
        kind: "protocol-replay",
        fixture_digest: digest,
        profiles: ["baseline"],
        cases: [
          {
            id: "case-1",
            language: "en",
            prompt: "Call the expected Tool.",
            expected_tool: "expected_tool",
            expected_marker: "EXPECTED_MARKER",
          },
        ],
        expected_advertised_tool_counts: { baseline: 1 },
      },
      adapter: {
        id: "forged-adapter",
        async run() {
          return {
            verdict: "pass",
            hard_gates: { all_tasks_successful: { passed: true } },
            observations: [
              {
                profile: "baseline",
                case_id: "case-1",
                advertised_tools: ["wrong_tool"],
                upstream_invocations: [{ tool: "wrong_tool" }, { tool: "wrong_tool" }],
                events: [],
                final_result: { content: [{ type: "text", text: "forged success" }] },
                recovered_result: null,
              },
            ],
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.all_tasks_successful.passed).toBe(false);
    expect(report.hard_gates.one_upstream_call.passed).toBe(false);
    expect(report).not.toHaveProperty("adapter_verdict");
  });

  it("publishes versioned suite and report schemas for the evaluation Interface", () => {
    const schemaDirectory = path.resolve("scripts/evaluation/schemas");
    const suiteSchema = JSON.parse(fs.readFileSync(path.join(schemaDirectory, "suite-manifest.schema.json"), "utf8"));
    const reportSchema = JSON.parse(
      fs.readFileSync(path.join(schemaDirectory, "evaluation-report.schema.json"), "utf8"),
    );

    expect(suiteSchema).toMatchObject({
      $id: "https://github.com/lennney/mcp-slim-guard/schemas/evaluation-suite-v1.json",
      properties: {
        schema_version: { const: 1 },
        kind: {
          enum: [
            "protocol-replay",
            "result-projection",
            "selective-retrieval",
            "tool-retrieval",
            "stress",
            "host-task",
          ],
        },
        required_evidence: {
          properties: {
            tool_search_arms: { items: { enum: ["direct", "oracle", "native", "compact", "extreme"] } },
          },
        },
      },
    });
    expect(suiteSchema.required).toEqual(
      expect.arrayContaining(["schema_version", "id", "kind", "fixture_digest", "profiles", "cases"]),
    );
    expect(reportSchema).toMatchObject({
      $id: "https://github.com/lennney/mcp-slim-guard/schemas/evaluation-report-v1.json",
      properties: {
        schema_version: { const: 1 },
        verdict: { enum: ["pass", "fail", "inconclusive"] },
      },
    });
    expect(reportSchema.required).toEqual(
      expect.arrayContaining([
        "candidate",
        "suite",
        "environment",
        "observations",
        "comparisons",
        "hard_gates",
        "verdict",
      ]),
    );
  });

  it("returns inconclusive when the adapter does not supply the required observation matrix", async () => {
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "missing-observations",
        kind: "protocol-replay",
        fixture_digest: digest,
        profiles: ["baseline"],
        cases: [
          {
            id: "case-1",
            language: "en",
            prompt: "Call the Tool.",
            expected_tool: "expected_tool",
            expected_marker: "EXPECTED_MARKER",
          },
        ],
        expected_advertised_tool_counts: { baseline: 1 },
      },
      adapter: {
        id: "empty-adapter",
        async run() {
          return { observations: [] };
        },
      },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.hard_gates.complete_matrix).toEqual({ passed: false, expected: 1, actual: 0 });
  });

  it("fails a projected observation when the adapter omits exact recovery evidence", async () => {
    const projected = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            preview: "EXPECTED_MARKER",
            result_ref: `result_${"1".repeat(32)}`,
            replay_cursor: 0,
          }),
        },
      ],
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "missing-recovery",
        kind: "protocol-replay",
        fixture_digest: digest,
        profiles: ["compact"],
        cases: [
          {
            id: "case-1",
            language: "en",
            prompt: "Call the Tool.",
            expected_tool: "expected_tool",
            expected_marker: "EXPECTED_MARKER",
          },
        ],
        expected_advertised_tool_counts: { compact: 3 },
      },
      adapter: {
        id: "missing-recovery-adapter",
        async run() {
          return {
            observations: [
              {
                profile: "compact",
                case_id: "case-1",
                advertised_tools: ["find_tool", "call_tool", "read_result"],
                upstream_invocations: [{ tool: "expected_tool" }],
                events: [{ kind: "invoke", request: {}, response: projected }],
                final_result: projected,
                recovered_result: null,
              },
            ],
          };
        },
      },
    });

    expect(report.hard_gates.all_tasks_successful.passed).toBe(true);
    expect(report.hard_gates.exact_recovery.passed).toBe(false);
    expect(report.verdict).toBe("fail");
  });

  it("derives result-projection gates and strips preview bodies from the report", async () => {
    const projection = {
      profile: "compact",
      case_id: "plain-middle",
      category: "plain-text",
      projection: "head-tail-v1",
      initial_tokens: 100,
      target_total_tokens: 1_000,
      query_total_tokens: 200,
      target_contains_marker: false,
      query_contains_marker: false,
      content_kind: "plain-text",
      content_kind_matches: false,
      compression_cpu_ms: 1,
      exact_recovery: false,
      payload_sha256: digest,
      _evidence: {
        source_result: { content: [{ type: "text", text: "complete source" }] },
        recovered_result: { content: [{ type: "text", text: "complete source" }] },
        initial_delivery: { content: [{ type: "text", text: "preview" }] },
        targeted_responses: [{ content: [{ type: "text", text: "EXPECTED_MARKER" }] }],
        query_response: { content: [{ type: "text", text: "EXPECTED_MARKER" }] },
      },
      deterministic_projection: {
        projection: "head-tail-v1",
        preview: "private fixture preview",
        preview_ranges: [{ start: 0, end: 10 }],
      },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "result-projection",
        kind: "result-projection",
        fixture_digest: digest,
        profiles: ["compact"],
        cases: [
          {
            id: "plain-middle",
            category: "plain-text",
            expected_marker: "EXPECTED_MARKER",
            expected_content_kind: "plain-text",
          },
        ],
      },
      adapter: {
        id: "result-projection-adapter",
        async run() {
          return {
            verdict: "fail",
            observations: [projection],
            repeat_observations: [structuredClone(projection)],
          };
        },
      },
    });

    expect(report.verdict).toBe("pass");
    expect(report.hard_gates).toMatchObject({
      complete_matrix: { passed: true },
      exact_recovery: { passed: true },
      literal_query_retrieval: { passed: true },
      sequential_retrieval: { passed: true },
      content_classification: { passed: true },
      deterministic_capture: { passed: true },
    });
    expect(JSON.stringify(report)).not.toContain("private fixture preview");
    expect(JSON.stringify(report)).not.toContain("complete source");
    expect(report.comparisons.compact_query_vs_sequential_percent).toBe(80);
  });

  it("derives stress gates instead of trusting adapter claims", async () => {
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "stress",
        kind: "stress",
        fixture_digest: digest,
        profiles: ["compact"],
        cases: [{ id: "100-tools-8000-rows" }],
      },
      adapter: {
        id: "forged-stress-adapter",
        async run() {
          return {
            verdict: "pass",
            observations: [
              {
                profile: "compact",
                case_id: "100-tools-8000-rows",
                normal_path: {
                  direct_tokens: 10_000,
                  mode_tokens: 1_000,
                  reduction_percent: 90,
                  advertised_tools: 3,
                  upstream_calls: 2,
                  target_visible_in_initial_delivery: true,
                },
                forced_full_recovery: {
                  direct_tokens: 10_000,
                  mode_tokens: 11_000,
                  read_result_calls: 2,
                  exact_hash_match: false,
                  upstream_calls: 1,
                },
                integrity: {
                  direct_result_sha256: digest,
                  recovered_result_sha256: "b".repeat(64),
                  upstream_calls: 2,
                },
              },
            ],
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.one_upstream_call.passed).toBe(false);
    expect(report.hard_gates.exact_recovery.passed).toBe(false);
  });

  it("derives selective-retrieval gates from redacted raw evidence", async () => {
    const source = { content: [{ type: "text", text: `prefix ${"x".repeat(500)} TARGET-73` }] };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "selective-retrieval",
        kind: "selective-retrieval",
        fixture_digest: digest,
        profiles: ["compact"],
        cases: [
          {
            id: "literal-middle",
            category: "plain-text",
            expected_marker: "TARGET-73",
            query_cohort: "exact",
            expected_query_outcome: "match",
            expected_delivery: "projected",
            minimum_target_reduction_percent: 50,
          },
        ],
      },
      adapter: {
        id: "forged-selective-retrieval-adapter",
        async run() {
          const observation = {
            profile: "compact",
            case_id: "literal-middle",
            category: "plain-text",
            delivery: "projected",
            query_match_count: 1,
            upstream_events: [{ phase: "business" }, { phase: "query" }],
            query_contains_marker: true,
            exact_recovery: true,
            direct_result_tokens: 1,
            forced_recovery_calls: 999,
            forced_recovery_response_tokens: 1,
            _evidence: {
              source_result: source,
              delivered_result: { content: [{ type: "text", text: "short preview" }] },
              recovered_result: source,
              query_response: { content: [{ type: "text", text: "unrelated fragment" }] },
              sequential_responses: [source],
              recovery_responses: [source],
            },
          };
          return { observations: [observation], repeat_observations: [structuredClone(observation)] };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.zero_recovery_upstream_calls.passed).toBe(false);
    expect(report.hard_gates.literal_target_recall.passed).toBe(false);
    expect(report.hard_gates.forced_recovery_accounting.passed).toBe(true);
    expect(report.observations[0].forced_recovery_calls).toBe(1);
    expect(report.observations[0].direct_result_tokens).toBeGreaterThan(report.observations[0].initial_tokens);
    expect(report.observations[0].forced_recovery_response_tokens).toBeGreaterThan(1);
    expect(report.observations[0].forced_recovery_total_tokens).toBe(
      report.observations[0].initial_tokens + report.observations[0].forced_recovery_response_tokens,
    );
    expect(report.observations[0].recovery_responses_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(report)).not.toContain("unrelated fragment");
    expect(JSON.stringify(report)).not.toContain("TARGET-73");
  });

  it("derives tool-retrieval quality and redacts private evidence", async () => {
    const gold = retrievalTool("github_read_repository");
    const irrelevant = retrievalTool("calendar_list_events", "List calendar events");
    const denied = retrievalTool("denied_repository_export", "Read and export a repository");
    const positiveCatalog = [gold];
    const noMatchCatalog = [irrelevant];
    const positiveDigest = retrievalCatalogDigest(positiveCatalog);
    const noMatchDigest = retrievalCatalogDigest(noMatchCatalog);
    const observations = [
      {
        profile: "heuristic-v1",
        case_id: "private-positive-case",
        pool_size: 10,
        query_cpu_us_samples: [10, 11, 12],
        score: 999,
        verdict: "pass",
        _evidence: {
          query: "PRIVATE QUERY read the repository",
          source_tools: [...positiveCatalog, denied],
          authorized_tools: positiveCatalog,
          find_result: retrievalResponse(positiveDigest, [gold]),
        },
      },
      {
        profile: "heuristic-v1",
        case_id: "private-no-match-case",
        pool_size: 10,
        query_cpu_us_samples: [7, 8, 9],
        _evidence: {
          query: "PRIVATE QUERY no matching capability",
          source_tools: [...noMatchCatalog, denied],
          authorized_tools: noMatchCatalog,
          find_result: retrievalResponse(noMatchDigest, []),
        },
      },
    ];
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "tool-retrieval-contract",
        kind: "tool-retrieval",
        fixture_digest: digest,
        corpus_digest: "b".repeat(64),
        profiles: ["heuristic-v1"],
        pool_sizes: [10],
        cases: [
          {
            id: "private-positive-case",
            task_digest: "c".repeat(64),
            language: "en",
            retrieval_cohort: "exact-identifier",
            expected_tool: gold.name,
            expected_schema_sha256: evaluationSha256(gold.inputSchema),
            catalog_digests: { "10": positiveDigest },
            denied_tools: [denied.name],
          },
          {
            id: "private-no-match-case",
            task_digest: "d".repeat(64),
            language: "en",
            retrieval_cohort: "no-match",
            expected_no_match: true,
            catalog_digests: { "10": noMatchDigest },
            denied_tools: [denied.name],
          },
        ],
      },
      adapter: {
        id: "forged-tool-retrieval-adapter",
        async run() {
          return {
            verdict: "pass",
            recall_at_1: 1,
            observations,
            repeat_observations: structuredClone(observations),
            performance: [
              {
                profile: "heuristic-v1",
                pool_size: 10,
                build_cpu_us_samples: [100, 110, 120],
                retained_heap_bytes_samples: [1_000, 1_100, 1_200],
              },
            ],
          };
        },
      },
    });

    expect(report.verdict).toBe("pass");
    expect(report.summary.metrics.overall).toMatchObject({
      recall_at_1: 1,
      recall_at_3: 1,
      mean_reciprocal_rank: 1,
      ndcg_at_3: 1,
      no_match_precision: 1,
    });
    expect(report.hard_gates.exact_identifier_recall_at_3.passed).toBe(true);
    const shareable = JSON.stringify(report);
    for (const secret of ["PRIVATE QUERY", gold.name, denied.name, "private schema marker", "private-positive-case"]) {
      expect(shareable).not.toContain(secret);
    }
    expect(report.observations[0]).not.toHaveProperty("score");
    expect(report.observations[0]).not.toHaveProperty("_evidence");
  });

  it("fails tool-retrieval evidence violations instead of trusting Adapter claims", async () => {
    const gold = retrievalTool("github_read_repository");
    const denied = retrievalTool("denied_repository_export");
    const extra = [retrievalTool("extra_one"), retrievalTool("extra_two"), retrievalTool("extra_three")];
    const wrongGold = {
      ...gold,
      inputSchema: {
        type: "object",
        properties: { wrong: { type: "boolean" } },
        required: ["wrong"],
      },
    };
    const catalog = [gold];
    const catalogDigest = retrievalCatalogDigest(catalog);
    const observation = {
      profile: "heuristic-v1",
      case_id: "violations",
      pool_size: 10,
      query_cpu_us_samples: [10],
      _evidence: {
        query: "read repository",
        source_tools: [gold, denied],
        authorized_tools: catalog,
        find_result: retrievalResponse("f".repeat(64), [wrongGold, denied, ...extra.slice(0, 2)]),
      },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: { node: process.version, platform: process.platform, arch: process.arch, tokenizer: "o200k_base" },
      suite: {
        schema_version: 1,
        id: "tool-retrieval-violations",
        kind: "tool-retrieval",
        fixture_digest: digest,
        corpus_digest: "b".repeat(64),
        profiles: ["heuristic-v1"],
        pool_sizes: [10],
        cases: [
          {
            id: "violations",
            task_digest: "c".repeat(64),
            language: "en",
            retrieval_cohort: "exact-identifier",
            expected_tool: gold.name,
            expected_schema_sha256: "e".repeat(64),
            catalog_digests: { "10": catalogDigest },
            denied_tools: [denied.name],
          },
        ],
      },
      adapter: {
        id: "forged-violation-adapter",
        async run() {
          return {
            observations: [observation],
            repeat_observations: [structuredClone(observation)],
            performance: [
              {
                profile: "heuristic-v1",
                pool_size: 10,
                build_cpu_us_samples: [100],
                retained_heap_bytes_samples: [1_000],
              },
            ],
            hard_gates: { denied_exposure: { passed: true } },
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.catalog_digest.passed).toBe(false);
    expect(report.hard_gates.maximum_three_matches.passed).toBe(false);
    expect(report.hard_gates.denied_exposure.passed).toBe(false);
    expect(report.hard_gates.schema_digest.passed).toBe(false);
  });

  it("marks an incomplete or duplicate tool-retrieval matrix inconclusive", async () => {
    const tool = retrievalTool("github_read_repository");
    const catalogDigest = retrievalCatalogDigest([tool]);
    const observation = {
      profile: "heuristic-v1",
      case_id: "matrix-case",
      pool_size: 10,
      query_cpu_us_samples: [10],
      _evidence: {
        query: "read repository",
        source_tools: [tool],
        authorized_tools: [tool],
        find_result: retrievalResponse(catalogDigest, [tool]),
      },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: { node: process.version, platform: process.platform, arch: process.arch, tokenizer: "o200k_base" },
      suite: {
        schema_version: 1,
        id: "tool-retrieval-incomplete",
        kind: "tool-retrieval",
        fixture_digest: digest,
        corpus_digest: "b".repeat(64),
        profiles: ["heuristic-v1"],
        pool_sizes: [10, 100],
        cases: [
          {
            id: "matrix-case",
            task_digest: "c".repeat(64),
            language: "en",
            retrieval_cohort: "exact-identifier",
            expected_tool: tool.name,
            expected_schema_sha256: evaluationSha256(tool.inputSchema),
            catalog_digests: { "10": catalogDigest, "100": "f".repeat(64) },
            denied_tools: [],
          },
        ],
      },
      adapter: {
        id: "incomplete-tool-retrieval-adapter",
        async run() {
          return {
            observations: [observation, structuredClone(observation)],
            repeat_observations: [structuredClone(observation)],
            performance: [],
          };
        },
      },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.hard_gates.complete_matrix.passed).toBe(false);
    expect(report.hard_gates.unique_matrix.passed).toBe(false);
    expect(report.hard_gates.complete_performance.passed).toBe(false);
  });

  it("fails a non-deterministic tool-retrieval repeat", async () => {
    const gold = retrievalTool("github_read_repository");
    const neighbor = retrievalTool("github_list_repository");
    const catalog = [gold, neighbor];
    const catalogDigest = retrievalCatalogDigest(catalog);
    const observation = {
      profile: "heuristic-v1",
      case_id: "determinism-case",
      pool_size: 10,
      query_cpu_us_samples: [10],
      _evidence: {
        query: "read repository",
        source_tools: catalog,
        authorized_tools: catalog,
        find_result: retrievalResponse(catalogDigest, [gold, neighbor]),
      },
    };
    const repeat = structuredClone(observation);
    repeat._evidence.find_result = retrievalResponse(catalogDigest, [neighbor, gold]);
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: { node: process.version, platform: process.platform, arch: process.arch, tokenizer: "o200k_base" },
      suite: {
        schema_version: 1,
        id: "tool-retrieval-determinism",
        kind: "tool-retrieval",
        fixture_digest: digest,
        corpus_digest: "b".repeat(64),
        profiles: ["heuristic-v1"],
        pool_sizes: [10],
        cases: [
          {
            id: "determinism-case",
            task_digest: "c".repeat(64),
            language: "en",
            retrieval_cohort: "exact-identifier",
            expected_tool: gold.name,
            expected_schema_sha256: evaluationSha256(gold.inputSchema),
            catalog_digests: { "10": catalogDigest },
            denied_tools: [],
          },
        ],
      },
      adapter: {
        id: "non-deterministic-tool-retrieval-adapter",
        async run() {
          return {
            observations: [observation],
            repeat_observations: [repeat],
            performance: [
              {
                profile: "heuristic-v1",
                pool_size: 10,
                build_cpu_us_samples: [100],
                retained_heap_bytes_samples: [1_000],
              },
            ],
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.deterministic_ranking.passed).toBe(false);
  });

  it("scores a five-arm host task matrix without exposing gold labels to the Adapter", async () => {
    const adapterInputs: Array<Record<string, unknown>> = [];
    const host = {
      name: "fake-host",
      version: "1.0.0",
      model: "fake-model",
      reasoning_effort: "low",
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "host-task-contract",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "oracle", "native", "compact", "extreme"],
        repetitions: { direct: 1, oracle: 1, native: 1, compact: 1, extreme: 1 },
        order_seed: "fixed-host-order-v1",
        limits: { timeout_ms: 180_000, max_mcp_calls: 20 },
        cases: [
          {
            id: "stateful-write",
            language: "en",
            category: "nested-arguments",
            prompt: "Complete the stateful fixture task.",
            expected_tool: "write_record",
            expected_marker: "PRIVATE_EXPECTED_MARKER",
            expected_final_state: { saved: true },
            side_effecting: true,
            denied_tools: ["denied_write_record"],
            tool_schemas: {
              write_record: {
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["record"],
                  properties: {
                    record: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "tags"],
                      properties: {
                        name: { const: "alpha" },
                        tags: { type: "array", minItems: 1, items: { enum: ["safe"] } },
                      },
                    },
                  },
                },
              },
            },
            server_definitions: Object.fromEntries(
              ["direct", "oracle", "native", "compact", "extreme"].map((arm) => [
                arm,
                { name: "fixture", command: "node", args: ["fixture.mjs", arm] },
              ]),
            ),
            output_schema: { type: "object" },
          },
          {
            id: "no-match",
            language: "zh",
            category: "no-match",
            prompt: "Return no_match when no authorized Tool can do the task.",
            expected_no_match: true,
            denied_tools: ["perfect_but_denied"],
            server_definitions: Object.fromEntries(
              ["direct", "oracle", "native", "compact", "extreme"].map((arm) => [
                arm,
                { name: "fixture", command: "node", args: ["fixture.mjs", arm] },
              ]),
            ),
            output_schema: { type: "object" },
          },
        ],
      },
      adapter: {
        id: "fake-host-adapter",
        async run(input: Record<string, unknown>) {
          adapterInputs.push(input);
          const serialized = JSON.stringify(input);
          expect(serialized).not.toContain("PRIVATE_EXPECTED_MARKER");
          expect(serialized).not.toContain("expected_tool");
          expect(serialized).not.toContain("expected_final_state");
          const noMatch = String(input.prompt).includes("no_match");
          const arm = String(input.arm);
          const source = { content: [{ type: "text", text: "captured source" }] };
          return {
            verdict: "pass",
            score: { task_completion: false },
            status: "completed",
            host,
            duration_ms: 25,
            final_response: noMatch
              ? { status: "no_match" }
              : { status: "completed", marker: "PRIVATE_EXPECTED_MARKER" },
            _evidence: noMatch
              ? {
                  tool_calls: [],
                  upstream_events: [],
                  discovered_tools: [],
                  ranked_tools: [],
                  builtin_tool_calls: [],
                  mcp_events: [],
                }
              : {
                  tool_calls: [
                    {
                      phase: "business",
                      tool: "write_record",
                      arguments: { record: { name: "alpha", tags: ["safe"] } },
                    },
                  ],
                  upstream_events: [{ phase: "business", tool: "write_record" }],
                  discovered_tools: ["write_record"],
                  ranked_tools: ["write_record"],
                  builtin_tool_calls: [],
                  mcp_events: [{ request: { method: "tools/call" }, response: { ok: true } }],
                  final_state: { saved: true },
                  projection_used: ["compact", "extreme"].includes(arm),
                  source_result: source,
                  recovered_result: source,
                },
          };
        },
      },
    });

    expect(adapterInputs).toHaveLength(10);
    expect(Object.keys(adapterInputs[0]).sort()).toEqual(
      ["arm", "limits", "output_schema", "prompt", "repetition", "run_id", "server_definition"].sort(),
    );
    expect(report.verdict).toBe("pass");
    expect(report.hard_gates).toMatchObject({
      complete_matrix: { passed: true, expected: 10, actual: 10 },
      paired_task_non_inferiority: { passed: true },
      side_effecting_first_arguments: { passed: true },
      unauthorized_tool_exposure: { passed: true },
      exact_recovery: { passed: true, expected: 2, actual: 2 },
    });
    expect(report.summary.compact.provider_usage).toEqual({ status: "unavailable" });
    expect(report.summary.compact.pass_at_1).toBe(1);
    expect(report.comparisons.compact_vs_direct.task_completion.lower_95).toBe(0);
    expect(JSON.stringify(report)).not.toContain("PRIVATE_EXPECTED_MARKER");
    expect(JSON.stringify(report)).not.toContain("stateful-write");
    expect(JSON.stringify(report)).not.toContain('record":{');
  });

  it("treats final states with different object key order as exactly equal", async () => {
    const host = { name: "fake-host", version: "1", model: "fake-model", reasoning_effort: "low" };
    const expectedState = {
      task_id: "ordered-state",
      completed: true,
      tool: "write_record",
      arguments: { service: "api", replicas: 3 },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "key-order-independent-final-state",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct"],
        repetitions: { direct: 1 },
        cases: [
          {
            id: "ordered-state",
            prompt: "Write the record.",
            expected_tool: "write_record",
            expected_marker: "DONE",
            expected_final_state: expectedState,
            tool_schemas: {
              write_record: {
                inputSchema: {
                  type: "object",
                  required: ["service", "replicas"],
                  properties: {
                    service: { type: "string" },
                    replicas: { type: "integer" },
                  },
                },
              },
            },
          },
        ],
      },
      adapter: {
        id: "reordered-state-adapter",
        async run() {
          return {
            status: "completed",
            host,
            duration_ms: 1,
            final_response: { status: "completed", marker: "DONE" },
            _evidence: {
              tool_calls: [
                {
                  phase: "business",
                  tool: "write_record",
                  arguments: { service: "api", replicas: 3 },
                },
              ],
              upstream_events: [{ phase: "business", tool: "write_record" }],
              builtin_tool_calls: [],
              final_state: {
                arguments: { replicas: 3, service: "api" },
                tool: "write_record",
                completed: true,
                task_id: "ordered-state",
              },
            },
          };
        },
      },
    });

    expect(report.observations[0]).toMatchObject({
      final_state_match: true,
      task_completion: true,
    });
    expect(report.verdict).toBe("pass");
  });

  it("returns an inconclusive host report when provenance and Host identity are missing", async () => {
    const report = await evaluate({
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
      },
      suite: {
        schema_version: 1,
        id: "unidentified-host-task",
        kind: "host-task",
        profiles: ["direct", "compact", "extreme"],
        cases: [
          {
            id: "no-match",
            prompt: "Return no_match.",
            expected_no_match: true,
          },
        ],
      },
      adapter: {
        id: "unidentified-host-adapter",
        async run() {
          return {
            status: "completed",
            host: {},
            final_response: { status: "no_match" },
            _evidence: { tool_calls: [], upstream_events: [], ranked_tools: [] },
          };
        },
      },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.candidate).toMatchObject({ kind: "unidentified", digest: "0".repeat(64) });
    expect(report.suite.fixture_sha256).toBe("0".repeat(64));
    expect(report.hard_gates.provenance_complete.passed).toBe(false);
    expect(report.hard_gates.host_identity_complete.passed).toBe(false);
    expect(report.hard_gates.host_identity_match.passed).toBe(false);
  });

  it("retries only pre-MCP infrastructure failures and retains both attempts", async () => {
    const attempts = new Map<string, number>();
    const host = { name: "fake-host", version: "1", model: "fake-model", reasoning_effort: "low" };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "retryable-host-task",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "compact", "extreme"],
        cases: [{ id: "no-match", prompt: "Return no_match.", expected_no_match: true }],
      },
      adapter: {
        id: "retrying-fake-host",
        async run(input: { run_id: string }) {
          const count = (attempts.get(input.run_id) ?? 0) + 1;
          attempts.set(input.run_id, count);
          if (count === 1) {
            return {
              status: "infrastructure_error",
              infrastructure_error: { category: "rate_limit", before_first_mcp_event: true },
            };
          }
          return {
            status: "completed",
            host,
            final_response: { status: "no_match" },
            _evidence: { tool_calls: [], upstream_events: [], ranked_tools: [] },
          };
        },
      },
    });

    expect(report.verdict).toBe("pass");
    expect(report.observations).toHaveLength(3);
    expect(report.observations.every((observation) => observation.attempts.length === 2)).toBe(true);
    expect(report.summary.attempted_runs).toBe(6);
  });

  it("returns an inconclusive report when a marker-bearing Host task has no final response", async () => {
    let calls = 0;
    const host = { name: "fake-host", version: "1", model: "fake-model", reasoning_effort: "low" };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "missing-final-response-host-task",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "native"],
        repetitions: { direct: 1, native: 1 },
        cases: [
          {
            id: "marker-write",
            prompt: "Complete the marker-bearing task.",
            expected_tool: "write_record",
            expected_marker: "PRIVATE_EXPECTED_MARKER",
            expected_final_state: { saved: true },
            tool_schemas: {
              write_record: {
                inputSchema: { type: "object", additionalProperties: false, properties: {} },
              },
            },
          },
        ],
      },
      adapter: {
        id: "missing-final-response-host",
        async run() {
          calls += 1;
          return {
            status: "infrastructure_error",
            host,
            infrastructure_error: { category: "host_runtime", before_first_mcp_event: false },
          };
        },
      },
    });

    expect(calls).toBe(2);
    expect(report.verdict).toBe("inconclusive");
    expect(report.summary.aborted_reason).toBe("two_consecutive_infrastructure_errors");
  });

  it("stops after two consecutive infrastructure failures and reports an incomplete matrix", async () => {
    let calls = 0;
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host: { name: "fake-host", version: "1", model: "fake-model" },
      },
      suite: {
        schema_version: 1,
        id: "aborted-host-task",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "compact", "extreme"],
        cases: [
          { id: "one", prompt: "Return no_match.", expected_no_match: true },
          { id: "two", prompt: "Return no_match.", expected_no_match: true },
        ],
      },
      adapter: {
        id: "blocked-fake-host",
        async run() {
          calls += 1;
          return {
            status: "infrastructure_error",
            infrastructure_error: { category: "host_runtime", before_first_mcp_event: false },
          };
        },
      },
    });

    expect(calls).toBe(2);
    expect(report.verdict).toBe("inconclusive");
    expect(report.hard_gates.complete_matrix).toEqual({ passed: false, expected: 6, actual: 2 });
    expect(report.summary.aborted_reason).toBe("two_consecutive_infrastructure_errors");
  });

  it("preserves the Adapter cleanup infrastructure category", async () => {
    const host = { name: "fake-host", version: "1", model: "fake-model", reasoning_effort: "low" };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "adapter-cleanup-host-task",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "native"],
        cases: [{ id: "no-match", prompt: "Return no_match.", expected_no_match: true }],
      },
      adapter: {
        id: "cleanup-fake-host",
        async run() {
          return {
            status: "infrastructure_error",
            host,
            infrastructure_error: {
              category: "adapter_cleanup",
              before_first_mcp_event: false,
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.observations[0].infrastructure_category).toBe("adapter_cleanup");
  });

  it("fails forged final state when arguments, authorization, built-ins, or call limits regress", async () => {
    const host = { name: "fake-host", version: "1", model: "fake-model" };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "host-safety-regression",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "compact", "extreme"],
        limits: { timeout_ms: 180_000, max_mcp_calls: 20 },
        cases: [
          {
            id: "side-effect",
            prompt: "Set the incident severity.",
            side_effecting: true,
            expected_tool: "set_severity",
            expected_marker: "DONE",
            expected_final_state: { severity: "critical" },
            denied_tools: ["denied_set_severity"],
            tool_schemas: {
              set_severity: {
                inputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["severity"],
                  properties: { severity: { enum: ["critical"] } },
                },
              },
            },
          },
        ],
      },
      adapter: {
        id: "unsafe-fake-host",
        async run(input: { arm: string }) {
          const direct = input.arm === "direct";
          const extreme = input.arm === "extreme";
          return {
            status: "completed",
            host,
            final_response: { status: "completed", marker: "DONE" },
            _evidence: {
              tool_calls: [
                {
                  phase: "business",
                  tool: extreme ? "denied_set_severity" : "set_severity",
                  arguments: { severity: direct ? "critical" : "invalid" },
                },
              ],
              upstream_events: [{ phase: "business" }],
              discovered_tools: extreme ? ["denied_set_severity"] : ["set_severity"],
              ranked_tools: ["set_severity"],
              builtin_tool_calls: extreme ? [{ tool: "command_execution" }] : [],
              mcp_call_count: extreme ? 21 : 1,
              final_state: { severity: "critical" },
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.observations.find((entry) => entry.arm === "compact")?.task_completion).toBe(false);
    expect(report.hard_gates.side_effecting_first_arguments.passed).toBe(false);
    expect(report.hard_gates.unauthorized_tool_exposure.passed).toBe(false);
    expect(report.hard_gates.no_disallowed_builtin_tools.passed).toBe(false);
    expect(report.hard_gates.mcp_call_limit.passed).toBe(false);
  });

  it("derives official Tool Search composition evidence from ordered raw Host events", async () => {
    const host = { name: "fake-official-sdk", version: "1", model: "fake-model" };
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: { key: { const: "alpha" } },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "official-tool-search-composition",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "oracle", "native", "compact", "extreme"],
        required_evidence: { tool_search_arms: ["direct", "native"] },
        cases: [
          {
            id: "recover-result",
            prompt: "Find the authorized Tool and recover its result.",
            expected_tool: "read_record",
            expected_marker: "PRIVATE_RESULT_MARKER",
            expected_final_state: { read: true },
            denied_tools: ["denied_read_record"],
            tool_schemas: { read_record: { inputSchema } },
          },
        ],
      },
      adapter: {
        id: "fake-official-tool-search-adapter",
        async run(input: { arm: string }) {
          const source = { content: [{ type: "text", text: "PRIVATE_RESULT_MARKER" }] };
          const requiresSearch = ["direct", "native"].includes(input.arm);
          return {
            status: "completed",
            host,
            duration_ms: 1,
            score: { tool_search_evidence: true },
            final_response: { status: "completed", marker: "PRIVATE_RESULT_MARKER" },
            _evidence: {
              tool_search: requiresSearch
                ? {
                    request: { sequence: 1, query: "PRIVATE_SEARCH_QUERY" },
                    references: [
                      {
                        sequence: 2,
                        tool: "read_record",
                        input_schema: inputSchema,
                      },
                    ],
                  }
                : undefined,
              tool_calls: [
                {
                  sequence: requiresSearch ? 3 : 1,
                  phase: "business",
                  tool: "read_record",
                  arguments: { key: "alpha" },
                },
              ],
              upstream_events: [{ phase: "business", tool: "read_record" }],
              discovered_tools: ["read_record"],
              ranked_tools: ["read_record"],
              builtin_tool_calls: [],
              mcp_call_count: 1,
              mcp_events: [{ request: { method: "tools/call" }, response: { projected: true } }],
              final_state: { read: true },
              projection_used: ["native", "compact", "extreme"].includes(input.arm),
              source_result: source,
              recovered_result: source,
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("pass");
    expect(report.hard_gates).toMatchObject({
      tool_search_evidence_complete: { passed: true, expected: 2, actual: 2 },
      tool_search_event_order: { passed: true, expected: 2, actual: 2 },
      tool_search_schema_identity: { passed: true, expected: 2, actual: 2 },
    });
    expect(report.observations.find((entry) => entry.arm === "direct")).toMatchObject({
      tool_search_required: true,
      tool_search_evidence_complete: true,
      tool_search_event_order_valid: true,
      expanded_schema_match: true,
    });
    const shareable = JSON.stringify(report);
    expect(shareable).not.toContain("PRIVATE_SEARCH_QUERY");
    expect(shareable).not.toContain("read_record");
    expect(shareable).not.toContain('"key"');
    expect(shareable).not.toContain('tool_search_evidence":true');
  });

  it("accepts a paired Direct and Native diagnostic matrix without requiring unselected fallback arms", async () => {
    const host = { name: "fake-official-sdk", version: "1", model: "fake-model" };
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: { key: { const: "alpha" } },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "official-tool-search-direct-native-pilot",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "native"],
        required_evidence: { tool_search_arms: ["direct", "native"] },
        cases: [
          {
            id: "read-record",
            prompt: "Read the alpha record.",
            expected_tool: "read_record",
            expected_marker: "DONE",
            expected_final_state: { read: true },
            denied_tools: ["denied_read_record"],
            tool_schemas: { read_record: { inputSchema } },
          },
        ],
      },
      adapter: {
        id: "fake-direct-native-search-adapter",
        async run() {
          return {
            status: "completed",
            host,
            final_response: { status: "completed", marker: "DONE" },
            _evidence: {
              tool_search: {
                request: { sequence: 1, query: "read record" },
                references: [
                  {
                    sequence: 2,
                    tool: "read_record",
                    input_schema: inputSchema,
                  },
                ],
              },
              tool_calls: [
                {
                  sequence: 3,
                  phase: "business",
                  tool: "read_record",
                  arguments: { key: "alpha" },
                },
              ],
              upstream_events: [{ phase: "business", tool: "read_record" }],
              discovered_tools: ["read_record"],
              ranked_tools: ["read_record"],
              builtin_tool_calls: [],
              final_state: { read: true },
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("pass");
    expect(report.hard_gates.paired_task_non_inferiority).toEqual({
      passed: true,
      expected: ">= -0.05 lower 95% bound",
      actual: [],
    });
    expect(report.hard_gates.tool_search_evidence_complete.passed).toBe(true);
  });

  it("marks required Tool Search evidence inconclusive when raw events are missing", async () => {
    const host = { name: "fake-official-sdk", version: "1", model: "fake-model" };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "missing-official-tool-search-evidence",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "compact", "extreme"],
        required_evidence: { tool_search_arms: ["direct"] },
        cases: [
          {
            id: "no-match",
            prompt: "Return no_match.",
            expected_no_match: true,
            denied_tools: ["perfect_but_denied"],
          },
        ],
      },
      adapter: {
        id: "missing-search-events-adapter",
        async run() {
          return {
            status: "completed",
            host,
            final_response: { status: "no_match" },
            _evidence: {
              tool_calls: [],
              upstream_events: [],
              discovered_tools: [],
              ranked_tools: [],
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("inconclusive");
    expect(report.hard_gates.tool_search_evidence_complete).toEqual({ passed: false, expected: 1, actual: 0 });
    expect(report.hard_gates.unauthorized_tool_exposure.passed).toBe(true);
  });

  it("fails official Tool Search evidence that expands a changed schema or a denied Tool", async () => {
    const host = { name: "fake-official-sdk", version: "1", model: "fake-model" };
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["key"],
      properties: { key: { const: "alpha" } },
    };
    const report = await evaluate({
      candidate: { kind: "working-tree", digest, package_version: "0.2.0-alpha.1" },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        tokenizer: "o200k_base",
        host,
      },
      suite: {
        schema_version: 1,
        id: "invalid-official-tool-search-evidence",
        kind: "host-task",
        fixture_digest: digest,
        profiles: ["direct", "compact", "extreme"],
        required_evidence: { tool_search_arms: ["direct"] },
        cases: [
          {
            id: "schema-and-authorization",
            prompt: "Read the record.",
            expected_tool: "read_record",
            expected_marker: "DONE",
            expected_final_state: { read: true },
            denied_tools: ["denied_read_record"],
            tool_schemas: { read_record: { inputSchema } },
          },
        ],
      },
      adapter: {
        id: "invalid-search-evidence-adapter",
        async run(input: { arm: string }) {
          const direct = input.arm === "direct";
          return {
            status: "completed",
            host,
            final_response: { status: "completed", marker: "DONE" },
            _evidence: {
              tool_search: direct
                ? {
                    request: { sequence: 1, query: "read record" },
                    references: [
                      {
                        sequence: 2,
                        tool: "read_record",
                        input_schema: { ...inputSchema, required: [] },
                      },
                      {
                        sequence: 2,
                        tool: "denied_read_record",
                        input_schema: inputSchema,
                      },
                    ],
                  }
                : undefined,
              tool_calls: [
                {
                  sequence: direct ? 3 : 1,
                  phase: "business",
                  tool: "read_record",
                  arguments: { key: "alpha" },
                },
              ],
              upstream_events: [{ phase: "business", tool: "read_record" }],
              discovered_tools: ["read_record"],
              ranked_tools: ["read_record"],
              builtin_tool_calls: [],
              final_state: { read: true },
            },
          };
        },
      },
    });

    expect(report.verdict).toBe("fail");
    expect(report.hard_gates.tool_search_evidence_complete.passed).toBe(true);
    expect(report.hard_gates.tool_search_schema_identity).toEqual({ passed: false, expected: 1, actual: 0 });
    expect(report.hard_gates.unauthorized_tool_exposure).toEqual({ passed: false, expected: 0, actual: 1 });
  });
});
