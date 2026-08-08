# Host setup

Slim Guard is the only MCP server entry exposed to the host. Its project-local
`mcp-slim-guard.yml` stores upstream server definitions and security policy; a
host entry selects the mode.

## Prepare the project

```bash
cd /absolute/path/to/project
mcp-slim-guard init
mcp-slim-guard validate
```

Review `mcp-slim-guard.yml` before installing it. Keep credentials in
environment-variable references. Do not leave the same upstream servers beside
Slim Guard in the host configuration: that would create an unguarded path.

The configuration format is version `2`. It has no `compressor` section and no
host mode field.

## Choose the host mode

| Host        | Default | Supported installation modes |
| ----------- | ------- | ---------------------------- |
| Codex       | Native  | Native, Compact, Extreme     |
| Claude Code | Compact | Compact, Extreme             |

Generate a plan first:

```bash
mcp-slim-guard plan --host codex
mcp-slim-guard plan --host claude-code --mode extreme
```

`install` applies the same checked plan. Claude Code Native is rejected because
it is not a verified installation target.

## Codex

```toml
[mcp_servers.slim_guard]
command = "mcp-slim-guard"
args = ["start", "--mode", "native"]
cwd = "/absolute/path/to/project"
```

Native lists the authorized original tools with their full schemas, plus
`read_result`.

## Claude Code

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

Compact lists only `find_tool`, `call_tool`, and `read_result`. `find_tool`
returns full original schemas for up to three authorized matches. Use
`--mode extreme` when a shorter recoverable first result is appropriate.

## Verify the connection

First run Slim Guard's read-only runtime acceptance check for the selected
Host mode:

```bash
mcp-slim-guard verify --host codex
mcp-slim-guard verify --host claude-code --mode extreme
```

`verify` connects to upstream servers and checks the selected public tool
surface plus the exact on-demand schema handoff. It does not write Host
configuration and does not call an upstream business tool. It deliberately
does not test result recovery, because doing so would require a real tool call.

Then inspect the entry from the Host itself:

```bash
codex mcp list
claude mcp list
```

In Compact and Extreme, discover a tool with `find_tool`, then use the returned
`tool_ref` with `call_tool`. In Native, call the authorized original tool name.
If a response includes `result_ref`, repeatedly call `read_result` from its
replay cursor to reconstruct the exact snapshot. This never repeats the upstream
tool call.
