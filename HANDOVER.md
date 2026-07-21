---
type: HandoverDoc
title: mcp-guard HANDOVER
timestamp: '2026-07-20T23:30:00+08:00'
description: 当前状态、已完成工作、待办事项
tags:
- handover
- mcp-guard
---

# HANDOVER.md

## 当前目标

打磨 mcp-guard 至发布就绪状态 — 安全加固 + 文档完善 + 测试覆盖

## 已完成

- [x] Phase 1 核心策略管道（白名单/SSRF/限速/审计）
- [x] Phase 2 高级功能（热重载/HTTP/注入检测/压缩器/日志轮转）
- [x] Phase 3 安全增强（SECURITY_AUDIT 6 项全部修复）
- [x] Compressor wrapper 路由 Bug 修复 + 白名单过滤
- [x] SSRF 协议扩展（file/gopher/dict/ftp/ldap/sftp）
- [x] SSRF DNS 缓存（TTL 感知，最小 10s clamp 防 rebinding）
- [x] Compressor E2E 集成测试（12 tests）
- [x] 文档 OKF 格式对齐 + CHANGELOG/SECURITY_AUDIT 更新

## 当前状态

| 指标 | 数值 |
|------|------|
| 测试 | 305 tests, 18 files, 全绿 |
| 生产依赖 | 5 个（未新增）|
| 源文件 | 15 个 |
| Build | tsc --noEmit 通过 |

## 待办

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

## 已尝试且失败的方法

- ❌ Compressor wrapper 走 forwardToolCall：导致 mcp__list_tools 报 Unknown tool

## 下一步

1. 审视 MCP 2026-07-28 协议变更对 guard 的影响
2. npm publish

## 上次更新

2026-07-20 23:30
