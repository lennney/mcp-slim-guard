/**
 * Benchmark: Latency measurement (offline, CI-friendly).
 *
 * Measures compression execution time and cache hit/miss latency.
 */
import { fetchAllTools, prepareWorkspace } from "./fixtures.mjs";
import { writeReport } from "./report.mjs";

const LEVELS = ["off", "light", "normal", "extreme", "maximum"];
const ITERATIONS = 10;

async function getCompressedTools(fullTools, level) {
  const { generateTools } = await import("../../dist/compressor.js");
  return generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
}

async function measureCompressLatency(fullTools, level) {
  const times = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    await getCompressedTools(fullTools, level);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6); // ns → ms
  }
  return times.reduce((a, b) => a + b, 0) / times.length;
}

async function measureCacheLatency(fullTools) {
  const { ToolCache } = await import("../../dist/cache.js");
  const config = {
    enabled: true,
    ttl: 30,
    max_entries: 500,
    allow: [],
    deny: [],
  };
  const cache = new ToolCache(config);

  // Prepare a cached entry
  const mockResult = { content: [{ type: "text", text: "cached" }] };
  cache.set("test_read", { q: "x" }, mockResult);

  // Cache hit latency
  const hitTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    cache.get("test_read", { q: "x" });
    const t1 = process.hrtime.bigint();
    hitTimes.push(Number(t1 - t0) / 1e6);
  }
  const hitMs = hitTimes.reduce((a, b) => a + b, 0) / hitTimes.length;

  // Cache miss latency
  const missTimes = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    cache.get("test_read", { q: "not-cached" });
    const t1 = process.hrtime.bigint();
    missTimes.push(Number(t1 - t0) / 1e6);
  }
  const missMs = missTimes.reduce((a, b) => a + b, 0) / missTimes.length;

  return { hit_ms: hitMs, miss_ms: missMs };
}

async function main() {
  console.log("📊 Benchmark: Latency\n");

  await prepareWorkspace();

  console.log("Fetching tool schemas...");
  const fullTools = await fetchAllTools();

  if (fullTools.length === 0) {
    console.error("❌ No tools found.");
    process.exit(1);
  }

  console.log(`  ${ITERATIONS} iterations per measurement\n`);

  const levelResults = {};

  for (const level of LEVELS) {
    const compressMs = await measureCompressLatency(fullTools, level);
    levelResults[level] = {
      compress_ms: compressMs,
      cache_hit_ms: 0,
      cache_miss_ms: 0,
    };
    console.log(`  ${level.padEnd(10)} compress: ${compressMs.toFixed(2)}ms`);
  }

  // Cache latency (same for all levels — it's the cache module itself)
  const cacheLatency = await measureCacheLatency(fullTools);
  for (const level of LEVELS) {
    levelResults[level].cache_hit_ms = cacheLatency.hit_ms;
    levelResults[level].cache_miss_ms = cacheLatency.miss_ms;
  }
  console.log(`  Cache: hit ${cacheLatency.hit_ms.toFixed(2)}ms, miss ${cacheLatency.miss_ms.toFixed(2)}ms`);

  const result = {
    module: "latency",
    timestamp: new Date().toISOString(),
    iterations: ITERATIONS,
    levels: levelResults,
  };

  writeReport({ latency: result });
  console.log("\n✅ Latency benchmark complete");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
