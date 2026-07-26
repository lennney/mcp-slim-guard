# Changelog

All notable public changes are recorded here. Internal development version
numbers are intentionally omitted.

## [Unreleased]

### Added

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

### Fixed

- Upstream MCP `isError` results are recorded as `upstream_error` instead of
  being misclassified as policy blocks.
- Raw `tool_ref` and `result_ref` values are recursively redacted from audit
  arguments and metadata.
- Audit sink or observation Adapter failures no longer interrupt result
  delivery or recovery.
- Reload now connects and validates a candidate upstream set before replacing
  the active runtime, and shutdown closes upstreams, Capsule state, and audit
  file handles through one path.

## [0.1.1-alpha.1] - 2026-07-26

Internal Alpha candidate. The package version is prepared locally for frozen
dogfood; no npm preview has been published.

### Added

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
