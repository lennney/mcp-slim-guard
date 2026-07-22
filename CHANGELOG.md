---
type: Changelog
title: mcp-guard CHANGELOG
timestamp: '2026-07-20T23:30:00+08:00'
description: 版本变更记录
tags:
- mcp-guard
- changelog
---

# Changelog

## [Unreleased]

### Added
- **Request cache TTL+LRU** — 只读工具调用结果内存缓存。配置项 `cache.enabled`（默认 false）启用。按工具名模式自动推断 TTL（search 类 15s, read 类 60s），支持 `allow/deny` 精确控制和 `ttl_per_tool` 逐工具覆盖。LRU 淘汰，默认 500 条上限。`isError: true` 不缓存。
- **基准测试套件** — 4 模块基准测试对标 slim-mcp。`bench:tokens`（离线 token 节省）、`bench:schema`（离线 schema 保留率）、`bench:latency`（离线延迟）、`bench:accuracy`（DeepSeek V4 Flash 准确率，12 场景含模糊测试）。`npm run bench` 按 API key 可用性自动运行。tiktoken 为 devDependency。

## [0.3.0] — 2026-07-22

### Added
- **Lazy loading** — tools/list 返回 slim 工具 stub（name + description + 空 schema），LLM 通过 `mcp__get_schema` 按需获取完整 schema，然后直接调用真实工具名。安全管道基于真实工具名生效。新增 `lazy_loading`（boolean，默认 false）和 `lazy_budget`（number，默认 8）配置项。CLI 新增 `--lazy` 和 `--lazy-budget` 选项。借鉴 slim-mcp 预算预加载机制（高优先级工具 search/list/read/get/find/describe/info 预暴露完整 schema）。
- **纯函数 Pipeline** — 压缩器重构为 4 阶段纯函数 pipeline：`whitelistFilter` → `levelToStage` → `applyLazyBudget` → `injectGetSchema`。每个阶段是 `(tools: Tool[]) => Tool[]` 纯函数，用 `reduce` 组合，可独立测试。

### Changed
- 删除 `getCompressedTools` / `getTransformTools`，统一由 `generateTools()` 入口处理。
- `handleWrapperTool` 简化：移除内部 `isToolVisible` 白名单逻辑（已移到 pipeline 阶段 0），新增 `GET_SCHEMA` case（lazy 模式发现工具）。
- proxy.ts tools/list handler 简化：从三层 if 分支改为统一调 `generateTools()`。
- proxy.ts tools/call handler 简化：按 `mcp__*` 前缀拦截，删除 `isWrapperLevel` 判断。

### Fixed
- slim 格式从省略 `inputSchema` 改为 `{ type: "object", properties: {} }` — MCP SDK Zod 校验要求 inputSchema 必须是 object。

## [0.2.1] — 2026-07-21

### Fixed
- **SIGHUP hot-reload dropped the new ServerManager (critical)**: `cli.ts` rebuilt and started a new `ServerManager` on SIGHUP but never passed it to `proxy.reload()`, so the proxy kept the now-stopped old manager — every tool call failed after the first reload. The new manager is now forwarded to `reload()`.
- **tools/list served stale tools after reload**: `fullTools` was a `start()`-local const captured by the `tools/list` and compressor discovery handlers, so hot-reload never refreshed the advertised tool list. Promoted to a field, refreshed on `start()` and `reload()`.
- **AuditLogger in-memory entries grew unbounded**: `entries` was pushed on every audit/discovery event but `clear()` was never called in production — a memory leak. Entries are now capped at `maxMemoryEntries` (default 10000), dropping the oldest when exceeded.
- **proxy.reload duplicate assignment**: removed the redundant `this.serverManager = newServerManager` and refresh `fullTools` from the new manager instead.
- **HTTP transport test race**: replaced the fixed 500ms wait before `fetch` with port-readiness polling (30s window) and raised the test timeout to 45s, eliminating `ECONNREFUSED` flakiness when the upstream spawn is slow.

### Added
- Regression test: `reload()` refreshes `tools/list` to serve the new ServerManager's tools.

### Changed (improvements)
- **SSRF mode=log now actually records**: previously log mode passed through with no record (documented as a known gap). It now walks the same detection as block mode and, on a private-IP or block-domain hit, returns `allowed: true` with a `reason`, which the pipeline records as a `warn` step in the audit trail. `PolicyResult` gained an optional `reason` on the allowed branch; `executeWithTrail` records warn vs pass accordingly. New tests cover log-mode warn, public-IP pass, block-domain warn, and the pipeline warn trail.
- **normalizeToIPv4 shorthand correctness**: the shorthand branch ("127.1" → ...) appended zeros at the end, producing `127.1.0.0` instead of `127.0.0.1`. Now uses POSIX inet_aton semantics (missing middle octets filled with 0, last group stays last). This is a defensive fix — Node's URL parser currently normalizes these forms upstream so the branch is rarely reached, but the fallback logic is now correct.
- **whitelist param.pattern regex caching**: `new RegExp(rule.pattern)` was compiled on every matching tool call; now cached per pattern string. Behavior unchanged.

### Fixed (continued)
- **per_agent rate limits never took effect**: `GuardProxy` did not set `agentId` on the `PolicyContext` it built for each call, so the rate-limit policy always fell back to `serverName` and `per_agent` overrides were dead config. The connection session id is now passed as `agentId`, so per-caller limits actually isolate callers.
- **ServerManager.stop left client handles open**: `stop()` only closed the transport, leaving the `Client` holding callbacks/handles. Now closes the client first, then the transport, for a cleaner shutdown that does not keep the process alive after hot-reload.

- **Audit log rotation corrupted compressed backups (data integrity)**: in compress mode `rotate()` kicked off an async gzip of the current file while immediately reopening it for appending, so the gzip read stream and new writes hit the same file — new audit entries leaked into the compressed backup and old content could be truncated. The current file is now renamed to the backup name before the fd is rebuilt, and gzip reads the renamed file. Added the first rotation test that covers compression.

- **Audit rotation/memory settings in config were silently ignored**: `cli.ts` built `AuditLogger` from only `output` and `filePath`, so `maxSize`, `maxFiles`, `compress` and `maxMemoryEntries` set in `mcp-guard.yml` never reached the logger (rotation always used defaults). A shared `buildAuditOptions` now forwards the full audit config for both `start` and SIGHUP reload; `maxMemoryEntries` was added to `AuditConfig` so it is configurable. Tests cover the option forwarding.

## [0.2.0] — 2026-07-20

### Fixed
- **compressor wrapper routing (critical)**: proxy.ts no longer discards `handleWrapperTool` result and sends wrapper tools to `forwardToolCall` — was causing "Unknown tool" for `mcp__list_tools`/`mcp__get_tool_schema` and double-invocation for `mcp__invoke_tool`
- **compressor whitelist bypass**: `mcp__list_tools` and `mcp__get_tool_schema` now filter results against allow/deny patterns, preventing information disclosure

### Added
- **SSRF protocol expansion**: `extractURLs` now detects `file://`, `gopher://`, `dict://`, `ftp://`, `ldap://`, `sftp://` URLs (previously only `http/https`)
- **SSRF DNS cache**: TTL-aware DNS cache with minimum 10s clamp to prevent DNS rebinding attacks
- **Compressor E2E integration tests**: 12 tests covering all wrapper tools, whitelist filtering, deny policy, audit logging, and tight/light levels

### Changed
- **`mcp-guard init` default**: `injection_detection` now defaults to `enabled: true, sensitivity: medium, mode: block`
- **CLI help**: `--compressor` option now shows available levels
- **package.json**: Added keywords, homepage, bugs, repository, engines, license metadata

### Removed
- **SECURITY_AUDIT gaps**: All 6 identified risks now resolved and verified in tests

## [0.1.0] — 2026-07-20

### Added
- **Security policy pipeline**: whitelist (glob) → SSRF (IP/domain) → injection detection (17 patterns) → rate limit (token bucket) → audit log
- **CLI commands**: `init`, `start`, `validate`, `doctor`, `status`, `log --tail`, `uninit`
- **validate**: dry-run policy check that connects to upstream servers and reports allowed/denied/no-match tools
- **doctor**: upstream server connectivity diagnostic
- **hot reload**: `kill -HUP <pid>` reloads `mcp-guard.yml` without downtime
- **HTTP transport**: `mcp-guard start --http --port 3000` for SSE/streamable HTTP
- **lossless compression**: `--compressor light|tight` wrapper mode for 30+ tools scenarios
- **injection detection**: 17 attack patterns (Shell, SQL, Prompt, Path Traversal) with 3 sensitivity levels
- **benchmark suite**: `scripts/benchmark.mjs` — direct vs guarded latency comparison
- **smoke test**: `scripts/smoke-test.mjs` — end-to-end MCP protocol correctness
- **companion guide**: `docs/COMPRESSOR.md` — mcp-compressor integration decision tree

### Changed
- `resolveTool` no longer validates tool existence against upstream list; policy pipeline handles deny intercept
- Default deny patterns updated to `*_delete_*`, `*_drop_*`, `*_admin_*` for prefixed-name matching

### Fixed
- Whitelist glob matching failed because `PolicyContext.toolName` was stripped (missing server prefix)
- Deny rules ignored when tool not in upstream list (resolveTool short-circuited)

### Stats
- 267 tests, 14 source files, 5 production dependencies
- Guard proxy overhead: ~2ms per call (benchmarked against agent-search-mcp)
