# micro-mcp 路线图

> 轻量 MCP 代理 — 工具压缩瘦身 + 安全防护

---

## 定位

**唯一同时做「压缩」+「安全」的 MCP 代理。**

- 竞品（mcp-compressor / mcp-slim / slim-mcp）做纯压缩，无安全层
- 我们有 SSRF 防护 + 注入检测 + 白名单 + 限速 + 审计
- 差异化：**一行命令，既省 token 又保安全**

---

## 阶段总览

```
Phase 1 ─── Phase 2 ─── Phase 3 ─── Phase 4
  压缩对标      安全增强      智能层       社区化
   P0           P0-P1         P1-P2        P2
```

---

## Phase 1 — 压缩功能对标（当前 → 2 周）

目标：压缩能力对齐 slim-mcp 5 级水平

| 功能 | 优先级 | 现状 → 目标 |
|------|--------|------------|
| 压缩等级扩展 2→5 | P0 | ✅ 已完成（off/light/normal/extreme/maximum + tight 别名） |
| Lazy loading | P0 | ✅ 已完成（纯函数 pipeline + 预算预加载 + mcp__get_schema 按需发现） |
| 请求缓存 TTL+LRU | P0 | ✅ 已完成 |
| 基准测试 | P0 | ✅ 已完成（4 模块 + tiktoken + DeepSeek V4 Flash） |
| 远程 HTTP 传输 | P1 | ✅ 已完成（stdio + streamable HTTP） |

**可交付：** `micro-mcp proxy` 支持 5 级压缩 + lazy loading + 缓存，对标竞品核心能力。

---

## Phase 2 — 安全增强（Phase 1 后 → +1 周）

目标：安全层从"可用"到"可卖"

| 功能 | 优先级 | 现状 → 目标 |
|------|--------|------------|
| 策略管道 HMR | P0 | ✅ 已完成（SIGHUP 热重载 + 文档） |
| 审计日志轮转 + JSON 输出 | P0 | ✅ 已完成（3 rotation + 14 JSON 测试） |
| Istio-style 策略模板 | P1 | 预设安全策略（严格/中等/宽松），一键启用 |
| 安全报告 CLI | P1 | `micro-mcp audit` 输出安全审查报告 |
| 风险评分 | P2 | 给每个上游 server 打安全分（SSRF/注入/权限） |

---

## Phase 3 — 智能层（Phase 2 后 → +2 周）

目标：拉开与竞品的距离

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 语义搜索 | P1 | 本地 embedding（@huggingface/transformers），按意图找工具 |
| 用法追踪 | P1 | 每次请求省了多少 token，存 SQLite，`micro-mcp status` 查看 |
| 自动配置检测 | P1 | 自动发现 Claude/Cursor/Windsurf/Cline 配置，`micro-mcp init` |
| 响应优化 | P2 | 自动截断数组、去 null、剥 metadata，对标 mcp-slim |
| 实时仪表盘 | P2 | HTTP 端口，显示压缩率/缓存命中/调用统计 |

---

## Phase 4 — 社区化（Phase 3 后 → 持续）

目标：增长 + 生态

| 功能 | 优先级 | 说明 |
|------|--------|------|
| 目录站提交 | P0 | Glama / mcp.directory / awesome-mcp-servers |
| README 中英双语 | P1 | 对标 agent-search-mcp 的双语策略 |
| 中文推广文 | P1 | 掘金/V2EX 发帖，强调"免费 + 省 token + 安全" |
| GitHub Actions 示例 | P2 | CI 中集成 micro-mcp 做安全扫描 |
| Hermes 深度集成 | P2 | 作为 Hermes 默认安全代理 |

---

## 关键里程碑

| 时间 | 里程碑 | 指标 |
|------|--------|------|
| 2 周 | Phase 1 完成 | 5 级压缩 + lazy loading + 缓存 |
| 3 周 | Phase 2 完成 | 安全文档 + CLI audit |
| 5 周 | Phase 3 完成 | 语义搜索 + 自动配置 |
| 8 周 | Phase 4 启动 | 目录站收录 + 中文推广 |

---

## 不做的事

- ❌ Python / Rust SDK（对标 mcp-compressor）— TS 生态优先
- ❌ OAuth 支持（对标 mcp-compressor）— 复杂度高，ROI 低
- ❌ 云端管理面板 — 保持 CLI-first，不建 SaaS
- ❌ 大模型下载（对标 mcp-slim 的 80MB）— 用小模型 + 按需加载

---

## 竞品速查

| 竞品 | 压缩 | 安全 | 语义搜索 | SDK 语言 | 许可证 |
|------|------|------|---------|---------|--------|
| mcp-compressor (Atlassian) | ✅ 4级 | ❌ | ❌ | Python/TS/Rust | MIT |
| mcp-slim (dopatools) | ✅ 是 | ❌ | ✅ 本地 embedding | TS | MIT |
| slim-mcp (Joncik91) | ✅ 5级 | ❌ | ❌ | TS | MIT |
| **micro-mcp（我们）** | ✅ 2→5级 | ✅ 全 | Phase 3 | TS | MIT |
