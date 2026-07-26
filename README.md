# mcp-slim-guard

**One endpoint. Three tools. Guarded by default.**

mcp-slim-guard is an opinionated MCP compatibility middle layer. It connects
to your existing MCP servers and exposes one compact MCP endpoint:

- `find_tool` finds authorized tools and returns exact input schemas.
- `call_tool` executes a catalog-bound reference through the security pipeline.
- `read_result` retrieves bounded chunks of a captured large result.

It is not a registry, portal, server manager, or general LLM gateway.

## Why

Large MCP catalogs consume context before an agent does useful work. A
transparent proxy can enforce policy but cannot substantially reduce that
catalog. Slim Guard deliberately replaces the model-facing catalog with three
stable tools while preserving exact schemas and recoverable results behind the
middle layer.

Atlassian
[`mcp-compressor`](https://github.com/atlassian-labs/mcp-compressor) is the
primary compression competitor. Slim Guard's additional contract is guarded
execution and result delivery without requiring a proprietary control plane.

## How it works

```text
MCP client or gateway
  -> mcp-slim-guard
     -> authorized catalog
     -> find_tool / call_tool / read_result
     -> allow/deny + argument and URL preflight + rate limit
     -> upstream MCP servers
     -> bounded, recoverable result delivery
```

Visibility filtering runs before tool search. `call_tool` accepts only a
reference issued by the current catalog, so guessed or stale tool names are not
forwarded. Large results are captured once and paged from that snapshot; paging
never re-executes an upstream tool.

## Quick start

Requirements: Node.js 18 or newer.

```bash
npm install -g mcp-slim-guard

cd your-project
mcp-slim-guard init
mcp-slim-guard validate
mcp-slim-guard start
```

`init` imports MCP servers from `.mcp.json`, `mcp.json`,
`claude_desktop_config.json`, or `.cursor/mcp.json` and writes one
`mcp-slim-guard.yml` with safe defaults.

Point the host ecosystem at Slim Guard instead of the original server list.
Slim Guard uses stdio by default, so protocol stdout contains only MCP
JSON-RPC. Human status and stdout-configured audit output go to stderr.

## Security scope

The current runtime provides:

- catalog visibility allow/deny;
- exact catalog-bound invocation;
- parameter restrictions;
- URL/domain/IP preflight;
- heuristic injection checks on call arguments;
- rate limiting;
- recursively redacted JSON audit events;
- cryptographically random session and result references.

Be precise about the limits:

- URL preflight is not process or socket isolation. A sandbox, container, or
  egress proxy is required to constrain an arbitrary upstream process.
- Heuristic injection detection cannot prove content is safe.
- Streamable HTTP is experimental and binds to loopback. It should not be
  exposed remotely until authentication and the remaining HTTP hardening gates
  in the active plan are complete.

See [the architecture](docs/architecture-mcp-slim-guard.md) and
[the active iteration plan](docs/plans/2026-07-26-compatible-middle-layer.md).

## Compatibility

The normal product surface is always the fixed three tools. Existing
`compressor.level` values and legacy `mcp__*` calls remain accepted as migration
inputs, but they are not part of the primary user experience.

Slim Guard must preserve standard MCP result semantics, including `isError`,
content block types and order, `structuredContent`, `_meta`, and unknown fields
that it does not intentionally transform.

## Evidence

Do not compare only serialized initial tool lists. A valid comparison with
`mcp-compressor` includes:

- all discovery, schema, retry, invocation, and result-retrieval turns;
- cumulative task tokens;
- task success and first-valid-argument rate;
- p50/p95 latency;
- schema and result-field preservation;
- security false positives, false negatives, and leakage.

Current benchmark commands:

```bash
npm run bench
npm run bench:tokens
npm run bench:schema
npm run bench:latency
```

Public numbers will be restored only from committed, reproducible,
non-empty evidence.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

No package publish, release, or version bump is implied by changes on `main`.

## License

MIT
