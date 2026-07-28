<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>Context compression for MCP</strong></p>

<p align="center">
  Cut tool catalogs and large results before they reach the agent.<br>
  Keep the upstream call. Recover the exact result.
</p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 or newer"></a>
</p>

<p align="center">
  <a href="#install-the-alpha">Install</a> ·
  <a href="#proof">Proof</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md">Architecture</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README_CN.md">中文</a>
</p>

![Slim Guard frozen Alpha benchmark](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/benchmark-alpha.svg)

<p align="center"><sub>
Frozen 12-tool, 24-task bilingual MCP protocol fixture. <code>o200k_base</code>.
No model or API calls. The result is fixture-bound, not a universal savings rate.
</sub></p>

## Install the Alpha

Node.js 20 or newer is required.

```bash
npm install -g mcp-slim-guard@alpha

cd your-project
mcp-slim-guard init
mcp-slim-guard validate
```

`init` imports the MCP servers already configured in the project and creates
`mcp-slim-guard.yml`. Replace the host's original server list with one Slim
Guard entry:

```json
{
  "mcpServers": {
    "slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start"],
      "cwd": "/absolute/path/to/your-project"
    }
  }
}
```

The host starts Slim Guard over stdio and sees:

```text
find_tool
call_tool
read_result
```

Hosts with verified native MCP Tool discovery can select the original-Tool
surface:

```json
{
  "mcpServers": {
    "slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start", "--surface", "native"],
      "cwd": "/absolute/path/to/your-project"
    }
  }
}
```

This surface exposes authorized original Tools plus `read_result`. Omitting
`--surface native` keeps the three-tool generic fallback.

Keep API keys in environment variables. `init` rejects plaintext values in
sensitive configuration fields. See the
[host setup recipes](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md) for Codex, VS Code, and common
`mcpServers` hosts.

## One complete call through Slim Guard

The repository demo starts with 12 upstream tools, discovers one, captures a
73,507-character result, and recovers an exact chunk. The upstream counter stays
at one.

```text
$ npm run demo:alpha

1. Upstream catalog: 12 tools
2. Agent catalog: 3 tools -> find_tool, call_tool, read_result
3. Discovery: fixture_generate_report -> tool_3b5c122fb5b6a0d...
4. Large result: head-tail-v1, 73507 chars -> capsule
5. On-demand recovery: 24000 exact chars
6. Upstream execution count: 1
PASS: Compress what agents see. Preserve what tools do.
```

![Slim Guard call flow](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-demo.gif)

## What gets compressed

Compression is automatic. There is no normal/extreme selector, algorithm menu,
or chunk-size control in the product path.

| MCP context                            | Slim Guard delivery                                   |
| -------------------------------------- | ----------------------------------------------------- |
| Large authorized tool catalog          | Three model-facing tools with on-demand discovery     |
| Large plain text                       | Head and tail projection plus exact snapshot          |
| Uniform JSON array                     | Field-once table when it costs fewer tokens           |
| Log-like output                        | Errors and boundaries retained; repeated noise marked |
| Small, code, diff, or uncertain result | Returned unchanged                                    |
| Complex MCP result                     | Exact JSON snapshot preserving every field and block  |

Compression starts after the upstream result returns. It does not change the
selected tool or its arguments.

`read_result` retrieves the captured snapshot. It does not call the upstream
server again, and an agent can continue calling tools without reading the full
result.

## Proof

| Frozen protocol fixture | Direct MCP | `mcp-compressor 0.31.6` | Slim Guard |
| ----------------------- | ---------: | ----------------------: | ---------: |
| Normal-path tokens      |     71,388 |                  54,710 | **17,007** |
| Agent-facing tools      |         12 |                       2 |      **3** |
| Tasks completed         |      24/24 |                   24/24 |  **24/24** |
| Upstream calls          |         24 |                      24 |     **24** |

Slim Guard used 76.18% fewer normal-path tokens than direct MCP and 68.91%
fewer than `mcp-compressor` in this fixture. All 23 oversized result cases
reconstructed exactly.

Forced full recovery of the two large reports cost 39,899 tokens, compared
with 37,975 on the competitor path. The disclosed 5.07% overhead remains an
optimization target.

### Stress ceiling, not the default claim

In an intentionally extreme synthetic fixture with 100 Tools and an 8,000-row
result, the same automatic Alpha path used 1,437 model-facing normal-path
tokens versus 499,556 for direct MCP. The Tool ran once, the completion marker
was visible in the first projection, and exact recovery matched after 69
`read_result` calls. This is a stress result, not an expected savings rate.

Reproduce the evidence without a model quota:

```bash
npm install
npm run build
npm run bench:compression:verify
```

Read the
[benchmark method and captures](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md),
the
[automatic stress-fixture evidence](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-27-automatic-compression-stress.md),
and the
[three-server compatibility capture](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-real-mcp-server-smoke.md).

## Execution contract

```text
MCP host
  |
  | tools/list
  v
Slim Guard catalog projection -> find_tool / call_tool / read_result
  |
  | call_tool with the selected reference and unchanged arguments
  v
Upstream MCP server, executed once
  |
  | CallToolResult
  v
small or uncertain -> unchanged
large              -> projection + exact snapshot
```

Slim Guard preserves:

- the catalog-bound upstream route and argument object;
- one upstream execution per `call_tool`;
- content block types and order, `isError`, `structuredContent`, `_meta`, and
  unknown result fields;
- exact recovery without upstream re-execution;
- the original result when classification, projection, validation, storage,
  or the per-result Capsule capacity check fails.

## Trace one call

Every model-facing tool call receives one opaque `traceId`. The audit stream
then records the stages that actually ran:

```text
policy/success -> upstream/success -> projection/projected
recovery/chunk
```

An upstream MCP error is recorded as `upstream/upstream_error`, not as a policy
block. Delivery failures are recorded as `projection/fail_open` when the exact
upstream result is returned.

```bash
mcp-slim-guard log --file ./mcp-slim-guard-audit.log
```

Audit entries do not include result bodies or raw `tool_ref` / `result_ref`
values. Operational metadata includes bounded fields such as content kind,
projection strategy, character counts, recovery cursor, and whether the
upstream was invoked. Runtime warnings print error types instead of complete
Error objects, so stderr does not bypass this boundary.

The same stream records runtime lifecycle states: `starting`, `ready` (or
`ready_degraded`), `reloading`, `stopping`, and `stopped`. Reload connects the
candidate upstream set and waits for admitted tool calls to finish before
swapping it in; those calls continue normally. Stdio disconnect, `SIGINT`, and
`SIGTERM` share one cleanup path.

## Compatibility

| Path                       | Current evidence                                      |
| -------------------------- | ----------------------------------------------------- |
| Local stdio ingress        | Primary Alpha path                                    |
| stdio upstream             | Supported                                             |
| Streamable HTTP upstream   | Supported through the shared upstream adapter         |
| GitHub MCP Server          | Read-only multi-block `text` + `resource` call passed |
| Filesystem MCP Server      | Large structured text result recovered exactly        |
| Everything MCP Server      | Small `structuredContent` result passed through       |
| ContextForge               | Real HTTP bridge to Slim Guard stdio call passed      |
| Codex CLI                  | Native model-selected call and recovery passed        |
| VS Code                    | Native Interface inspection passed                    |
| Downstream Streamable HTTP | Experimental and loopback-only                        |

Codex evidence includes a model-selected call and exact snapshot recovery. VS
Code evidence covers the local Host Interface and approval model, not a model
call. The
[adoption checkpoint](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-28-host-adoption-checkpoint.md)
records the exact claim boundaries.

## Current boundary

Slim Guard fits hosts that load many tools or receive long reports, JSON, and
logs. Local deterministic compression avoids another model call and keeps
result recovery under the same MCP connection.

The default Alpha surface replaces original model-facing Tool identities with
three stable entries. Verified Hosts can opt into authorized original Tools
plus `read_result` with `start --surface native`, retaining their per-Tool
identity and approval controls. Production remote ingress, multi-tenant control
planes, and relevance retrieval remain outside this release.

Security provides supporting checks and audit findings. Slim Guard does not
automatically redact the recoverable result.

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run demo:alpha
npm run smoke:package
```

See the [roadmap](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md),
[architecture](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md),
and [Alpha plan](https://github.com/lennney/mcp-slim-guard/blob/main/docs/plans/2026-07-26-alpha-market-entry.md).

## License

MIT
