# mcp-guard — 轻量 MCP 安全代理

一句话：一行命令给 MCP 加上 SSRF 防护 + 白名单 + 审计 + 限速

## 常用命令

```bash
cd ~/mcp-guard
npm test                    # 全量测试（155 tests, 12 files）
npx vitest run              # 同上
npx tsc --noEmit            # 类型检查
npm run build               # 编译到 dist/
```

## 技术栈

TypeScript / Node 20 / MCP SDK / Vitest / Commander / Pino / Micromatch

## 核心架构

```
AI Agent → mcp-guard (STDIO 代理)
             ├─ PolicyPipeline（串行：白名单→SSRF→限速）
             ├─ AuditLogger（pino JSON）
             └─ ServerManager → 上游 MCP Server × N
```

- 工具名前缀路由：`github_search_repositories` → server: github, tool: search_repositories
- 串行管道短路求值：任一拒绝即停止
- 纯内存限速（Token Bucket），无持久化
- 不拦截 tools/list，只拦截 tools/call

## 依赖关系

```
mcp-guard ──(MCP SDK)──→ 上游 MCP Server（GitHub / Playwright / ...）
mcp-guard ──(参考)──→ agent-search-mcp（同栈，MCP 协议经验）
```

## 项目状态

| 阶段 | 状态 | 详情 |
|------|------|------|
| PRD | ✅ | ~/docs/PRD-mcp-guard.md（8章）|
| 竞品分析 | ✅ | 15 项目 |
| 架构设计 | ✅ | ~/docs/architecture-mcp-guard.md（871行）|
| 实现计划 | ✅ | ~/docs/mcp-guard/PLAN.md（3002行，13任务）|
| Phase 1 编码 | ✅ | 13/13 任务，155 tests / 12 files |
| Launch | ⏳ | MCP 2026-07-28 后 1-2 周 |

### Phase 1 完成情况

| Task | 模块 | 状态 | 测试 |
|------|------|------|------|
| 1 | 项目脚手架 | ✅ | — |
| 2 | 配置类型定义 | ✅ | 14 passed |
| 3 | 配置加载器 | ✅ | 14 passed |
| 4 | 策略管道 | ✅ | 4 passed |
| 5 | 白名单策略 | ✅ | 9 passed |
| 6 | SSRF 策略 | ✅ | 16 passed |
| 7 | 速率限制 (Token Bucket) | ✅ | 33 passed |
| 8 | 审计日志 (pino) | ✅ | 11 passed |
| 9 | Server Manager | ✅ | 14 passed |
| 10 | GuardProxy | ✅ | 11 passed |
| 11 | CLI | ✅ | 10 passed |
| 12 | Mock MCP Server | ✅ | 10 passed |
| 13 | 集成测试 | ✅ | 9 passed |

## 约束

1. TypeScript strict 模式，零 any
2. 5 个生产依赖，不新增
3. 每个策略模块独立可测，通过依赖注入
4. 默认 fail-closed（拒绝）
5. 所有密钥从环境变量读，禁止硬编码

## 边界

- ✅ Always: 跑测试、更新文档、tsc --noEmit、commit
- ⚠️ Ask: 加依赖、改 GuardConfig 接口、改策略执行顺序
- 🚫 Never: 硬编码密钥、删测试、改已有公共接口、跳过 TDD

## 模型策略

| 模型 | 用途 | 费用 |
|------|------|------|
| deepseek-v4-flash | 机械性编码（脚手架/类型/测试） | 低 |
| kimi-2.7-code | 策略逻辑/代理核心 | 中 |
| qwen3.7-plus / claude-sonnet-4 | 架构审查/关键模块 | 高 |

## 陷阱

| 症状 | 原因 | 解决 |
|------|------|------|
| Subagent 超时 | 43次 API 调用 10 分钟不够 | 拆成 2-3 个 task/run |
| SSRF 误杀 `block_private_ips:false` | 域名黑名单 `block_domains` 仍生效 | 测试需清空 block_domains |
| MCP SDK 版本不兼容 | ^1.9.0 语法变 | 锁定版本 + CI 矩阵 |
| `import.meta.dirname` 报错 | 某些 Node/TS 组合不支持 | 改用 `fileURLToPath(import.meta.url)` |
| MCP SDK v1.29 `capabilities:{}` 拒绝 tools/list 注册 | Server.assertRequestHandlerCapability 检查 | 改为 `capabilities: { tools: {} }` |

## Agent 规则

- 每次完成任务后，更新下方"最近活动"段
- 踩到新坑写入上方"陷阱"段（症状→原因→解决）
- commit message 格式: `type: 简短描述`（feat/fix/refactor/docs/chore）
- 改代码前先跑 `npx vitest run` 确认 baseline
- 架构设计文档: `~/docs/architecture-mcp-guard.md`
- 实现计划: `~/docs/mcp-guard/PLAN.md`
- PRD: `~/docs/PRD-mcp-guard.md`

## 最近活动

- 2026-07-20 02:55: **Phase 1 全部完成** — 13/13 tasks, 155 tests, 12 files, build OK。7 commits pushed。模型: deepseek-v4-flash。
