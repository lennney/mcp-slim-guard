# MCP Slim Guard Architecture

MCP Slim Guard is a local result-delivery runtime for Model Context Protocol
Tools. It reduces MCP context without changing which authorized upstream Tool
runs or the arguments sent to it.

This document describes the public runtime contract. Internal ranking rules,
tuning data, private test corpora, and release plans are outside this contract.

## Public modes

Slim Guard exposes one selected mode:

- Native advertises authorized upstream Tool names and `read_result`.
- Compact advertises `find_tool`, `call_tool`, and `read_result`.
- Extreme uses the Compact catalog and can return a shorter recoverable first
  delivery for eligible oversized results.

All modes share authorization, invocation, snapshot, and recovery behavior.
Host configuration selects the mode at process start.

## Call and delivery contract

For every call that passes validation and policy, Slim Guard:

1. resolves one exact entry from the current authorized catalog;
2. forwards the selected arguments unchanged;
3. invokes the upstream Tool at most once;
4. validates the upstream MCP result;
5. either passes the result through or returns a smaller local projection;
6. stores one immutable snapshot before any lossy delivery;
7. lets `read_result` search bounded local fragments or recover that snapshot
   without executing upstream again.

Pass-through preserves `isError`, content order and types,
`structuredContent`, `_meta`, advertised `outputSchema`, and unknown result
fields. Structured, mixed, error, schema-bound, source-like, or uncertain
results remain on the pass-through path.

Before Slim Guard contacts an upstream Tool, it validates arguments against the
advertised original input schema. A schema mismatch returns a local tool error
with a structured repair reason. The error does not echo submitted argument
values and does not invoke the upstream Tool.

If projection, storage, observation, or audit handling fails, Slim Guard
returns the exact upstream result. Delivery optimization must not turn a
successful upstream call into result loss.

## Authorization and isolation

- Unauthorized Tools stay out of discovery, schema, and call paths.
- Ambiguous Server or Tool identifiers are rejected instead of guessed.
- Each call is bound to the catalog generation in which it was authorized.
- Recovery references belong to the current runtime generation.
- Stdio stdout contains MCP protocol messages only.

The local audit path records delivery metadata without credentials, call
arguments, result bodies, or raw capability references by default.

## Self-service lifecycle

The public CLI provides a reversible local trial:

- `analyze` measures the configured catalog without calling Tools;
- `init` and `validate` prepare and check Slim Guard configuration;
- `plan` previews a Host configuration change;
- `verify` checks the selected mode without changing Host configuration or
  invoking an upstream business Tool;
- `install` backs up and applies one validated change;
- `profile` summarizes the latest local delivery metadata;
- `rollback` restores the recorded pre-install configuration and refuses to
  overwrite later user edits silently.

Slim Guard does not compress conversation history, provider prompts, source
files, or arbitrary application data. The Alpha release path is local stdio.
