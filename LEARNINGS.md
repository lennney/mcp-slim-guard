---
type: Learnings
title: mcp-guard LEARNINGS
timestamp: '2026-07-20T23:30:00+08:00'
description: 项目开发中积累的技术教训和避坑指南
tags:
- learnings
- mcp-guard
---

# LEARNINGS.md

## 架构

### Compressor Wrapper 路由

- handleWrapperTool 返回有效结果后，**必须直接返回**，不能转发到 forwardToolCall
- 转发 wrapper 工具名（如 mcp__list_tools）给 resolveTool 会返回 Unknown tool
- mcp__invoke_tool 内部已委托给 serverCall（即 forwardToolCall）→ 双重调用风险
- **修复**: 直接返回 wrapperResult，审计日志由 proxy 显式写入

### DNS 缓存最小 TTL

- SSRF 防护的 DNS 缓存必须有最小 TTL clamp（10s）
- 外部 DNS 返回 TTL=0（无缓存）时，如果不 clamp 最小 TTL，攻击者可利用 DNS rebinding
- **修复**: `Math.max(10, Math.min(300, records.reduce(...)))`

### GuardConfig 的 audit 字段

- GuardConfig 接口中 audit 是必选字段，不是可选
- 测试的 makeConfig() 方法必须提供 `audit: { output: "stdout" }`
- 遗漏会导致 TypeScript 类型错误

## 测试

### 集成测试依赖 Build

- `tests/integration/` 下的测试依赖 `dist/mock-server.js`
- 运行前必须先 `npm run build`
- **建议**: CI 中 build 在 test 之前（已有 `npm run build && npm test`）

### DNS Mock 格式

- `dns.resolve4(hostname, { ttl: true })` 返回 `Array<{ address: string, ttl: number }>`
- 旧的 `mockResolvedValue(["1.2.3.4"])` 不再工作
- 新写法: `mockResolvedValue([{ address: "1.2.3.4", ttl: 60 }])`
