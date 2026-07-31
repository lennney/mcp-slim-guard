# MCP Slim Guard Public Status

Updated: 2026-08-01

This page records released behavior. Unreleased architecture, prioritization,
thresholds, and product sequencing are maintained privately until they ship.

## Published Alpha: `0.1.1-alpha.1`

The public Alpha includes:

- Generic `find_tool`, `call_tool`, and `read_result`;
- a Host-native surface with authorized original Tools plus `read_result`;
- deterministic catalog and eligible-result reduction;
- at-most-once upstream execution and exact snapshot recovery;
- pass-through of structured, mixed, error, schema-bound, and uncertain
  results;
- fail-open delivery if local optimization cannot complete safely;
- read-only catalog assessment and local delivery profiling;
- previewed, backed-up Host configuration installation and conflict-aware
  rollback;
- public setup paths for Codex and Claude Code, with VS Code configuration
  preview only.

The npm package is published on the `alpha` dist-tag. The primary release path
is local stdio on Node.js 20 or newer.

## Evidence boundary

Public claims are limited to reproducible released fixtures and recorded
compatibility smokes. They do not claim universal Token reduction, provider
billing savings, model answer quality, or support for every Host and MCP
Server combination.

Compatibility reports and reproducible bugs are welcome through the public
repository. A capability is added to this page only after it is released.
