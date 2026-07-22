---
type: Learnings
title: mcp-guard LEARNINGS
timestamp: '2026-07-22T12:00:00+08:00'
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

## 改进方向落地（2026-07-21）

### SSRF log 模式用 allowed+reason 实现 warn 记录
- log 模式之前直接 `return allowed` 无记录。改为：走和 block 相同的检测，命中内网/黑名单时返回 `{ allowed: true, reason }`，pipeline 的 executeWithTrail 把它记成 warn 步骤（而非 pass），audit trail 即可体现。
- 这要求 PolicyResult 的 allowed 分支支持可选 reason——扩展为 `{ allowed: true; reason?: string }`，向后兼容（现有 allowed:true 不带 reason 仍是 pass）。
- 教训：adversarial.test.ts 里 "normalizeToIPv4 converts 127.1" 的注释归因是错的——实际拦截靠 Node URL 解析器把 127.1 标准化成 127.0.0.1，normalizeToIPv4 分支不可达。测试通过不代表归因正确。

### normalizeToIPv4 shorthand 是防御兜底
- Node URL 解析器当前把 decimal/hex/octal/shorthand 都标准化成 4-octet，normalizeToIPv4 这些分支实际不可达，但作为兜底保留并修正正确性（127.1 → 127.0.0.1，POSIX inet_aton 语义：缺失中间段补 0，最后段留在末尾）。

### 正则编译要缓存
- whitelist 的 param.pattern 每次工具调用都 new RegExp；高频调用下重复编译。按 pattern 字符串缓存 RegExp，行为不变。

## 压缩器 Pipeline 与 Lazy Loading（2026-07-22）

### slim 格式不能省略 inputSchema
- MCP SDK 的 Zod 校验要求 Tool 的 inputSchema 必须是 object，省略（undefined）会被 `$ZodError: expected object, received undefined` 拒绝。
- slim 格式（lazy loading 低优先级工具）必须用 `{ type: "object", properties: {} }` 代替省略，SDK 才接受。
- 单元测试可以对 `inputSchema` 断言 `toEqual({ type: "object", properties: {} })` 来验证 slim 格式。

### HIGH_PRIORITY 正则要适配 server 前缀
- 路线图说"匹配 search/list/read/get/find/describe/info"，但工具名是 `server_toolname` 格式（如 `github_search`、`mock_get_time`）。
- 纯 `^(search|...)` 匹配不到 `github_search`（以 `github` 开头），导致所有工具都被判为低优先级。
- 修正：`^(?:[^_]+_)?(search|list|read|get|find|describe|info)/i` — 允许可选的单段 server 前缀。

### 纯函数 pipeline 优于 switch/case
- 压缩器从 `getCompressedTools` + `getTransformTools`（两个函数 + proxy 三层 if 分支）重构为 `generateTools()` + 4 阶段纯函数 pipeline。
- 每个阶段 `(tools: Tool[]) => Tool[]`，用 `reduce` 组合，可独立测试、可任意重排。
- 新加压缩策略只需加一个 stage 函数，不改现有函数。比类继承或 switch/case 更解耦。

### 白名单逻辑不应重复
- 旧代码 `handleWrapperTool` 内部有 `isToolVisible` 白名单检查，和 `whitelistFilter` pipeline 阶段重复。
- 移到 pipeline 阶段 0 后，`handleWrapperTool` 不再需要 allow/deny 参数，proxy 调用时用 `whitelistFilter` 预过滤 `fullTools` 再传入。
- 集成测试需要更新断言：被 deny 的工具从 `not available` 变为 `Unknown tool`（因为已从列表中移除，不存在了）。

### lazy + wrapper 级别要退化
- `lazy_loading=true` + `light`/`normal` 时，lazy 不走 wrapper 模式，`levelToStage` 直接返回 passthrough。
- 否则 pipeline 会生成 wrapper 工具 + lazy 的 get_schema，两套发现机制冲突。
- 配置验证不需要额外逻辑——`levelToStage` 的 lazyLoading 参数短路即可。

## 缓存 TTL+LRU（2026-07-22）

### 动词列表单一来源
- `CACHEABLE`、`SEARCH_LIKE`、`READ_LIKE` 三个 regex 的动词列表完全相同但分散在三处。修改一个动词需要同步三处，容易遗漏。
- 解决：提取 `SEARCH_VERBS` / `READ_VERBS` 为 `ReadonlySet<string>`，通过 `buildVerbRegex()` 工厂函数生成 regex。`CACHEABLE` 用 union source + 前缀模式组合。新增或修改动词只需改 Set。

### set() 重复 key 导致 LRU 顺序污染
- `set()` 在 push 前未先过滤已有 key，导致同一 key 在 order 数组出现两次但 map 只有一次。LRU 淘汰 shift 出旧 key 时，map.delete 找不到，实际淘汰错误条目。
- 解决：在 push 前 `this.order = this.order.filter(k => k !== key)` 去重（同 `get()` 做法）。

### zero max_entries 死循环
- `while (this.order.length >= this.config.max_entries)` 在 max_entries=0 时恒为真。插入前无 item 可 shift，shift() 返回 undefined，if 跳过 delete，死循环。
- 解决：改为 `> this.config.max_entries`，且把淘汰循环移到插入之后（先插新条目，再淘汰溢出条目）。

### 缓存命中需要审计日志
- 设计文档要求缓存命中时审计 trail 追加 `{ policy: "cache", result: "pass" }`，但初版 forwardToolCall 在缓存命中时直接 return 跳过了 audit.log。
- 解决：缓存命中时显式调用 `this.audit.log(ctx, { allowed: true }, [{ policy: "cache", result: "pass" }], ...)`。

### 缓存可缓存判断默认只匹配 read 动词
- `isCacheable` 默认模式推断只匹配 `search|list|find|query|read|get|describe|info|check` 前缀的工具。其他工具（如 `echo`、`create`、`delete`）不会缓存。
- 测试用 `allow: ["*"]` 覆盖让非匹配工具可缓存；生产环境用 `cache.allow` 配置精确控制。

### TTL 与工具名模式关联
- 模式推断 TTL：search-like 动词 → 15s，read-like → 60s。通过 `SEARCH_LIKE` / `READ_LIKE` regex 匹配，先 search 后 read 的顺序保证 search 优先。
- `ttl_per_tool` 精确覆盖比模式推断优先；全局 `cache.ttl` 兜底。
