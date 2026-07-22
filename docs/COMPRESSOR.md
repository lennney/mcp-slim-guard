# micro-mcp — Schema Compressor

Lossless schema compression that reduces MCP tool context from thousands of tokens to hundreds. Two modes: wrapper tools (low levels) and schema transformation (high levels).

## Quick Start

```bash
# Enable compression during init
micro-mcp init --compressor light

# Or edit micro-mcp.yml directly
compressor:
  enabled: true
  level: light
```

## Compression Levels

### Level Progression

| Level | Mode | Wrapper Tools | Tools/list Output | Token Savings |
|-------|------|---------------|-------------------|---------------|
| **`off`** | passthrough | 0 | Full tools with complete schemas | 0% |
| **`light`** | wrapper | 3 (`list_tools` + `get_tool_schema` + `invoke_tool`) | 3 wrapper tools | ~40-50% |
| **`normal`** | wrapper | 2 (`get_tool_schema` + `invoke_tool`) | 2 wrapper tools | ~60-70% |
| **`extreme`** | transform | 0 | Real tools, stripped descriptions | ~50-70% |
| **`maximum`** | transform | 0 | Real tools, minimal schema + TS signatures | ~70-85% |

### `off`
Passthrough mode. All tools returned with complete `inputSchema`. Identical to `enabled: false`.

### `light` (recommended for most use cases)
3 wrapper tools. Agent discovers tools via `mcp__list_tools`, fetches schemas with `mcp__get_tool_schema`, and invokes via `mcp__invoke_tool`. Security pipeline runs on the inner tool call.

### `normal` (formerly `tight`)
2 wrapper tools. No discovery — agent must already know tool names. Use when you want to hide the full tool list from the agent. `tight` is accepted as an alias but logs a deprecation warning.

### `extreme`
Schema transformation mode. Tools keep their real identities — the agent calls `github_search_repositories` directly. Property descriptions are stripped from `inputSchema`; only `type`, `required`, `enum`, and `default` are preserved. Tool descriptions remain intact.

### `maximum`
Schema transformation mode. `inputSchema` is replaced with a minimal `{type: "object", properties: {}}`. Function signatures are embedded in tool descriptions as TypeScript-style annotations:

```
"Search for repositories. search_repositories(query: string, page?: number, per_page?: number)"
```

The agent calls tools directly by name. When arguments are wrong, the upstream server returns an error and the agent retries with corrected parameters.

## Security Pipeline

All 5 levels run the full security pipeline (SSRF protection, injection detection, whitelist, rate limiting). At extreme/maximum levels, the pipeline sees real tool names (e.g., `github_search_repositories`) instead of `mcp__invoke_tool`, which makes whitelist patterns like `allow: ["github_*"]` match naturally.

## Configuration

```yaml
# micro-mcp.yml
compressor:
  enabled: true
  level: light  # off | light | normal | extreme | maximum
```

## Comparison with Competitors

| Feature | micro-mcp | slim-mcp | mcp-compressor |
|---------|-----------|----------|----------------|
| Levels | 5 (off/light/normal/extreme/maximum) | 5 (none/standard/aggressive/extreme/maximum) | 4 (low/medium/high/max) |
| Approach | Hybrid (wrapper + transform) | Schema transformation | Tool surface reduction |
| Security | ✅ SSRF + injection + whitelist + rate limit | ❌ | ❌ |
| Max reduction | ~85% | ~77% | ~97% |
| Accuracy | TBD | 100% (120 API calls) | N/A |
