# MCP Slim Guard Roadmap

MCP Slim Guard is focused on reducing MCP context while preserving the
original upstream call and recoverable result.

## Current public line

The current public product line provides:

- Native, Compact, and Extreme Host modes;
- full original schemas on Compact and Extreme discovery;
- recoverable delivery for eligible oversized results;
- bounded local fragment lookup within a captured result, with exact sequential
  recovery still available;
- pass-through for structured, mixed, error, and uncertain results;
- immutable local snapshots and bounded exact recovery;
- read-only catalog, runtime, and mode checks;
- reversible Host installation with conflict-safe rollback.

## Direction

Near-term work stays focused on compatibility, Tool discovery quality, recovery
usability, packaging, and operational reliability. Future work must preserve
the same-call, complete-schema, authorization, and exact-recovery contracts and
use reproducible evidence.

This page is intentionally non-committal. It does not publish internal
priorities, dates, thresholds, evaluation cases, implementation designs, or
launch plans. It is updated after a public capability or support level changes.
