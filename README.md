<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>Context compression for MCP tools</strong></p>

<p align="center">
  76.18% fewer tokens in the standard benchmark · 99.71% stress-test upper bound · reversible
</p>

Slim Guard compresses MCP Tool catalogs and oversized results before they reach
the agent. Same Tool call, fraction of the tokens.

_Standard benchmark: 71,388 → 17,007 normal-path tokens. Extreme stress test:
499,556 → 1,437 protocol tokens._

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
  <a href="#benchmark">Benchmark</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README_CN.md">中文</a>
</p>

## Measured result

![Slim Guard reduced tokens by 76.18% in the standard benchmark, with a 99.71% stress-test upper bound](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/social-preview-alpha.svg)

**Standard benchmark:** 71,388 → 17,007 normal-path tokens across 24 tasks,
76.18% fewer than direct MCP. The 24 tasks made 24 upstream calls.

**Stress-test upper bound:** 499,556 → 1,437 normal-path protocol tokens in an
intentionally extreme synthetic test with 100 Tools and one 8,000-row result.
The Tool ran once and exact full recovery matched. See the
[stress-test evidence](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-27-automatic-compression-stress.md).

|  Normal-path tokens | Tokens saved |  Estimated annual savings* | Tasks and upstream calls |
| ------------------: | -----------: | -------------------------: | -----------------------: |
| 71,388 → **17,007** |   **54,381** | **Save about $2,481/year** |        **24/24 · 24/24** |

<sub>*At 1,000 similar MCP tasks per day and $3 per million input tokens:
54,381 ÷ 24 × 1,000 × 365 ÷ 1,000,000 × $3 ≈ $2,481. This is not a measured
API bill. The deterministic fixture used no model or API calls.</sub>

```bash
npm install -g mcp-slim-guard@alpha
```

When a project connects several MCP Servers, Tool descriptions and long results
consume agent context. Slim Guard changes the delivery path. It provides
on-demand Tool discovery and compact results, with exact recovery through
`read_result`.

Slim Guard passes arguments upstream unchanged and executes each selected Tool
at most once. Compression and recovery run locally without a model.

![Slim Guard compresses MCP context](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/mcp-context-flow.svg)

## Delivery paths

| Input                                     | What the agent receives                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------- |
| Tool catalog                              | `find_tool`, `call_tool`, and `read_result` on the generic surface          |
| Eligible long text, uniform JSON, or logs | A compact result with exact recovery through `read_result`                  |
| Small, code, diff, error, or mixed result | The original result                                                         |
| Schema-bound result                       | The original `outputSchema`, `structuredContent`, `_meta`, and other fields |

With `--surface native`, Codex still sees the authorized original Tool names.
If delivery, storage, the observer, or audit fails, Slim Guard returns the
upstream result unchanged.

## Quick start

Slim Guard requires Node.js 20 or newer and an existing project-level MCP
configuration.

Install the Alpha:

```bash
npm install -g mcp-slim-guard@alpha
```

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
the [manual upstream template](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md#codex-cli)
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
[Host setup guide](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md)
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

## Run one complete call

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

## Benchmark

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
with 37,975 on the `mcp-compressor` path. The disclosed 5.07% overhead remains an
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

Slim Guard handles MCP catalogs and Tool results. It leaves provider prompts,
conversation history, source files, and unsupported result shapes unchanged.

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

## Scope

- Local stdio is the primary Alpha path.
- The Native surface is verified end to end with Codex. VS Code support remains
  a preview.
- Result references belong to one runtime generation.
- Production remote ingress and multi-tenant control planes are outside this
  Alpha.
- Security checks report findings. Slim Guard does not redact the recoverable
  original result.

## Project links

See
[contributing](https://github.com/lennney/mcp-slim-guard/blob/main/CONTRIBUTING.md),
[architecture](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md),
and the
[roadmap](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md).

## License

MIT
