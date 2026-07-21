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

## 热重载与资源生命周期（2026-07-21 审查）

### SIGHUP reload 必须把新 ServerManager 传给 proxy
- `cli.ts` 的 SIGHUP 处理器 stop 旧 manager、start 新 manager 后，**必须**把新 manager 作为第 4 参传给 `proxy.reload(newConfig, newPipeline, newAudit, serverManager)`；否则 proxy 仍持有已 stop 的旧 manager，重载后所有工具调用失败。
- 这类 bug 不会在单测里暴露，因为没有覆盖 SIGHUP→reload→工具调用的端到端测试；新增的 reload 回归测试只覆盖 `tools/list` 刷新，端到端 SIGHUP 仍依赖集成验证。

### fullTools 不能是 start() 的局部 const
- `tools/list` 和 compressor 发现 handler 在 `start()` 里闭包捕获 `fullTools`；reload 换了 manager 后这个缓存不会刷新，导致工具清单陈旧。必须把 `fullTools` 提为类字段，在 `reload()` 里用新 manager 的 `getTools()` 刷新。

### AuditLogger.entries 必须有内存上限
- `entries.push` 每条审计/发现事件都执行，但生产从不调 `clear()`；长时间运行会 OOM。加 `maxMemoryEntries`（默认 10000）并在 push 后截断最旧的。

### HTTP 测试不要用固定 sleep 等端口就绪
- 固定 500ms 在 spawn/连接慢的机器上不够，导致 ECONNREFUSED；改成轮询 `fetch` 重试到端口就绪或超时，并给测试设足够的 testTimeout（>轮询窗口）。
