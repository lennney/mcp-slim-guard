<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>Cut MCP context before it reaches the agent.</strong></p>

<p align="center">
  <strong>76.18% fewer tokens</strong> in a frozen 12-Tool, 24-task fixture ·
  same upstream call · exact recovery
</p>

Slim Guard reduces Tool catalogs on the Generic surface and eligible oversized
results on both surfaces. The Host receives less context. Slim Guard forwards
selected arguments unchanged and executes the upstream Tool at most once.

| Token reduction | Tokens removed | Tasks completed | Upstream calls |
| --------------: | -------------: | --------------: | -------------: |
|      **76.18%** |     **54,381** |       **24/24** |         **24** |

<p align="center"><sub>0.1.1 Alpha candidate · local stdio · Node.js 20+</sub></p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 or newer"></a>
</p>

<p align="center">
  <a href="#get-started-7-commands">Install</a> ·
  <a href="#proof">Proof</a> ·
  <a href="#host-compatibility-matrix">Hosts</a> ·
  <a href="#try-slim-guard-and-contribute">Contribute</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md">Docs</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README_CN.md">中文</a>
</p>

![Slim Guard runtime demo: 12 MCP Tools become three Generic entries, one large result becomes a compact projection, and exact recovery keeps the upstream count at one](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-demo.gif)

<p align="center"><sub>Generic runtime demo: 12 Tools → 3 entries · 73,507 characters → compact projection · exact recovery · 1 upstream execution</sub></p>

## What it does

- **Cuts catalog context.** The Generic surface exposes `find_tool`,
  `call_tool`, and `read_result`. The Native surface preserves authorized
  original Tool names.
- **Cuts eligible result context.** Slim Guard routes long text, uniform JSON,
  and logs through local deterministic projectors.
- **Keeps exact recovery.** Every lossy delivery stores one immutable snapshot.
  `read_result` reads it without executing upstream again.
- **Makes trials reversible.** `analyze`, `plan`, `install`, `profile`, and
  `rollback` cover the trial from assessment to restoration.

## How it works (30 seconds)

![Slim Guard calls an authorized Tool at most once, delivers a compact result, and recovers the exact snapshot without another upstream execution](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/mcp-context-flow-v2.svg)

- **Catalog projection** reduces the Tool definitions loaded by the Generic
  surface.
- **Payload routing** reduces only result shapes with a safe local strategy.
- **Result capsules** preserve the original result content for bounded
  recovery.
- **Fail-open delivery** returns the exact upstream result when projection,
  storage, observation, or audit fails.

## Get started (7 commands)

> The self-service candidate passed independent acceptance. Publication to the
> npm `alpha` tag still requires a separate release action.

After the `alpha` tag is published:

```bash
npm install -g mcp-slim-guard@alpha
cd /absolute/path/to/your-project

# 1. Measure the current catalog. No writes and no Tool calls.
mcp-slim-guard analyze

# 2-3. Import upstream Servers and validate the Guard configuration.
mcp-slim-guard init
mcp-slim-guard validate

# 4. Preview the exact Host change. No writes.
mcp-slim-guard plan --host codex

# 5. Back up, write, and validate one Host configuration change.
mcp-slim-guard install --host codex --json

# 6. After normal Host calls, inspect local delivery evidence.
mcp-slim-guard profile --last

# 7. Restore the exact pre-install Host configuration.
mcp-slim-guard rollback --host codex --json
```

Use `--host claude-code` for Claude Code. A Codex-only project with no supported
JSON MCP configuration must first create `mcp-slim-guard.yml` from the
[upstream template](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md#codex-cli).

`install` creates a pre-write backup. `rollback` refuses to overwrite edits
made after installation.

## Proof

### Frozen standard fixture

![Slim Guard frozen benchmark: 76.18% fewer normal-path tokens, from 71,388 to 17,007, with 24 tasks and 24 upstream calls](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/benchmark-alpha-v2.svg)

| Path       | Normal-path tokens | Tasks | Upstream calls |
| ---------- | -----------------: | ----: | -------------: |
| Direct MCP |             71,388 | 24/24 |             24 |
| Slim Guard |         **17,007** | 24/24 |         **24** |

The fixture uses 12 deterministic Tools and 24 English and Chinese protocol
tasks. It counts tokens with `o200k_base` and makes no model or API calls. All
23 oversized projection cases reconstructed exactly.

The 76.18% reduction applies to this fixture. It does not measure model answer
quality, provider caching, or billing.

Reproduce it:

```bash
npm install
npm run build
npm run bench:compression:verify
```

Read the
[benchmark method](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md)
and
[real MCP Server smoke](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-real-mcp-server-smoke.md).

### Stress-test upper bound

An intentionally extreme fixture with 100 synthetic Tools and one 8,000-row
result reduced normal-path protocol tokens from 499,556 to 1,437. The Tool ran
once and exact full recovery matched.

The 99.71% result is a stress-test upper bound. See the
[stress-test evidence](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-27-automatic-compression-stress.md).

## What gets reduced

| MCP content                                    | Slim Guard delivery                                   |
| ---------------------------------------------- | ----------------------------------------------------- |
| Authorized Tool catalog                        | Three Generic entries, or original names on Native    |
| Eligible long text                             | Head and tail view plus an exact snapshot             |
| Eligible uniform JSON array                    | Field-once table when it is smaller                   |
| Eligible log-like text                         | Errors and boundaries retained; repeated noise marked |
| Small, code, diff, or uncertain data           | Original result                                       |
| Structured, mixed, error, or schema-bound data | Original result                                       |

Projection starts after the upstream `CallToolResult` exists. Pass-through
preserves `isError`, content order and types, `structuredContent`, `_meta`,
`outputSchema`, and unknown fields.

## Host compatibility matrix

| Host        | Alpha status | Surface                            | Configuration        |
| ----------- | ------------ | ---------------------------------- | -------------------- |
| Codex       | Supported    | Native preferred; Generic fallback | `.codex/config.toml` |
| Claude Code | Supported    | Generic                            | `.mcp.json`          |
| VS Code     | Preview only | Native configuration preview       | `.vscode/mcp.json`   |
| OpenCode    | Post-Alpha   | Not released                       | N/A                  |

The accepted candidate exercised Codex and Claude Code installation and exact
rollback through the public CLI. It also exercised packaged Generic and Native
runtime paths, recovery, protocol stdout, and audit privacy.

## Try Slim Guard and contribute

Contributions and real-world compatibility reports are welcome. Use Slim Guard
with a Host and MCP Server you rely on, then share the exact versions,
transport, result shape, and recovery outcome.

- Found a reproducible problem? Open a
  [bug report](https://github.com/lennney/mcp-slim-guard/issues/new?template=bug-report.md).
- Tested a new Host and Server combination? Submit a
  [compatibility report](https://github.com/lennney/mcp-slim-guard/issues/new?template=compatibility-report.yml).
- Need a focused behavior change? Open a
  [feature request](https://github.com/lennney/mcp-slim-guard/issues/new?template=feature-request.md)
  or send a pull request.

Documentation fixes, result-shape fixtures, and Host compatibility tests are
useful first contributions. Read the
[contribution guide](https://github.com/lennney/mcp-slim-guard/blob/main/CONTRIBUTING.md)
before you start.

## When to use · When to skip

**Use Slim Guard when you:**

- load many MCP Tools into one Host;
- receive long reports, JSON arrays, or logs;
- need compact first delivery with exact recovery;
- want a local trial that can restore the earlier Host configuration.

**Skip Slim Guard when you:**

- use only a few small Tool definitions and short results;
- require compression of conversation history, provider prompts, or source
  files;
- require durable cross-session recovery;
- require a production remote HTTP service or hosted control plane.

<details>
<summary><b>Delivery and recovery contract</b></summary>

- Slim Guard binds every call to one exact current catalog entry.
- Selected arguments pass upstream unchanged.
- A selected upstream Tool executes at most once.
- Lossy delivery stores one immutable snapshot before returning `result_ref`.
- `read_result` reads the snapshot without executing upstream.
- Alpha recovery references belong to the current runtime generation.

</details>

<details>
<summary><b>Safety and failure behavior</b></summary>

- Unauthorized Tools stay out of discovery, schema, and call paths.
- Delivery, storage, observer, or audit failure returns the exact upstream
  result.
- Stdio stdout contains MCP protocol data only.
- Audit records exclude credentials, arguments, result bodies, and raw
  capability references by default.
- Installation creates a pre-write backup.
- Rollback refuses later-edit conflicts.

</details>

## Project links

- [Host setup](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md)
- [Architecture](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md)
- [Roadmap](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md)
- [Contributing](https://github.com/lennney/mcp-slim-guard/blob/main/CONTRIBUTING.md)
- [Support](https://github.com/lennney/mcp-slim-guard/blob/main/SUPPORT.md)
- [Security policy](https://github.com/lennney/mcp-slim-guard/blob/main/SECURITY.md)

## License

[MIT](https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE)
