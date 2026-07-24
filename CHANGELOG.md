---
type: Changelog
title: mcp-slim-guard CHANGELOG
timestamp: "2026-07-24T12:00:00+08:00"
description: 版本变更记录 — schema 压缩 + 安全 MCP 代理
tags:
  - mcp-slim-guard
  - changelog
  - security
  - proxy
  - compression
---

# Changelog

> **版本说明**: 内部开发版本为 0.1.0→0.4.0（均未发布到 npm），首次公开发布为 **0.1.0**（2026-07-22）。

## [0.1.0] — 2026-07-22

**First public release (npm)** — 包含 Phase 1 + Phase 2 P0 全部功能。

### 核心能力

- **5 级 schema 压缩**（off/light/normal/extreme/maximum）+ lazy loading
- **安全策略管道**：白名单 → SSRF 防护 → 注入检测 → 限速 → 审计
- **请求缓存** TTL+LRU（内存 Map，per-tool stats）
- **热重载** SIGHUP 零停机配置更新
- **审计日志** pino JSON 输出 + 轮转 + gzip 压缩
- **基准测试套件** 4 模块（tokens/schema/latency/accuracy）
- **STDIO + Streamable HTTP** 双传输

### 开发历史（预发布）

以下版本均为内部开发版本，全部功能合并于 0.1.0 公开发布。

#### [0.4.0] — 2026-07-22 (pre-release)

##### Added

- **MCP 2026-07-28 协议适配** — 4 项代码适配：`resultType: "complete"` 注入、`_meta` 每请求传递、`ttlMs` 可选缓存提示、`server/discover` 合成方法。SDK 1.29.0 polyfill 策略
- **Request cache TTL+LRU** — 只读工具调用结果内存缓存。配置项 `cache.enabled`（默认 false）启用。按工具名模式自动推断 TTL（search 类 15s, read 类 60s），支持 `allow/deny` 精确控制和 `ttl_per_tool` 逐工具覆盖。LRU 淘汰，默认 500 条上限。`isError: true` 不缓存
- **Per-tool cache stats** — `stats().byTool` 返回每个工具的 hits/misses 明细
- **基准测试套件** — 4 模块：`bench:tokens`、`bench:schema`、`bench:latency`、`bench:accuracy`（DeepSeek V4 Flash，12 场景含模糊测试）。`npm run bench` 自动运行。tiktoken 为 devDependency
- **HMR 热重载文档** — README 新增"热重载"章节

##### Changed

- **项目重命名** — mcp-guard → micro-mcp → mcp-slim-guard，仓库 URL 更新

#### [0.3.0] — 2026-07-22 (pre-release)

##### Added

- **Lazy loading** — tools/list 返回 slim 工具 stub，LLM 通过 `mcp__get_schema` 按需获取完整 schema。新增 `lazy_loading`、`lazy_budget` 配置项。借鉴 slim-mcp 预算预加载机制
- **纯函数 Pipeline** — 压缩器重构为 4 阶段纯函数 pipeline：`whitelistFilter` → `levelToStage` → `applyLazyBudget` → `injectGetSchema`

##### Changed

- 删除 `getCompressedTools`/`getTransformTools`，统一 `generateTools()`
- `handleWrapperTool` 简化：白名单逻辑移到 pipeline 阶段 0，新增 `GET_SCHEMA` case
- proxy.ts tools/list handler 简化

##### Fixed

- slim 格式 `inputSchema` 改为 `{ type: "object", properties: {} }` — MCP SDK Zod 校验要求 inputSchema 必须是 object

#### [0.2.1] — 2026-07-21 (pre-release)

##### Fixed

- **SIGHUP hot-reload dropped the new ServerManager (critical)**: `cli.ts` rebuilt ServerManager but never passed to `proxy.reload()`. New manager now forwarded to `reload()`
- **tools/list served stale tools after reload**: Promoted `fullTools` from local const to field, refreshed on `start()` and `reload()`
- **AuditLogger in-memory entries grew unbounded**: Entries now capped at `maxMemoryEntries` (default 10000)
- **proxy.reload duplicate assignment**: Removed redundant assign, refresh `fullTools` from new manager
- **HTTP transport test race**: Replaced fixed 500ms wait with port-readiness polling (30s window), 45s timeout

##### Added

- Regression test: `reload()` refreshes `tools/list`

##### Changed

- **SSRF mode=log now actually records**: Log mode now walks same detection as block mode, records `warn` step in audit trail. `PolicyResult` gained optional `reason`
- **normalizeToIPv4 shorthand correctness**: Uses POSIX inet_aton semantics (missing middle octets = 0, last group stays last)
- **whitelist param.pattern regex caching**: Compiled once per pattern

##### Fixed (continued)

- **per_agent rate limits never took effect**: `GuardProxy` didn't set `agentId` on `PolicyContext`. Connection session id now passed as `agentId`
- **ServerManager.stop left client handles open**: Closes client first, then transport
- **Audit log rotation corrupted compressed backups**: Rename before gzip to prevent concurrent writes
- **Audit rotation/memory settings ignored**: `buildAuditOptions` now forwards full config; `maxMemoryEntries` added to `AuditConfig`

#### [0.2.0] — 2026-07-20 (pre-release)

##### Fixed

- **compressor wrapper routing (critical)**: proxy.ts no longer discards `handleWrapperTool` result
- **compressor whitelist bypass**: `mcp__list_tools`/`mcp__get_tool_schema` now filter against allow/deny

##### Added

- **SSRF protocol expansion**: `extractURLs` now detects `file://`, `gopher://`, `dict://`, `ftp://`, `ldap://`, `sftp://`
- **SSRF DNS cache**: TTL-aware minimum 10s clamp to prevent DNS rebinding
- **Compressor E2E integration tests**: 12 tests

##### Changed

- `mcp-guard init` default: `injection_detection` → `enabled: true, sensitivity: medium, mode: block`
- CLI help, package.json metadata

##### Removed

- All 6 SECURITY_AUDIT risks resolved

#### [0.1.0] — 2026-07-20 (pre-release)

##### Added

- **Security policy pipeline**: whitelist → SSRF → injection detection → rate limit → audit log
- **CLI commands**: `init`, `start`, `validate`, `doctor`, `status`, `log --tail`, `uninit`
- **validate**: dry-run policy check
- **doctor**: upstream server connectivity diagnostic
- **hot reload**: `kill -HUP <pid>`
- **HTTP transport**: `--http --port 3000`
- **lossless compression**: `--compressor light|tight`
- **injection detection**: 17 attack patterns, 3 sensitivity levels
- **benchmark suite**: `scripts/benchmark.mjs`
- **smoke test**: `scripts/smoke-test.mjs`

##### Changed

- `resolveTool` no longer validates tool existence; policy pipeline handles deny intercept
- Default deny patterns: `*_delete_*`, `*_drop_*`, `*_admin_*`

##### Fixed

- Whitelist glob matching (tool name stripped of server prefix)
- Deny rules ignored when tool not in upstream list

##### Stats

- 267 tests, 14 source files, 5 production dependencies
- Guard proxy overhead: ~2ms per call
