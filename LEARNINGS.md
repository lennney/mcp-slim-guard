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

## 限速与连接标识（2026-07-21 续审）

### per_agent 限速需要 agentId 真正传入 ctx
- `RateLimitPolicy` 的 key 优先用 `ctx.agentId`，`per_agent` 覆盖也只在 `ctx.agentId` 命中时生效；但 `GuardProxy` 构造 `PolicyContext` 时从不设置 `agentId`，导致 `per_agent` 配置在生产中永远是死代码。
- 修复：把连接 `sessionId` 作为 `agentId` 传入，per-caller 限速才能隔离不同调用方；单测断言 PolicyContext 时记得带上 `agentId`。

### ServerManager.stop 要先关 client 再关 transport
- 只关 transport 会留下 Client 持有回调/句柄；先 `client.close()`（协议层关闭）再 `transport.close()` 更干净。
- 验证 stop 时要用真正的 MCP server 子进程（如 dist/mock-server.js），不要用 `node -e setInterval`——后者不是 MCP server，`client.connect` 会卡在协议握手，stop 永远等不到，诊断会误判。

## 已知缺陷（2026-07-21 续审，未修）

### SSRF mode="log" 不产生记录
- `SSRFConfig.mode` 定义了 "log"（放行但记录），但 `ssrf.ts` 实现是 `if (mode !== "block") return allowed`，log 和 off 都只放行，log 模式无任何记录输出。
- 测试（adversarial.test.ts:582）已锁定"log 放行"行为，但未覆盖"log 记录"。
- 真正实现需要给 Policy 接口加日志通道或在 PolicyResult 的 allowed:true 上携带 reason，让 proxy 层 audit trail 标记 SSRF log-only 命中——改动面较大，暂以文档修正 + 已知缺陷记录处理。

## CLI 配置透传（2026-07-21 续审）

### audit 配置项必须完整透传给 AuditLogger
- `cli.ts` 在 start 和 SIGHUP 重建 audit 时只传了 output/filePath，maxSize/maxFiles/compress/maxMemoryEntries 全被静默忽略——配置文件里设的轮转/内存上限在生产中无效。
- 抽 `buildAuditOptions(auditCfg, cwd)` 共享给 start 和 reload，确保两处一致且透传所有选项；新增 `maxMemoryEntries` 到 AuditConfig 让它可配置。
- 类似陷阱：新增配置项时记得同时更新 (1) config-types (2) config-schema 校验 (3) cli 构建逻辑 (4) 测试——漏掉任一处就会变成死配置。
