# mcp-slim-guard

**Context compression for MCP.**

**Compress what agents see. Preserve what tools do.**

mcp-slim-guard is an MCP context compression runtime. It sits between an MCP
host and existing MCP servers, replacing a large authorized catalog with three
stable tools:

- `find_tool` returns a small set of exact, catalog-bound tool definitions.
- `call_tool` forwards the selected arguments to the upstream tool unchanged.
- `read_result` optionally restores exact chunks from a captured large result.

Compression changes the context delivered to the agent. It does not change the
upstream tool call.

## The MCP-native compression path

```text
MCP host
  -> Catalog Projection at tools/list
     -> find_tool / call_tool / read_result
  -> exact upstream tools/call, once
  -> Payload Router after CallToolResult
     -> small result: direct
     -> large result: deterministic projection + immutable snapshot
  -> optional read_result from the snapshot
```

The fixed contracts are:

- authorization filters the catalog before discovery;
- `find_tool` preserves `inputSchema`, `outputSchema`, `title`, annotations,
  `_meta`, and extension fields;
- `call_tool` does not rewrite the upstream argument object;
- the upstream tool is invoked exactly once;
- classification, projection, validation, or storage failure returns the
  original upstream result;
- `read_result` never re-executes the upstream tool and is never required
  before the agent can make another tool call.

The Payload Router currently recognizes only plain text, uniform JSON, log-like
text, and opaque MCP results. Code, diffs, small results, and uncertain shapes
remain unchanged. Normal users do not choose algorithms, compression levels,
or chunk sizes.

## Evidence, not a universal savings claim

The frozen, quota-free benchmark runs 24 English and Chinese MCP tasks across
12 fixture tools:

| Profile               | Tasks | Upstream calls | Advertised tools | Normal-path tokens |
| --------------------- | ----: | -------------: | ---------------: | -----------------: |
| Baseline MCP          | 24/24 |             24 |               12 |             71,388 |
| mcp-compressor 0.31.6 | 24/24 |             24 |                2 |             54,710 |
| Slim Guard            | 24/24 |             24 |                3 |             18,385 |

This fixture shows a 66.40% lower normal-path cost than `mcp-compressor`; it is
not a general savings rate. Forced full recovery of the two large reports is
5.01% above the competitor path, is disclosed, and remains an optimization
target.

See the [complete-task evidence](docs/evidence/2026-07-26-complete-task-benchmark.md),
[content projection evidence](docs/evidence/2026-07-26-content-projection-compression.md),
and machine-readable captures linked from those reports.

```bash
npm run bench:compression:verify
```

The benchmark uses deterministic MCP protocol replay, not a model or API quota.

## Install the current stable release

Requirements: Node.js 18 or newer.

```bash
npm install -g mcp-slim-guard

cd your-project
mcp-slim-guard init
mcp-slim-guard validate
mcp-slim-guard start
```

`init` imports common `mcpServers` and VS Code `servers` configurations and
writes one `mcp-slim-guard.yml`. Point the host at Slim Guard instead of the
original server list.

Local stdio is the primary supported ingress. Slim Guard can connect outward to
stdio and Streamable HTTP upstreams through one internal adapter. Its own
downstream Streamable HTTP ingress remains experimental and loopback-only.

## Alpha status

`0.1.1-alpha.1` is the planned first public preview; it has not been published
by the changes in this repository. When release authorization is given, the
same verified tarball will be published with:

```bash
npm install -g mcp-slim-guard@alpha
```

The npm `latest` tag remains on `0.1.0`. A second Alpha is reserved for P0
install, protocol, or result-loss failures.

## Compatibility boundary

The three virtual tools intentionally replace original model-facing tool
identities. Hosts therefore cannot always retain per-upstream-tool permission
labels or prompts. Alpha prioritizes compact context and exact execution over
dynamic host-native tool promotion.

Existing legacy compression configuration remains accepted for migration but
is not the primary product experience. Registry, marketplace, dashboard,
Kubernetes operator, hosted control plane, remote-model compression, and
user-selectable compression presets are not part of the product.

Security checks remain supporting protection: catalog policy, exact references,
URL/argument preflight, rate limits, redacted audit data, and result findings.
They are not the main positioning, and an untrusted string is never treated as
safely isolated merely because text was deleted.

See the [architecture](docs/architecture-mcp-slim-guard.md),
[roadmap](docs/ROADMAP.md), and
[Alpha execution plan](docs/plans/2026-07-26-alpha-market-entry.md).

## Development

```bash
npm install
npm run build
npm test
npm run bench:compression:verify
npm run demo:alpha
npm run smoke:package
```

No version bump, push, tag, npm publish, GitHub Release, Registry update, or
external post is implied by repository changes.

## License

MIT
