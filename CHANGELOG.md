# Changelog

All notable public changes are recorded here. Internal development version
numbers are intentionally omitted.

## [Unreleased]

Target preview: `0.1.1-alpha.1` on the npm `alpha` dist-tag. The package version
has not been changed and no preview has been published by this work.

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
