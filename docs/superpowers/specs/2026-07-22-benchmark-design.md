# 基准测试设计 — 对标 slim-mcp

## 目标

构建 4 个独立基准测试模块，量化 mcp-guard 压缩器的 token 节省、schema 保留率、LLM 准确率和延迟。对标 slim-mcp 的 120 API 准确率测试，并增加参数值验证和模糊场景作为差异化。

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| LLM 模型 | DeepSeek V4 Flash | 成本极低，环境可用（HiModels API） |
| 基准范围 | 全面（token + accuracy + schema + latency） | 差异化于 slim-mcp（只测 accuracy） |
| 工具源 | filesystem + GitHub 真实 MCP server | 复杂 schema，GitHub 30+ 工具 |
| Tokenizer | tiktoken（devDependency） | 精确，虽与 DeepSeek tokenizer 有微小偏差 |
| 准确率验证 | slim-mcp 基础 + 参数值 + 模糊场景 | 差异化亮点 |
| 结构 | 4 独立模块 + 组合 runner | CI 无 key 也能跑 token + schema |

## 架构

```
scripts/
├── benchmark/
│   ├── tokens.mjs      # 离线：token 节省量测量（tiktoken）
│   ├── schema.mjs       # 离线：schema 保留率测量
│   ├── accuracy.mjs     # 需 API key：LLM 准确率测试
│   ├── latency.mjs     # 离线：压缩 + 缓存延迟测量
│   ├── fixtures.mjs     # 共享：工具拉取 + 测试场景定义
│   └── report.mjs       # 共享：JSON + Markdown 报告生成
└── bench.mjs            # 入口：npm run bench → 按可用性跑各模块
```

### 模块 1: bench:tokens（离线，CI 友好）

**输入：** filesystem + GitHub 真实工具 schema
**流程：**
1. 启动两个真实 MCP server，`listTools()` 拉取完整 schema
2. 对每个压缩等级（off/light/normal/extreme/maximum）：
   - 调用 `generateTools(fullTools, { enabled: true, level }, allow, deny)` 生成压缩工具
   - 用 tiktoken 计算 `JSON.stringify(compressedTools)` 的 token 数
   - 计算 vs off 的节省百分比
3. 同时量 lazy loading 模式（lazy_loading=true）的 token 数

**输出：**
```json
{
  "module": "tokens",
  "tool_count": 35,
  "levels": {
    "off": { "tokens": 7528, "reduction_pct": 0 },
    "light": { "tokens": 6100, "reduction_pct": 19 },
    "normal": { "tokens": 4930, "reduction_pct": 35 },
    "extreme": { "tokens": 2133, "reduction_pct": 72 },
    "maximum": { "tokens": 1750, "reduction_pct": 77 }
  },
  "lazy": { "tokens": 2722, "reduction_pct": 65 }
}
```

### 模块 2: bench:schema（离线，CI 友好）

**输入：** 同上
**流程：**
1. 对每个压缩等级，统计压缩后保留的 schema 字段：
   - 工具数（wrapper 模式可能减少可见工具数）
   - 每个工具的 `description` 是否保留
   - 每个工具的 `inputSchema.properties` 字段数
   - `inputSchema.required` 列表是否保留
2. 计算 schema 保留率 = 保留字段数 / 原始字段数

**输出：**
```json
{
  "module": "schema",
  "baseline": { "tools": 35, "total_fields": 210, "total_required": 45 },
  "levels": {
    "light": { "visible_tools": 3, "fields_preserved": 0, "retention_pct": 0, "note": "wrapper mode" },
    "normal": { "visible_tools": 3, "fields_preserved": 0, "retention_pct": 0, "note": "wrapper mode" },
    "extreme": { "visible_tools": 35, "fields_preserved": 35, "retention_pct": 17, "note": "signature in description" },
    "maximum": { "visible_tools": 35, "fields_preserved": 35, "retention_pct": 17, "note": "compact signature" }
  }
}
```

### 模块 3: bench:accuracy（需 DEEPSEEK_API_KEY）

**输入：** 真实工具 schema + 12 个测试场景（含模糊场景）
**流程：**
1. 启动真实 MCP server 拉取工具 schema
2. 对每个压缩等级 × 每个场景 × 3 次运行：
   - 将压缩工具转为 OpenAI tool format（`{ type: "function", function: { name, description, parameters } }`）
   - 发送 prompt 到 DeepSeek V4 Flash（OpenAI-compatible API，无 system prompt，单轮）
   - 检查返回的 `tool_calls`：
     - 工具名正确（含命名空间容忍：`fs__read` 匹配 `read`）
     - 必填参数都在
     - 参数类型正确（`typeof`）
     - 参数值正确（新增：如 path 值包含预期路径片段）
3. 统计 per-level 准确率 + per-scenario breakdown

**测试场景（12 个）：**

| # | 工具 | Prompt | 验证 |
|---|------|-------|------|
| 1 | `read_file` | Read the file at /tmp/test.txt | name + path in args |
| 2 | `list_directory` | List contents of /tmp | name + path in args |
| 3 | `search_files` | Search for "config" in /tmp | name + query + path |
| 4 | `get_file_info` | Get metadata for /tmp/test.txt | name + path |
| 5 | `directory_tree` | Show tree of /tmp/src | name + path |
| 6 | `write_file` | Write "hello" to /tmp/out.txt | name + path + content |
| 7 | `create_directory` | Create directory /tmp/newdir | name + path |
| 8 | `move_file` | Move /tmp/a.txt to /tmp/b.txt | name + source + destination |
| 9 | **模糊: read vs search** | Find files containing "log" in /tmp | expect search_files, NOT read_file |
| 10 | **模糊: list vs tree** | Show all files recursively in /tmp | expect directory_tree, NOT list_directory |
| 11 | **模糊: write vs create** | Make a new file /tmp/x.txt with content "hi" | expect write_file, NOT create_directory |
| 12 | **模糊: GitHub search** | Search GitHub for "mcp" repos | expect search_repositories |

场景 1-8 是基础单工具测试（对标 slim-mcp），9-12 是模糊场景（差异化）。

**输出：**
```json
{
  "module": "accuracy",
  "model": "deepseek-v4-flash",
  "total_calls": 180,
  "levels": {
    "off": { "passed": 36, "total": 36, "accuracy_pct": 100 },
    "light": { "passed": 36, "total": 36, "accuracy_pct": 100 },
    "normal": { "passed": 35, "total": 36, "accuracy_pct": 97.2 },
    "extreme": { "passed": 33, "total": 36, "accuracy_pct": 91.7 },
    "maximum": { "passed": 30, "total": 36, "accuracy_pct": 83.3 }
  },
  "failures": [
    { "level": "maximum", "scenario": 10, "run": 2, "expected": "directory_tree", "got": "list_directory", "reason": "wrong tool" }
  ]
}
```

### 模块 4: bench:latency（离线）

**输入：** 同上
**流程：**
1. 对每个压缩等级：
   - 量 `generateTools()` 执行时间（10 次取平均）
   - 量缓存命中/未命中延迟（如缓存启用）
2. 对比 guard proxy overhead（已有 `scripts/benchmark.mjs` 的 Direct vs Guarded 测试）

**输出：**
```json
{
  "module": "latency",
  "levels": {
    "off": { "compress_ms": 0.1, "cache_hit_ms": 0.05, "cache_miss_ms": 0.05 },
    "light": { "compress_ms": 1.2, "cache_hit_ms": 0.05, "cache_miss_ms": 1.3 },
    ...
  }
}
```

### 组合 runner: bench:all

`npm run bench` 检测环境：
- 无 `DEEPSEEK_API_KEY` → 跑 tokens + schema + latency（3 个离线模块）
- 有 key → 跑全部 4 个模块
- 生成合并 JSON + Markdown 报表

## API 调用细节

**DeepSeek V4 Flash（OpenAI-compatible）：**
- Endpoint: `https://api.himodels.ai/v1/chat/completions`
- Model: `deepseek-v4-flash`
- 请求：`{ model, messages: [{ role: "user", content: prompt }], tools: [...], max_tokens: 512 }`
- 响应：检查 `choices[0].message.tool_calls[0]`
- 成本：~$0.001/次（远低于 Claude Sonnet 4 的 $0.20）

**tiktoken 配置：**
- 使用 `gpt-4o` encoding（与 DeepSeek tokenizer 接近）
- 计算 `JSON.stringify(tools.map(t => ({ name, description, inputSchema })))` 的 token 数
- devDependency，不增加生产依赖

## MCP Server 启动

**filesystem server：**
- `npx -y @modelcontextprotocol/server-filesystem /tmp/bench-workspace`
- 提供 8 个工具：read_file, write_file, list_directory, search_files, get_file_info, directory_tree, create_directory, move_file

**GitHub server：**
- `npx -y @modelcontextprotocol/server-github`（需 `GITHUB_TOKEN` 环境变量）
- 提供 30+ 个工具：search_repositories, get_file_contents, create_issue, ...
- 如果无 token，跳过 GitHub 测试，只测 filesystem

## 依赖变更

| 依赖 | 类型 | 用途 |
|------|------|------|
| tiktoken | devDependency | Token 计数 |

无新增生产依赖。

## 输出格式

**JSON：** `scripts/benchmark/results/bench-YYYY-MM-DD.json`
**Markdown：** `scripts/benchmark/results/bench-YYYY-MM-DD.md`

Markdown 报表格式：
```markdown
# Benchmark Report — 2026-07-22

## Token Savings
| Level | Tokens | Reduction |
|-------|--------|-----------|
| off   | 7528   | baseline  |
| ...

## Schema Retention
| Level | Visible Tools | Fields Preserved | Retention % |
|-------|--------------|-----------------|-------------|
| ...

## Accuracy (DeepSeek V4 Flash, 180 calls)
| Level | Passed | Total | Accuracy % |
|-------|--------|-------|------------|
| ...

## Latency
| Level | Compress (ms) | Cache Hit (ms) | Cache Miss (ms) |
|-------|--------------|----------------|-----------------|
| ...
```

## 测试策略

- `tokens` 和 `schema` 模块：用硬编码的 fixture schema 做单元测试（不启动真实 server）
- `accuracy` 模块：无 key 时跳过测试；有 key 时用 mock API 响应做集成测试
- `latency` 模块：用 mock `generateTools` 调用做单元测试
- `report` 模块：测试 JSON/Markdown 输出格式

## 与 slim-mcp 的差异

| 维度 | slim-mcp | mcp-guard |
|------|----------|-----------|
| 模型 | Claude Sonnet 4 (~$0.20/run) | DeepSeek V4 Flash (~$0.001/run) |
| 场景数 | 8 | 12（含 4 个模糊场景） |
| 参数验证 | 类型 only | 类型 + 值 |
| Token 测量 | 无自动化 | tiktoken 自动化 |
| Schema 保留 | 不测 | 测 |
| 延迟 | 不测 | 测 |
| CI 友好 | 无 key 跳过全部 | 无 key 跑 3/4 模块 |
| 输出 | stdout 文本 | JSON + Markdown |
