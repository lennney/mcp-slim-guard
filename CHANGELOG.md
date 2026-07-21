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

## [0.2.1] — 2026-07-21

### Fixed
- **SIGHUP hot-reload dropped the new ServerManager (critical)**: `cli.ts` rebuilt and started a new `ServerManager` on SIGHUP but never passed it to `proxy.reload()`, so the proxy kept the now-stopped old manager — every tool call failed after the first reload. The new manager is now forwarded to `reload()`.
- **tools/list served stale tools after reload**: `fullTools` was a `start()`-local const captured by the `tools/list` and compressor discovery handlers, so hot-reload never refreshed the advertised tool list. Promoted to a field, refreshed on `start()` and `reload()`.
- **AuditLogger in-memory entries grew unbounded**: `entries` was pushed on every audit/discovery event but `clear()` was never called in production — a memory leak. Entries are now capped at `maxMemoryEntries` (default 10000), dropping the oldest when exceeded.
- **proxy.reload duplicate assignment**: removed the redundant `this.serverManager = newServerManager` and refresh `fullTools` from the new manager instead.
- **HTTP transport test race**: replaced the fixed 500ms wait before `fetch` with port-readiness polling (30s window) and raised the test timeout to 45s, eliminating `ECONNREFUSED` flakiness when the upstream spawn is slow.

### Added
- Regression test: `reload()` refreshes `tools/list` to serve the new ServerManager's tools.

### Fixed (continued)
- **per_agent rate limits never took effect**: `GuardProxy` did not set `agentId` on the `PolicyContext` it built for each call, so the rate-limit policy always fell back to `serverName` and `per_agent` overrides were dead config. The connection session id is now passed as `agentId`, so per-caller limits actually isolate callers.
- **ServerManager.stop left client handles open**: `stop()` only closed the transport, leaving the `Client` holding callbacks/handles. Now closes the client first, then the transport, for a cleaner shutdown that does not keep the process alive after hot-reload.

- **Audit log rotation corrupted compressed backups (data integrity)**: in compress mode `rotate()` kicked off an async gzip of the current file while immediately reopening it for appending, so the gzip read stream and new writes hit the same file — new audit entries leaked into the compressed backup and old content could be truncated. The current file is now renamed to the backup name before the fd is rebuilt, and gzip reads the renamed file. Added the first rotation test that covers compression.

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
