# MCP Slim Guard Architecture

MCP Slim Guard is a local result-delivery runtime for Model Context Protocol
Tools. It reduces MCP context without changing which authorized upstream Tool
runs or the arguments sent to it.

This document describes the behavior shipped in the public Alpha. Internal
ranking rules, tuning data, private test corpora, and unreleased product plans
are intentionally outside the public contract.

## Public surfaces

Slim Guard exposes two compatible surfaces:

- The Generic surface advertises `find_tool`, `call_tool`, and `read_result`.
- The Host-native surface advertises authorized upstream Tool names together
  with `read_result`.

Both surfaces share the same authorization, invocation, delivery, snapshot,
and recovery behavior. Host-specific configuration stays at the adapter edge.

## Call and delivery contract

For every accepted call, Slim Guard:

1. resolves one exact entry from the current authorized catalog;
2. forwards the selected arguments unchanged;
3. invokes the upstream Tool at most once;
4. validates the upstream MCP result;
5. either passes the result through or returns a smaller local projection;
6. stores one immutable snapshot before any lossy delivery;
7. lets `read_result` read that snapshot without executing upstream again.

Pass-through preserves `isError`, content order and types,
`structuredContent`, `_meta`, advertised `outputSchema`, and unknown result
fields. Structured, mixed, error, schema-bound, source-like, or uncertain
results remain on the pass-through path.

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
- `install` backs up and applies one validated change;
- `profile --last` summarizes local delivery metadata;
- `rollback` restores the recorded pre-install configuration and refuses to
  overwrite later user edits silently.

Slim Guard does not compress conversation history, provider prompts, source
files, or arbitrary application data. The Alpha release path is local stdio.

