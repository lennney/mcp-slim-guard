# MCP Slim Guard

MCP Slim Guard gives a host one deliberate way to reach authorized upstream
tools. It keeps input schemas intact, validates calls before the upstream is
invoked, and can recover an oversized result exactly without repeating that
invocation.

## Choose a mode

| Mode    | What the host sees                                                                                                 | Best fit                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Native  | Authorized original tool names and full schemas, plus `read_result`                                                | Hosts that work well with a normal MCP catalog, including Codex  |
| Compact | `find_tool`, `call_tool`, and `read_result`; discovery returns each match's full original schema                   | A small, predictable host surface                                |
| Extreme | The Compact tool surface and schemas; only sufficiently large results receive a shorter recoverable first delivery | Context-sensitive hosts where a smaller first result is valuable |

Compact is the default for `start`. Native is the default installation plan for
Codex. Compact is the default for Claude Code; Claude Code supports Compact and
Extreme installation plans, not Native.

All modes apply the same allow/deny authorization. Compact and Extreme return at
most three discovery matches, each with the original required fields, enums, and
nested schema. A call is validated against that original schema before the
upstream server is contacted.

## Quick start

```bash
npm install -g mcp-slim-guard@0.2.0-alpha.1
cd /path/to/project-with-mcp-config
mcp-slim-guard init
mcp-slim-guard validate

# Run the default Compact mode.
mcp-slim-guard start
```

`init` writes `mcp-slim-guard.yml` with version `2`. The file contains upstream
and security settings only. Select a mode in the host command, not in YAML.

```bash
# Inspect a host-specific plan without changing host files.
mcp-slim-guard plan --host codex
mcp-slim-guard plan --host claude-code --mode extreme

# Verify the configured runtime without changing Host configuration or calling a business Tool.
mcp-slim-guard verify --host codex

# Apply a reviewed plan.
mcp-slim-guard install --host codex --mode native
```

## Host entries

For Codex, use Native when you want the normal authorized MCP catalog:

```toml
[mcp_servers.slim_guard]
command = "mcp-slim-guard"
args = ["start", "--mode", "native"]
cwd = "/absolute/path/to/project"
```

For Claude Code, use Compact by default:

```json
{
  "mcpServers": {
    "slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start", "--mode", "compact"],
      "cwd": "/absolute/path/to/project"
    }
  }
}
```

See [host setup](docs/host-setup.md) for the full configuration and verification
steps.

## Configuration

```yaml
version: 2
tools:
  allow:
    - "upstream_*"
  deny:
    - "*_delete_*"
ssrf:
  mode: block
  block_private_ips: true
  allow_domains: []
  block_domains: []
rate_limit:
  default: "60/min"
injection_detection:
  enabled: true
  sensitivity: medium
  mode: block
audit:
  output: file
  filePath: mcp-slim-guard-audit.log
servers:
  upstream:
    command: npx
    args: ["-y", "@your/mcp-server"]
```

Version 1 configuration is intentionally unsupported. The removed `compressor`
section is rejected rather than migrated automatically.

## Repair an invalid call

If arguments do not match an authorized tool's original schema, Slim Guard
returns a normal MCP tool error with `structuredContent` that identifies the
schema failure and confirms that the upstream tool was not invoked. Correct the
arguments and retry; submitted argument values are not echoed in that error.

## Result recovery

When a response needs recoverable delivery, the first response includes a
`result_ref`. Use `read_result` with `query` to locate up to three bounded local
fragments, or omit `query` and follow `next_cursor` to recover the exact snapshot.
Both paths use the same immutable capture and never invoke the upstream tool again.
Do not combine `query` with `cursor`. Native and Compact use the standard delivery
boundary. Extreme uses a smaller boundary only when the initial delivered response
is at least half the size of the exact response; otherwise it passes the exact
response through unchanged.

## Evidence and checks

The repository includes a 24-task mode comparison, result-recovery fixtures,
and a 100-tool / 8,000-row stress fixture. Run the current artifacts with:

```bash
npm run build
npm run bench:task
npm run bench:compression
npm run bench:stress
npm run bench:compression:verify
```

Their reports are mode-specific and are generated locally; do not treat older
alpha benchmark figures as claims for this product line.

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run verify:package-boundary
npm run smoke:package
```

This project is an alpha. Review authorization patterns and upstream settings
before using it with privileged tools.
