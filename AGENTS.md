---
type: AgentInstruction
title: micro-mcp — 轻量 MCP 安全代理
timestamp: "2026-07-22T15:00:00+08:00"
description: 一行命令给 MCP 加上 SSRF 防护 + 白名单 + 审计 + 限速 + 注入检测
tags:
  - micro-mcp
  - agentinstruction
  - security
  - proxy
---

# micro-mcp — 轻量 MCP 安全代理

一句话：一行命令给 MCP 加上 SSRF 防护 + 白名单 + 审计 + 限速 + 注入检测

## 常用命令

```bash
cd ~/micro-mcp
npm run build               # 编译到 dist/
npm test                    # 全量测试（395 tests, 20 files）
npx vitest run              # 同上
npx tsc --noEmit            # 类型检查
npm run bench               # 基准测试（无 API key 跑 3/4 模块）
npm run bench:tokens        # 离线 token 节省量
npm run bench:schema        # 离线 schema 保留率
npm run bench:latency       # 离线延迟
npm run bench:accuracy      # LLM 准确率（需 DEEPSEEK_API_KEY）
```

## 技术栈

| 组件             | 版本                                           |
| ---------------- | ---------------------------------------------- |
| Runtime          | Node ≥18, TypeScript 5.7                       |
| MCP SDK          | `@modelcontextprotocol/sdk` ^1.9.0（标准协议） |
| CLI              | Commander ^13.1                                |
| Logging          | Pino ^9.6                                      |
| Config           | js-yaml ^4.1                                   |
| Pattern matching | micromatch ^4.0                                |

## 核心架构

```
AI Agent → micro-mcp (STDIO 或 HTTP 代理)
             ├─ PolicyPipeline（串行：白名单→SSRF→注入检测→限速）
             ├─ ToolCache（内存 TTL+LRU，只读工具调用结果缓存）
             ├─ AuditLogger（pino JSON，支持按大小轮转）
             └─ ServerManager → 上游 MCP Server × N
```

- 工具名前缀路由：`github_search_repositories` → server: github, tool: search_repositories
- 串行管道短路求值：任一拒绝即停止
- 纯内存限速（Token Bucket），无持久化
- 热重载 SIGHUP 重建 pipeline + serverManager + audit logger
- 无损压缩：`micro-mcp start --compressor light|tight`

## 协议标准

micro-mcp 完全遵循 [MCP 标准协议](https://spec.modelcontextprotocol.io)：

| 标准      | 实现                                       |
| --------- | ------------------------------------------ |
| Transport | STDIO（默认）+ Streamable HTTP（`--http`） |
| 消息格式  | JSON-RPC 2.0                               |
| SDK       | `@modelcontextprotocol/sdk` v1.9.0（官方） |
| 生命周期  | Initialize → tools/list → tools/call       |

## 依赖关系

```
micro-mcp ──(MCP SDK)──→ 上游 MCP Server（GitHub / Playwright / ...）
```

## 项目状态

| 阶段                 | 状态    | 详情                                                                 |
| -------------------- | ------- | -------------------------------------------------------------------- |
| Phase 1 核心策略管道 | ✅ 完成 | 13/13 任务，155 tests                                                |
| Phase 2 高级功能     | ✅ 完成 | 热重载/HTTP/注入检测/压缩器/审计轮转                                 |
| Phase 3 安全增强     | ✅ 完成 | 6 项安全风险全部修复（SECURITY_AUDIT.md）                            |
| Phase 1 压缩对标     | ✅ 完成 | 5 级压缩 + lazy loading + 请求缓存 TTL+LRU + 基准测试套件，395 tests |
| 发布                 | ⏳      | MCP 2026-07-28 后 1-2 周                                             |

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

| 症状                                       | 原因                                                              | 解决                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| MCP SDK v1.29 拒绝 tools/list 注册         | `capabilities: {}` 导致检查失败                                   | 改为 `capabilities: { tools: {} }`                                                                      |
| `import.meta.dirname` 报错                 | 某些 Node/TS 组合不支持                                           | 改用 `fileURLToPath(import.meta.url)`                                                                   |
| Subagent 超时                              | 43 次 API 调用 10 分钟不够                                        | 拆成 2-3 个 task/run                                                                                    |
| `deny: ["delete_*"]` 不拦截 `mock_delete`  | resolveTool 先校验 tool 存在                                      | resolveTool 只检查 server，policy pipeline 负责 deny                                                    |
| 集成测试不通过                             | 忘记先 build                                                      | `npm run build && npx vitest run`                                                                       |
| slim 工具省略 inputSchema 导致 SDK 报错    | MCP SDK Zod 校验要求 inputSchema 必须是 object                    | slim 格式用 `{ type: "object", properties: {} }` 代替省略                                               |
| cache.ts 缓存命中不写审计日志              | proxy.ts 的 forwardToolCall 缓存命中直接 return，跳过了 audit.log | 缓存命中前显式调用 `this.audit.log(ctx, { allowed: true }, [{ policy: "cache", result: "pass" }], ...)` |
| ToolCache.set() 重复 key 导致 LRU 顺序污染 | set() 调用两次时，order 数组里 key 出现两次，map 里只有一次       | set() 前 `this.order = this.order.filter(k => k !== key)` 去重                                          |
| cache.ts 动词列表三处重复                  | CACHEABLE / SEARCH_LIKE / READ_LIKE 三个 regex 里动词列表各自独立 | 提取 `SEARCH_VERBS` / `READ_VERBS` 为常量，`buildVerbRegex()` 生成 regex，一处修改生效                  |
| 新加可缓存的动词需要改三处                 | 缓存动词列表在 regex 和 TTL 判断里硬编码                          | 修改 `SEARCH_VERBS` / `READ_VERBS` 常量即可，regex 和 TTL 自动跟随                                      |

## 按需检索的文档

- 架构设计: `docs/architecture-micro-mcp.md`
- 安全审计: `docs/SECURITY_AUDIT.md`（6 项风险及修复状态）
- 压缩器指南: `docs/COMPRESSOR.md`

## Agent 规则

- 踩到新坑写入上方"陷阱"段（症状→原因→解决）
- commit message 格式: `type: 简短描述`（feat/fix/refactor/docs/chore）
- 改代码前先跑 `npx vitest run` 确认 baseline

## 最近活动

- 2026-07-22 16:00: **基准测试套件** — 4 模块基准测试对标 slim-mcp（tokens/schema/latency/accuracy）。tiktoken devDep，DeepSeek V4 Flash 准确率测试。`npm run bench` 按 API key 可用性自动运行。
