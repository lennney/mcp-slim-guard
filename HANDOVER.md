---
type: HandoverDoc
title: mcp-guard HANDOVER
timestamp: '2026-07-22T12:00:00+08:00'
description: 当前状态、已完成工作、待办事项
tags:
- handover
- mcp-guard
---

# HANDOVER.md

## 当前目标

打磨 mcp-guard 至发布就绪状态 — 安全加固 + 文档完善 + 测试覆盖

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

## 当前状态

| 指标 | 数值 |
|------|------|
| 测试 | 369 tests, 19 files, 全绿 |
| 生产依赖 | 5 个（未新增）|
| 源文件 | 15 个 |
| Build | tsc --noEmit 通过 |
| 分支 | main（feat/lazy-loading 已合并删除）|

## 待办

- [ ] 请求缓存 TTL+LRU（Phase 1 P0，无缓存 → 只读结果缓存，LRU 淘汰）
- [ ] 基准测试（Phase 1 P0，对标 slim-mcp 的 120 API 准确率测试）
- [ ] MCP 2026-07-28 协议更新后审视兼容性
- [ ] npm publish 准备（版本号 bump、README 最终审核）
- [ ] 考虑 Dockerfile

## 关键决策

| 日期 | 决策 | 原因 |
|------|------|------|
| 2026-07-20 | Compressor wrapper 路由：直接返回 wrapperResult 而非 forwardToolCall | 避免双重调用和 Unknown tool 错误 |
| 2026-07-20 | SSRF DNS 缓存最小 TTL 10s | 防 DNS rebinding，避免 TTL=0 的域名被利用 |
| 2026-07-20 | injection_detection 默认 enabled | 开箱安全，不让用户意外暴露 |
| 2026-07-20 | 文档对齐 OKF 格式标准 | 统一工作区知识管理 |
| 2026-07-22 | Lazy loading 用 discover-then-call 路线（get_schema）而非 slim-mcp 的 promote-on-call+retry | 省一次 error 往返，显式可控 |
| 2026-07-22 | 纯函数 pipeline `(tools) => tools` 替代 switch/case | 可组合、可独立测试、零状态零副作用 |
| 2026-07-22 | slim 格式用 `{ type:"object", properties:{} }` 而非省略 inputSchema | MCP SDK Zod 校验要求 inputSchema 必须是 object |
| 2026-07-22 | HIGH_PRIORITY 正则加 `^(?:[^_]+_)?` 前缀 | 适配 `server_toolname` 命名约定（github_search 而非 search） |
| 2026-07-22 | 白名单过滤移到 pipeline 阶段 0 | 统一逻辑，删除 handleWrapperTool 内重复的 isToolVisible |

## 已尝试且失败的方法

- ❌ Compressor wrapper 走 forwardToolCall：导致 mcp__list_tools 报 Unknown tool
- ❌ slim 格式省略 inputSchema：MCP SDK Zod 校验拒绝 undefined inputSchema

## 下一步

1. 请求缓存 TTL+LRU（Phase 1 剩余 P0）
2. 基准测试（Phase 1 剩余 P0）
3. 审视 MCP 2026-07-28 协议变更对 guard 的影响
4. npm publish

## 上次更新

2026-07-22 12:00
