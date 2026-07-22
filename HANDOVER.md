---
type: HandoverDoc
title: micro-mcp HANDOVER
timestamp: '2026-07-22T18:30:00+08:00'
description: 当前状态、已完成工作、待办事项
tags:
- handover
- micro-mcp
---

# HANDOVER.md

## 当前目标

打磨 micro-mcp 至发布就绪状态 — 安全加固 + 文档完善 + 测试覆盖

> 2026-07-22 更新：完成 5 级压缩 + lazy loading（纯函数 pipeline + 预算预加载），见 CHANGELOG 0.3.0

## 已完成

- [x] Phase 1 核心策略管道（白名单/SSRF/限速/审计）
- [x] Phase 2 高级功能（热重载/HTTP/注入检测/压缩器/日志轮转）
- [x] Phase 3 安全增强（SECURITY_AUDIT 6 项全部修复）
- [x] Compressor wrapper 路由 Bug 修复 + 白名单过滤
- [x] SSRF 协议扩展（file/gopher/dict/ftp/ldap/sftp）
- [x] SSRF DNS 缓存（TTL 感知，最小 10s clamp 防 rebinding）
- [x] Compressor E2E 集成测试（12 tests）
- [x] 文档 OKF 格式对齐 + CHANGELOG/SECURITY_AUDIT 更新
- [x] 2026-07-21 热重载丢 ServerManager + tools/list 陈旧缓存 + 审计内存泄漏修复
- [x] 2026-07-21 HTTP 测试固定 sleep 改轮询端口就绪
- [x] 2026-07-22 压缩等级扩展 2→5（off/light/normal/extreme/maximum + tight 别名）
- [x] 2026-07-22 Lazy loading（纯函数 pipeline + 预算预加载 + mcp__get_schema 按需发现）
- [x] 2026-07-22 MCP 2026-07-28 协议适配（resultType + _meta + ttlMs + server/discover，+4 tests）

## 当前状态

| 指标 | 数值 |
|------|------|
| 测试 | 401 tests, 20 files, 全绿 (1 预存 CLI 失败) |
| 生产依赖 | 5 个（未新增）|
| 源文件 | 15 个 |
| Build | tsc --noEmit 通过 |
| 分支 | main（feat/lazy-loading 已合并删除）|

## 待办

- [x] 请求缓存 TTL+LRU + per-tool stats（Phase 1 P0，无缓存 → 只读结果缓存，LRU 淘汰，含 hits/misses/byTool 统计）
- [x] 基准测试（Phase 1 P0，对标 slim-mcp 的 120 API 准确率测试）
- [x] Phase 2 P0 收尾：HMR 热重载文档 + 审计日志轮转测试确认
- [x] 项目重命名：mcp-guard → micro-mcp（全部文档 + package.json repo URL）
- [x] npm publish 准备（版本号 0.4.0 + CHANGELOG 更新）
- [x] Dockerfile
- [x] MCP 2026-07-28 协议兼容适配（resultType + _meta + ttlMs + server/discover，计划：`docs/plans/2026-07-22-mcp-2026-07-28-protocol-adaptation.md`）

## 下一步

1. npm publish（`npm publish --access public`）
2. Phase 2 P1：Istio-style 策略模板 / 安全报告 CLI

## 关键决策

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-07-22 | MCP 2026-07-28 协议更新审视 — 核心结论：**tools/call 和 tools/list 消息格式不变，cache 可消费 ttlMs** | 见下方详细分析 |
| 2026-07-22 | Lazy loading 用 discover-then-call 路线（get_schema）而非 slim-mcp 的 promote-on-call+retry | 省一次 error 往返，显式可控 |
| 2026-07-22 | 纯函数 pipeline `(tools) => tools` 替代 switch/case | 可组合、可独立测试、零状态零副作用 |
| 2026-07-22 | slim 格式用 `{ type:"object", properties:{} }` 而非省略 inputSchema | MCP SDK Zod 校验要求 inputSchema 必须是 object |
| 2026-07-22 | HIGH_PRIORITY 正则加 `^(?:[^_]+_)?` 前缀 | 适配 `server_toolname` 命名约定（github_search 而非 search） |
| 2026-07-22 | 白名单过滤移到 pipeline 阶段 0 | 统一逻辑，删除 handleWrapperTool 内重复的 isToolVisible |

## MCP 2026-07-28 协议兼容分析

### 对 micro-mcp 影响评估

| 变更 | 严重度 | 对 micro-mcp 的影响 |
|------|--------|-------------------|
| `initialize` 握手移除 | 🔴 高危 | proxy 需在每请求注入 `_meta`（protocolVersion + clientCapabilities） |
| `resultType` 必填 | 🟡 中危 | proxy 返回结果需加 `resultType: "complete"` |
| `InputRequiredResult` (MRTR) | 🟡 中危 | server-initiated 请求不再可拦截，嵌套在 result 内 |
| `server/discover` 新方法 | 🟡 中危 | ServerManager 需转发或合成 |
| `tools/call` 格式 | 🟢 不变 | **好消息：核心消息格式完全兼容** |
| `tools/list` 格式 | 🟢 不变 | 工具定义字段不变 |
| `isError: true` | 🟢 不变 | 错误处理保持一致 |
| `ttlMs` + `cacheScope` | 🟢 利好 | ToolCache 可消费上游 TTL 提示，替代模式推断 |

### 需要适配的代码

1. `proxy.ts` `forwardToolCall`：注入 `resultType: "complete"`
2. `server-manager.ts`：每次调用前注入 `_meta`
3. `cache.ts`：`set()` 消费上游 `ttlMs` 提示（附加逻辑，非强制）
4. `server-manager.ts`：添加 `server/discover` 转发

## 已尝试且失败的方法

- ❌ Compressor wrapper 走 forwardToolCall：导致 mcp__list_tools 报 Unknown tool
- ❌ slim 格式省略 inputSchema：MCP SDK Zod 校验拒绝 undefined inputSchema

## 上次更新

2026-07-22 18:30
