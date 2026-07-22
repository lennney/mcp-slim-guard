/**
 * Benchmark report generator — JSON + Markdown output.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const RESULTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");

/**
 * Write benchmark results to JSON + Markdown files.
 * Returns the file paths.
 */
export function writeReport(results) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const baseName = `bench-${date}`;

  // JSON output
  const jsonPath = path.join(RESULTS_DIR, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Markdown output
  const mdPath = path.join(RESULTS_DIR, `${baseName}.md`);
  fs.writeFileSync(mdPath, generateMarkdown(results));

  console.log(`\n📄 Report: ${jsonPath}`);
  console.log(`📄 Report: ${mdPath}`);

  return { jsonPath, mdPath };
}

function generateMarkdown(results) {
  let md = `# Benchmark Report — ${new Date().toISOString().slice(0, 10)}\n\n`;

  if (results.tokens) {
    md += `## Token Savings\n\n`;
    md += `| Level | Tokens | Reduction |\n|-------|--------|-----------|\n`;
    for (const [level, data] of Object.entries(results.tokens.levels)) {
      const pct = data.reduction_pct > 0 ? `${data.reduction_pct}%` : "baseline";
      md += `| ${level} | ${data.tokens} | ${pct} |\n`;
    }
    if (results.tokens.lazy) {
      md += `\n**Lazy loading:** ${results.tokens.lazy.tokens} tokens (${results.tokens.lazy.reduction_pct}% reduction)\n`;
    }
    md += `\n`;
  }

  if (results.schema) {
    md += `## Schema Retention\n\n`;
    md += `| Level | Visible Tools | Fields Preserved | Retention % |\n|-------|--------------|-----------------|-------------|\n`;
    for (const [level, data] of Object.entries(results.schema.levels)) {
      md += `| ${level} | ${data.visible_tools} | ${data.fields_preserved} | ${data.retention_pct}% |\n`;
    }
    md += `\n`;
  }

  if (results.accuracy) {
    md += `## Accuracy (${results.accuracy.model}, ${results.accuracy.total_calls} calls)\n\n`;
    md += `| Level | Passed | Total | Accuracy % |\n|-------|--------|-------|------------|\n`;
    for (const [level, data] of Object.entries(results.accuracy.levels)) {
      md += `| ${level} | ${data.passed} | ${data.total} | ${data.accuracy_pct}% |\n`;
    }
    if (results.accuracy.failures.length > 0) {
      md += `\n### Failures\n\n`;
      for (const f of results.accuracy.failures) {
        md += `- Level \`${f.level}\`, Scenario ${f.scenario}, Run ${f.run}: expected \`${f.expected}\`, got \`${f.got}\` (${f.reason})\n`;
      }
    }
    md += `\n`;
  }

  if (results.latency) {
    md += `## Latency\n\n`;
    md += `| Level | Compress (ms) | Cache Hit (ms) | Cache Miss (ms) |\n|-------|--------------|----------------|-----------------|\n`;
    for (const [level, data] of Object.entries(results.latency.levels)) {
      md += `| ${level} | ${data.compress_ms.toFixed(2)} | ${data.cache_hit_ms.toFixed(2)} | ${data.cache_miss_ms.toFixed(2)} |\n`;
    }
    md += `\n`;
  }

  return md;
}
