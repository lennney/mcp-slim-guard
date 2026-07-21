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
