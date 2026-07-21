---
type: AgentInstruction
title: mcp-guard — 轻量 MCP 安全代理
timestamp: '2026-07-20T23:30:00+08:00'
description: 一行命令给 MCP 加上 SSRF 防护 + 白名单 + 审计 + 限速 + 注入检测
tags:
- mcp-guard
- agentinstruction
- security
- proxy
---

# mcp-guard — 轻量 MCP 安全代理

一句话：一行命令给 MCP 加上 SSRF 防护 + 白名单 + 审计 + 限速 + 注入检测

## 常用命令

```bash
cd ~/micro-mcp
npm run build               # 编译到 dist/
npm test                    # 全量测试（305 tests, 18 files）
npx vitest run              # 同上
npx tsc --noEmit            # 类型检查
```

## 技术栈

| 组件 | 版本 |
|------|------|
| Runtime | Node ≥18, TypeScript 5.7 |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.9.0（标准协议） |
| CLI | Commander ^13.1 |
| Logging | Pino ^9.6 |
| Config | js-yaml ^4.1 |
| Pattern matching | micromatch ^4.0 |

## 核心架构

```
AI Agent → mcp-guard (STDIO 或 HTTP 代理)
             ├─ PolicyPipeline（串行：白名单→SSRF→注入检测→限速）
             ├─ AuditLogger（pino JSON，支持按大小轮转）
             └─ ServerManager → 上游 MCP Server × N
```

- 工具名前缀路由：`github_search_repositories` → server: github, tool: search_repositories
- 串行管道短路求值：任一拒绝即停止
- 纯内存限速（Token Bucket），无持久化
- 热重载 SIGHUP 重建 pipeline + serverManager + audit logger
- 无损压缩：`mcp-guard start --compressor light|tight`

## 协议标准

mcp-guard 完全遵循 [MCP 标准协议](https://spec.modelcontextprotocol.io)：

| 标准 | 实现 |
|------|------|
| Transport | STDIO（默认）+ Streamable HTTP（`--http`） |
| 消息格式 | JSON-RPC 2.0 |
| SDK | `@modelcontextprotocol/sdk` v1.9.0（官方） |
| 生命周期 | Initialize → tools/list → tools/call |

## 依赖关系

```
mcp-guard ──(MCP SDK)──→ 上游 MCP Server（GitHub / Playwright / ...）
```

## 项目状态

| 阶段 | 状态 | 详情 |
|------|------|------|
| Phase 1 核心策略管道 | ✅ 完成 | 13/13 任务，155 tests |
| Phase 2 高级功能 | ✅ 完成 | 热重载/HTTP/注入检测/压缩器/审计轮转 |
| Phase 3 安全增强 | ✅ 完成 | 6 项安全风险全部修复（SECURITY_AUDIT.md）|
| 发布 | ⏳ | MCP 2026-07-28 后 1-2 周 |

## 约束

1. TypeScript strict 模式，零 any
2. 5 个生产依赖（不新增）
3. 每个策略模块独立可测（依赖注入）
4. 默认 fail-closed（拒绝）
5. 所有密钥从环境变量读，禁止硬编码

## 边界

- ✅ Always: 跑测试、更新文档、tsc --noEmit、commit
- ⚠️ Ask: 加依赖、改 GuardConfig 接口、改策略执行顺序
- 🚫 Never: 硬编码密钥、删测试、改已有公共接口

## 已知陷阱

| 症状 | 原因 | 解决 |
|------|------|------|
| MCP SDK v1.29 拒绝 tools/list 注册 | `capabilities: {}` 导致检查失败 | 改为 `capabilities: { tools: {} }` |
| `import.meta.dirname` 报错 | 某些 Node/TS 组合不支持 | 改用 `fileURLToPath(import.meta.url)` |
| Subagent 超时 | 43 次 API 调用 10 分钟不够 | 拆成 2-3 个 task/run |
| `deny: ["delete_*"]` 不拦截 `mock_delete` | resolveTool 先校验 tool 存在 | resolveTool 只检查 server，policy pipeline 负责 deny |
| 集成测试不通过 | 忘记先 build | `npm run build && npx vitest run` |

## 按需检索的文档

- 架构设计: `docs/architecture-mcp-guard.md`
- 安全审计: `docs/SECURITY_AUDIT.md`（6 项风险及修复状态）
- 压缩器指南: `docs/COMPRESSOR.md`

## Agent 规则

- 踩到新坑写入上方"陷阱"段（症状→原因→解决）
- commit message 格式: `type: 简短描述`（feat/fix/refactor/docs/chore）
- 改代码前先跑 `npx vitest run` 确认 baseline

## 最近活动

- 2026-07-20 23:20: **文档完善** — AGENTS/HANDOVER/LEARNINGS/CHANGELOG/SECURITY_AUDIT 同步更新。
