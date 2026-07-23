import { generateTools } from "../../dist/compressor.js";
import { encoding_for_model } from "tiktoken";

const fullTools = [
  { name: "echo_echo", description: "[echo] Echo back input", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "echo_ping", description: "[echo] Health check", inputSchema: { type: "object", properties: {} } },
  { name: "agent-search_free_search", description: "[agent-search] Search the web with multi-engine automatic fallback.", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, engines: { type: "array", items: { type: "string" } } }, required: ["query"] } },
  { name: "agent-search_free_search_advanced", description: "[agent-search] Advanced search with filters and quality control.", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, language: { type: "string" }, time_range: { type: "string" }, exclude_domains: { type: "array", items: { type: "string" } }, include_domains: { type: "array", items: { type: "string" } } }, required: ["query"] } },
  { name: "agent-search_free_extract", description: "[agent-search] Extract full content from a URL.", inputSchema: { type: "object", properties: { url: { type: "string" }, max_length: { type: "number" } }, required: ["url"] } },
  { name: "agent-search_fetch_github_readme", description: "[agent-search] Fetch README from a GitHub repo.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "agent-search_fetch_csdn_article", description: "[agent-search] Fetch CSDN article.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "agent-search_fetch_juejin_article", description: "[agent-search] Fetch Juejin article.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "agent-search_search_with_synthesis", description: "[agent-search] Deep search with synthesis.", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, language: { type: "string" } }, required: ["query"] } },
  { name: "agent-search_free_search_news", description: "[agent-search] Search news.", inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" }, time_range: { type: "string" } }, required: ["query"] } },
  { name: "codegraph_codegraph_explore", description: "[codegraph] Query code knowledge graph.", inputSchema: { type: "object", properties: { query: { type: "string" }, projectPath: { type: "string" }, maxFiles: { type: "number" } }, required: ["query"] } },
  { name: "seocli_seocli_audit", description: "[seocli] Crawl and audit website SEO.", inputSchema: { type: "object", properties: { url: { type: "string" }, max_urls: { type: "number" }, max_depth: { type: "number" } }, required: ["url"] } },
  { name: "seocli_seocli_issues_summary", description: "[seocli] Quick SEO issue summary.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "seocli_seocli_audit_start", description: "[seocli] Start async SEO audit.", inputSchema: { type: "object", properties: { url: { type: "string" }, max_urls: { type: "number" } }, required: ["url"] } },
  { name: "seocli_seocli_audit_poll", description: "[seocli] Poll audit results.", inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } },
  { name: "seocli_seocli_audit_results", description: "[seocli] Get final audit results.", inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] } },
];

const LEVELS = ["off", "light", "normal", "extreme", "maximum"];

function countTokens(tools, encoding) {
  const serialized = JSON.stringify(
    tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.inputSchema ?? { type: "object", properties: {} },
      },
    })),
  );
  return encoding.encode(serialized).length;
}

const encoding = encoding_for_model("gpt-4o");
const baseline = countTokens(fullTools, encoding);

console.log("📊 Token 节省测算（你的 16 个工具）\n");
console.log(`   工具总数: ${fullTools.length}`);
console.log(`   基线 tokens: ${baseline}\n`);
console.log(`   ${"Level".padEnd(10)} ${"Tokens".padEnd(8)} ${"节省".padEnd(8)} ${"说明"}`);
console.log(`   ${"─".repeat(55)}`);

for (const level of LEVELS) {
  const compressed = generateTools(fullTools, {
    enabled: level !== "off",
    level: level === "off" ? "light" : level,
    lazy_loading: false,
    lazy_budget: 8,
  });
  const tokens = countTokens(compressed, encoding);
  const reduction = level === "off" ? 0 : Math.round(((baseline - tokens) / baseline) * 100);

  const notes = {
    off: "完整 schema（基线）",
    light: "精简名称 + 关键参数",
    normal: "极简 schema",
    extreme: "名称缩写 + 类型简写",
    maximum: "名称单字母 + 类型缩写",
  };

  const bar = "█".repeat(Math.round(reduction / 5)) + "░".repeat(Math.max(0, 20 - Math.round(reduction / 5)));
  console.log(`   ${level.padEnd(10)} ${String(tokens).padEnd(8)} ${reduction > 0 ? `-${reduction}%`.padEnd(8) : "基线".padEnd(8)} ${notes[level]}  ${bar}`);
}

// Lazy mode
const lazyLevel = "light";
const lazyTools = generateTools(fullTools, {
  enabled: true,
  level: lazyLevel,
  lazy_loading: true,
  lazy_budget: 8,
});
const lazyTokens = countTokens(lazyTools, encoding);
const lazyReduction = Math.round(((baseline - lazyTokens) / baseline) * 100);
console.log(`   ${"lazy".padEnd(10)} ${String(lazyTokens).padEnd(8)} -${lazyReduction}%`.padEnd(8) + `  按需加载（预暴露 8 个高频工具 schema）`);

encoding.free();