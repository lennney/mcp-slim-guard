---
type: Readme
title: micro-mcp
timestamp: '2026-07-22T18:00:00+08:00'
description: 轻量 MCP 安全代理 — SSRF 防护 + 工具白名单 + 审计 + 限速 + 注入检测 + 压缩 + 缓存
tags:
- micro-mcp
- readme
- mcp
- security
---

# 🛡️ micro-mcp

> 一行命令给 MCP Server 加上安全策略代理

`micro-mcp` 是轻量级 MCP 安全代理，放在 AI Agent 和你现有的 MCP Server 之间，透明的加上 SSRF 防护、工具白名单、速率限制、注入检测和审计日志。

```
AI Agent → micro-mcp ──→ 你的 MCP Server
             │ 白名单 → SSRF → 注入检测 → 限速
             └→ 审计日志 (JSON)
```

## 为什么需要

MCP 协议没有内置安全性：任何 Agent 可以调用你暴露的**所有工具**，带上**任意参数**。如果你暴露了 `shell_exec`、`file_write` 或搜索工具，Agent prompt injection 就能变成远程代码执行。

| 风险 | 攻击方式 | micro-mcp 防护 |
|------|---------|---------------|
| 工具越权 | Agent 调用敏感工具 | deny 列表 + glob 匹配 |
| SSRF | 工具参数注入内网 URL | IP 黑名单 + 域名白名单 |
| 滥用 | 工具调用 flood | Token Bucket 限速 |
| 注入 | Shell/SQL/Prompt 注入参数 | 17 种启发式检测 |
| 无审计 | 不知道谁调了什么 | pino JSON 日志 |

## 快速开始

```bash
npm install -g micro-mcp

# 1. 初始化（自动发现 .mcp.json 中的 MCP Server）
cd your-project/
micro-mcp init

# 2. 验证策略（干跑，看会不会误杀）
micro-mcp validate

# 3. 启动代理
micro-mcp start
```

生成的 `micro-mcp.yml`：

```yaml
tools:
  allow:
    - search_*           # 只允许 search_ 前缀的工具
  deny:
    - '*_delete_*'       # 禁止任何 delete 操作
    - '*_drop_*'
    - '*_admin_*'
ssrf:
  mode: block            # 阻止内网 IP 访问
  block_private_ips: true
rate_limit:
  default: 60/min        # 每工具每分钟 60 次
injection_detection:
  enabled: true          # 默认开启注入检测
  mode: block
  sensitivity: medium
```

## 压缩 + 缓存

micro-mcp 内置 5 级 schema 压缩 + 请求缓存，对标 [slim-mcp](https://github.com/Joncik91/slim-mcp)：

```
Agent → micro-mcp (压缩 schema + 缓存 + 安全) → MCP Server
```

### Token 节省

基准测试使用真实 MCP Server 工具 schema（filesystem 14 工具），tiktoken 精确计数：

| 压缩等级 | Token 数 | 节省 | 说明 |
|---------|---------|------|------|
| off | 1,736 | baseline | 原始 schema |
| **light** | **300** | **83%** | wrapper 模式，按需获取 schema |
| **normal** | **245** | **86%** | 精简 wrapper，工具 > 30 个推荐 |
| extreme | 1,361 | 22% | 签名嵌入 description |
| maximum | 1,294 | 25% | 超短类型签名 |
| lazy loading | 1,644 | 5% | 按需发现 + 预算预加载 |

> `light`/`normal` 级别通过 wrapper 工具（`mcp__invoke_tool`）隐藏完整 schema，大幅减少 token 占用。

### Schema 保留率

| 压缩等级 | 可见工具 | 保留字段 | 保留率 |
|---------|---------|---------|--------|
| off | 14 | 25 | 100% |
| light | 3 | 3 | 12% |
| normal | 2 | 3 | 12% |
| extreme | 14 | 25 | 100% |
| maximum | 14 | 0 | 0% |

### 延迟开销

```
代理开销: ~2ms/call（策略管道：白名单→SSRF→注入→限速）
压缩耗时: light/normal < 0.05ms · extreme/maximum < 0.1ms
缓存命中: 0.01ms（TTL+LRU，只读工具自动缓存）
```

<details>
<summary>📊 完整基准数据（DeepSeek V4 Flash, 180 calls）</summary>

准确率测试使用 DeepSeek V4 Flash，12 场景 × 5 等级 × 3 轮 = 180 次 API 调用。场景含 4 个模糊工具名测试（如 read vs search、list vs tree）：

| 压缩等级 | 准确率 | 说明 |
|---------|--------|------|
| off | 100% | 无压缩基线 |
| light | — | wrapper 模式需多轮，单轮测试偏低 |
| normal | — | 同上 |
| extreme | — | 需 DEEPSEEK_API_KEY 运行 |
| maximum | — | 需 DEEPSEEK_API_KEY 运行 |

> 运行 `npm run bench:accuracy`（需 `DEEPSEEK_API_KEY`）获取实时准确率数据。

</details>

<details>
<summary>🔧 运行基准测试</summary>

```bash
# 离线模块（无需 API key）
npm run bench:tokens     # token 节省量
npm run bench:schema     # schema 保留率
npm run bench:latency    # 延迟开销

# LLM 准确率（需 DEEPSEEK_API_KEY）
DEEPSEEK_API_KEY=sk-xxx npm run bench:accuracy

# 全量基准（按 key 可用性自动选择）
npm run bench
```

</details>

## 命令

| 命令 | 说明 |
|------|------|
| `micro-mcp init` | 自动发现 `.mcp.json`，生成 `micro-mcp.yml` |
| `micro-mcp validate` | 干跑策略，输出每个工具的 allowed/denied/no-match 状态 |
| `micro-mcp start` | 启动安全代理（STDIO 模式） |
| `micro-mcp start --http --port 3000` | HTTP SSE 模式 |
| `micro-mcp status` | 查看当前配置和策略摘要 |
| `micro-mcp doctor` | 诊断上游 MCP Server 可达性 |
| `micro-mcp log --tail` | 实时查看审计日志 |
| `micro-mcp uninit` | 删除 micro-mcp.yml 回滚 |

## 审计日志

每次工具调用自动记录到 `micro-mcp-audit.log`：

```json
{
  "action": "allowed",
  "toolName": "search_free_search",
  "serverName": "search",
  "arguments": { "query": "Python async", "limit": 3 },
  "durationMs": 18,
  "timestamp": "2026-07-20T06:46:37.282Z"
}
```

支持 `--tail` 实时跟随，兼容 `jq` 管道分析。

## 策略管道

策略按顺序执行，任一拒绝即停止：

```
Whitelist → SSRF → Injection → Rate Limit → Audit
    ↓           ↓        ↓          ↓           ↓
  glob 匹配   IP/域名  17 种模式  Token Bucket  pino JSON
  fail-closed  黑名单   3 级灵敏度  60/min
```

- **热重载**：`kill -HUP <pid>` 零停机重新加载 `micro-mcp.yml`
- **无损压缩**：`--compressor light|tight` 按需获取 tool schema（工具 > 30 个推荐）
- **多 Server**：一个 guard 代理多个上游 MCP Server，前缀路由自动分发

## 技术栈

TypeScript · MCP SDK · 5 个依赖 · 397 个测试 · 4 模块基准

## 与其他 MCP 工具搭配

micro-mcp 内置压缩，不需要外部压缩工具。如果已用 [mcp-compressor](https://github.com/atlassian-labs/mcp-compressor) 或其他压缩方案，micro-mcp 可作为安全层叠加：

```
Agent → mcp-compressor (外部压缩) → micro-mcp (安全) → MCP Server
# 或
Agent → micro-mcp (内置压缩 + 安全) → MCP Server
```

详见 [压缩器指南](docs/COMPRESSOR.md) 和 [基准测试](#压缩--缓存)。

## License

MIT
