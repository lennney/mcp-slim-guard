# Changelog

All notable public changes are recorded here. Internal development version
numbers are intentionally omitted.

## [Unreleased]

### Added

- `analyze` reports the current MCP catalog cost without calling a Tool or
  changing configuration.
- `plan` generates dry-run Host configuration changes for Codex and Claude
  Code.
- `install` applies one validated Host configuration transaction after
  creating a backup.
- `profile --last` summarizes the latest local delivery segment without
  reading result bodies.
- `rollback` restores the exact pre-install Host configuration and refuses to
  overwrite later edits.

### Documentation

- Updated contribution, support, issue, pull request, and security-reporting
  guidance for the current Generic and Host-native product surfaces.
- Added direct README entry points for bug reports, compatibility reports,
  feature requests, and first contributions.
- Moved development plans, research, launch drafts, and candidate acceptance
  notes out of the public source tree.

## [0.1.1-alpha.1] - 2026-07-28

Accepted Alpha candidate for the npm `alpha` channel.

### Added

- An explicit Host-native surface through `start --surface native`. Verified
  Hosts see authorized original Tools plus `read_result`.
- A model-selected Codex call and exact snapshot recovery through the native
  surface.
- Imported Tool `inputSchema` validation on native and generic calls before
  policy, cache, or upstream execution.
- Field-aware, Unicode-normalized Tool discovery with bounded zero-match
  catalog guidance and no model or remote retrieval dependency.
- A reproducible 100-Tool, 8,000-row automatic compression stress fixture,
  explicitly separated from the normal release benchmark.
- Correlated audit traces for policy, upstream execution, result projection,
  fail-open delivery, and bounded recovery.
- Runtime lifecycle traces for startup health, atomic reload, graceful
  shutdown, upstream cleanup, and Capsule invalidation.
- Runtime warnings now emit bounded error types instead of complete Error
  objects that could bypass audit redaction.
- Reload and shutdown now drain admitted tool calls before replacing Catalog,
  Capsule, Audit, or upstream runtime state.
- `doctor` now treats a structured upstream connection failure as failed
  instead of reporting an empty catalog as healthy.
- Package smoke assertions for trace completeness, reference redaction, and
  result-payload exclusion, including real stdio shutdown.
- Fixed `find_tool`, `call_tool`, and `read_result` product surface.
- Deterministic Payload Router for plain text, uniform JSON, log-like, and
  opaque MCP results.
- Immutable result snapshots with exact, bounded `read_result` recovery.
- Quota-free 24-task bilingual complete-task benchmark and 23-case content
  projection benchmark.
- 640-case deterministic security accuracy corpus.
- Exact-tarball pack, isolated install, stdio invocation, and uninstall smoke.
- Reproducible 12-to-3 terminal demo and Alpha market-entry roadmap.

### Changed

- Node.js 20 and MCP SDK 1.30 are the minimum supported runtime versions.
- Primary positioning is now **Context compression for MCP**.
- Compression occurs after the upstream `CallToolResult`; upstream arguments
  are not transformed.
- Small results, source code, diffs, and uncertain result shapes pass through.
- Catalog projection preserves standard and extension Tool metadata.
- Prerelease tags publish to `alpha`; stable releases alone publish to
  `latest`.
- Security detection and audit remain supporting protection rather than the
  primary product promise.

### Fixed

- Invalid imported Tool arguments return `InvalidParams` without executing
  upstream.
- Weak Tool candidates that only share generic schema vocabulary no longer
  inflate discovery results beside a strong match.
- Catalog guidance is returned only after zero matches, so normal `tools/list`
  calls do not preload or repeatedly pay for catalog text.
- POSIX npm symlink invocation now resolves the real CLI path before deciding
  whether to auto-run the command.
- Upstream tool calls no longer send client-only metadata or perform a second
  result parse across the SDK compatibility seam.
- SSRF preflight now checks HTTP(S) schemes only, resolves both A and AAAA
  records, validates allowlisted hosts against private IPs, and fails closed
  on DNS failure in block mode.
- SSRF preflight now also rejects IPv4 benchmark, multicast, reserved, and
  broadcast ranges plus IPv6 site-local and multicast targets.
- Invalid parameter-restriction regular expressions now fail closed instead
  of silently disabling the restriction.
- Partial Cache configuration and negative rate-limit values now fail schema
  validation instead of crashing a later call or disabling enforcement.
- Result Capsules now prune expired snapshots before writes, fail open above
  an 8 MiB single-snapshot limit, and enforce a 16 MiB runtime payload budget.
- Upstream MCP `isError` results are recorded as `upstream_error` instead of
  being misclassified as policy blocks.
- Raw `tool_ref` and `result_ref` values are recursively redacted from audit
  arguments and metadata.
- Audit sink or observation Adapter failures no longer interrupt result
  delivery or recovery.
- Reload now connects and validates a candidate upstream set before replacing
  the active runtime, and shutdown closes upstreams, Capsule state, and audit
  file handles through one path.

- Classifier, projection, validation, or storage failure now fails open to the
  exact upstream result.
- Result recovery never repeats an upstream call.
- Unknown top-level Tool extension fields survive official SDK validation and
  catalog projection.
- Stdio human logs stay off protocol stdout.

## [0.1.0] - 2026-07-22

First public npm release. It introduced the MCP proxy, policy pipeline,
compression compatibility modes, stdio/Streamable HTTP support, audit logging,
cache, configuration import, and benchmark foundations.
