<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>Context compression for MCP</strong></p>

<p align="center">
  Keep using your MCP Tools. Send fewer tokens to the agent.<br>
  Same upstream call. Exact result recoverable.
</p>

<p align="center"><sub>0.1.1 Alpha · local stdio · Node.js 20+</sub></p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 or newer"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#choose-a-host-surface">Host surfaces</a> ·
  <a href="#proof">Proof</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/README_CN.md">中文</a>
</p>

Slim Guard compresses the catalogs and results produced by your existing MCP
Servers. It runs after the real upstream Tool call and before the result enters
the model context. It does not replace the Tool, change its arguments, or call
it again during recovery.

![Slim Guard compresses MCP context](https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/mcp-context-flow.svg)

## What it does

- **Cuts MCP context.** Large Tool catalogs become an on-demand discovery
  surface. Eligible large results become compact views.
- **Keeps the real Tool call.** Slim Guard sends the same arguments upstream
  and executes the selected Tool at most once.
- **Recovers the exact result.** `read_result` reads one immutable snapshot. It
  never repeats the upstream call.
- **Keeps native Tool identity** for verified Hosts. Codex can discover and
  call authorized original Tools through `--surface native`.
- **Provides a generic fallback** for other Hosts through `find_tool`,
  `call_tool`, and `read_result`.
- **Compresses only eligible results.** Small, structured, schema-bound, mixed,
  error, source-like, and uncertain results pass through.
- **Fails open after execution.** Delivery, storage, observer, or audit failure
  returns the exact upstream result.
- **Runs locally and deterministically.** Compression does not require a model
  or an external API.

## Quick start

Requirements:

- Node.js 20 or newer
- npm
- an existing project-level MCP configuration

After the prerelease reaches the npm `alpha` channel, install it with:

```bash
npm install -g mcp-slim-guard@alpha
```

Before publication, internal testers and reviewers install the accepted frozen
candidate by absolute path:

```bash
npm install -g /absolute/path/to/mcp-slim-guard-0.1.1-alpha.1.tgz
```

That accepted tarball predates this README revision. The release package must
be frozen and verified again before npm publication.

Import the MCP Servers already configured in your project:

```bash
cd /absolute/path/to/your-project
mcp-slim-guard init
mcp-slim-guard validate
```

`init` creates `mcp-slim-guard.yml`. Review it, then replace the Host's original
MCP Server entries with one Slim Guard entry. Do not expose both paths.

`init` imports common JSON, Cursor, and VS Code MCP configurations. It does not
import Codex TOML. A Codex-only project must create `mcp-slim-guard.yml` from
the [manual upstream template](https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/host-setup.md#codex-cli)
before it adds the Slim Guard Server to `.codex/config.toml`.

## Choose a Host surface

Slim Guard does not guess from Host metadata. Select the surface explicitly.

| Surface | Host sees                                    | Use it when                                                        |
| ------- | -------------------------------------------- | ------------------------------------------------------------------ |
| Native  | Authorized original Tools plus `read_result` | The Host preserves Tool discovery, identity, and per-Tool approval |
| Generic | `find_tool`, `call_tool`, and `read_result`  | The Host needs the compatibility fallback                          |

### Codex: native Tools

Add this project-scoped Server to `.codex/config.toml`:

```toml
[mcp_servers.slim_guard]
command = "mcp-slim-guard"
args = ["start", "--surface", "native"]
cwd = "/absolute/path/to/your-project"
```

Check the parsed configuration:

```bash
codex mcp list
```

Codex CLI has completed a model-selected original-Tool call and exact
multi-page recovery through this surface.

### VS Code: native Tools

Add this Server to `.vscode/mcp.json`:

```json
{
  "servers": {
    "slim-guard": {
      "type": "stdio",
      "command": "mcp-slim-guard",
      "args": ["start", "--surface", "native"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

The VS Code Interface and its per-Tool approval model have been inspected. A
VS Code model-selected call has not been verified.

### Generic `mcpServers` Hosts

Use the default surface:

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

The Host should list exactly:

```text
find_tool
call_tool
read_result
```

See the
[Host setup guide](https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/host-setup.md)
for command lookup, verification, and configuration boundaries.

## How result delivery works

| MCP result                                       | Delivery                                              |
| ------------------------------------------------ | ----------------------------------------------------- |
| Large plain text                                 | Head and tail view plus an exact snapshot             |
| Uniform JSON array                               | Field-once table when it is smaller                   |
| Log-like text                                    | Errors and boundaries retained; repeated noise marked |
| Small, code, diff, or uncertain result           | Returned unchanged                                    |
| Structured, mixed, error, or schema-bound result | Returned unchanged                                    |

Compression starts only after the upstream `CallToolResult` exists. Slim Guard
preserves `isError`, content order and types, `structuredContent`, `_meta`,
`outputSchema`, and unknown fields on pass-through paths.

When a compact result includes a `result_ref`, call `read_result` to retrieve
the snapshot in bounded chunks. Recovery does not execute upstream.

## See one complete call

The local demo loads 12 upstream Tools, discovers one Tool, captures a
73,507-character result, and recovers an exact chunk. The upstream counter
stays at one.

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

![Slim Guard call flow](https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/slim-guard-demo.gif)

## Proof

![Slim Guard frozen Alpha benchmark](https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/benchmark-alpha.svg)

| Frozen 12-Tool, 24-task fixture | Direct MCP | `mcp-compressor 0.31.6` | Slim Guard |
| ------------------------------- | ---------: | ----------------------: | ---------: |
| Normal-path tokens              |     71,388 |                  54,710 | **17,007** |
| Agent-facing Tools              |         12 |                       2 |      **3** |
| Tasks completed                 |      24/24 |                   24/24 |  **24/24** |
| Upstream calls                  |         24 |                      24 |     **24** |

Slim Guard used 76.18% fewer normal-path tokens than direct MCP and 68.91%
fewer than `mcp-compressor` in this fixture. All 23 oversized result cases
reconstructed exactly.

This is a deterministic protocol fixture measured with `o200k_base`. It uses no
model or API calls. It is not a universal savings claim.

Forced full recovery of the two large reports used 39,899 tokens, compared
with 37,975 on the competitor path. The disclosed 5.07% overhead remains an
optimization target.

Reproduce the fixture:

```bash
npm install
npm run build
npm run bench:compression:verify
```

Read the
[benchmark method](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md),
[real MCP Server smoke](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-26-real-mcp-server-smoke.md),
and
[Host adoption checkpoint](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-28-host-adoption-checkpoint.md).

## When it helps

Use Slim Guard when:

- one Host loads many MCP Tools;
- upstream Tools return long reports, JSON arrays, or logs;
- the Agent usually needs a compact answer but must retain exact recovery;
- the Host should keep original Tool names and per-Tool approval controls.

Slim Guard does not compress provider prompts, conversation history, source
files, or every result shape. It is an MCP catalog and Tool-result layer.

## Safety and observability

- Unauthorized Tools stay out of discovery and call paths.
- Each call binds to one current catalog entry.
- Invalid imported Tool arguments return `InvalidParams` before upstream
  execution.
- API keys must use environment-variable references. `init` rejects plaintext
  values in sensitive fields.
- Audit records exclude credentials, arguments, result bodies, and raw
  capability references by default.

Trace one call:

```bash
mcp-slim-guard log --file ./mcp-slim-guard-audit.log
```

Typical stages:

```text
policy/success -> upstream/success -> projection/projected
recovery/chunk
```

## Compatibility

| Path                       | Current evidence                                     |
| -------------------------- | ---------------------------------------------------- |
| Local stdio ingress        | Primary Alpha path                                   |
| stdio upstream             | Supported                                            |
| Streamable HTTP upstream   | Supported through the shared adapter                 |
| GitHub MCP Server          | Read-only multi-block result passed                  |
| Filesystem MCP Server      | Large structured result recovered exactly            |
| Everything MCP Server      | Structured result passed through                     |
| ContextForge               | HTTP bridge to Slim Guard stdio passed               |
| Codex CLI                  | Native model-selected call and exact recovery passed |
| VS Code                    | Native Interface and approval model inspected        |
| Downstream Streamable HTTP | Experimental and loopback-only                       |

## Current limits

- This README revision requires a new package freeze before npm publication.
- Interactive Host approval presentation is not fully verified.
- A VS Code model-selected call is not verified.
- Result references belong to one runtime generation.
- Production remote ingress, multi-tenant control planes, and relevance
  retrieval are outside this Alpha.
- Security checks report findings. Slim Guard does not redact the recoverable
  original result.

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

See the
[architecture](https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/architecture-mcp-slim-guard.md),
[roadmap](https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/ROADMAP.md),
and
[accepted Host-native goal](https://github.com/lennney/mcp-slim-guard/blob/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/GOAL.md).

## License

MIT
