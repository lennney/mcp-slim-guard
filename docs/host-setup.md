# Host setup

Slim Guard becomes the only MCP Server entry exposed to the host. Its
`mcp-slim-guard.yml` keeps the upstream Server definitions.

## Prepare the project

Run these commands from the project that contains the existing `.mcp.json`,
`mcp.json`, `.cursor/mcp.json`, or `.vscode/mcp.json`:

```bash
npm install -g mcp-slim-guard@alpha
cd /absolute/path/to/your-project
mcp-slim-guard init
mcp-slim-guard validate
```

`init` writes `mcp-slim-guard.yml`. Review that file before replacing the
host configuration. Sensitive fields must use environment-variable references.

Do not leave the imported upstream Servers beside Slim Guard in the host
configuration. The host would expose both paths and defeat catalog compression.

## Common `mcpServers` hosts

Use this entry for hosts that accept the common JSON shape:

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

The `cwd` must contain `mcp-slim-guard.yml`.

## VS Code

Add one Server to `.vscode/mcp.json`:

```json
{
  "servers": {
    "slim-guard": {
      "type": "stdio",
      "command": "mcp-slim-guard",
      "args": ["start"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

The repository has verified isolated `--add-mcp` configuration acceptance.
The current evidence does not claim a model-selected VS Code call.

## Codex CLI

Add one project-scoped Server to `.codex/config.toml`:

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

The `--surface native` argument makes Codex discover authorized original Tools
plus `read_result`. Omit the argument to keep the generic
`find_tool`/`call_tool`/`read_result` surface.

The repository has verified isolated Codex configuration acceptance with the
explicit native argument. The current evidence does not claim a model-selected
Codex call.

## Verify the connection

On the generic surface, the host should list exactly:

```text
find_tool
call_tool
read_result
```

Use `find_tool` to discover an imported upstream tool, then pass its
catalog-bound `tool_ref` to `call_tool`. A large result may include a
`result_ref`; `read_result` retrieves the captured snapshot without another
upstream execution.

On the native surface, the host should list the authorized original Tools plus
`read_result`. It must not list `find_tool`, `call_tool`, unauthorized Tools, or
ambiguous aliases.

## Command lookup

If a desktop host cannot find the global command, provide the absolute path
reported by:

```powershell
Get-Command mcp-slim-guard | Select-Object -ExpandProperty Source
```

or:

```bash
command -v mcp-slim-guard
```

Do not place API keys in the host JSON, the generated YAML, screenshots, or
compatibility reports.
