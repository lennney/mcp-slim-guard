# 15-30 Second Alpha Demo

This terminal demo uses a real stdio MCP fixture and the built Slim Guard CLI.
It does not use a model, network service, or API quota.

```bash
npm run demo:alpha
```

Expected sequence:

```text
1. Upstream catalog: 12 tools
2. Agent catalog: 3 tools -> find_tool, call_tool, read_result
3. Discovery: fixture_generate_report -> tool_...
4. Large result: head-tail-v1, ... chars -> capsule
5. On-demand recovery: 24000 exact chars
6. Upstream execution count: 1
PASS: Compress what agents see. Preserve what tools do.
```

## Recording script

Use one continuous terminal capture:

1. Say: “Twelve MCP tools become three stable entries.”
2. Run `npm run demo:alpha`.
3. Point to the Capsule and the exact recovery line.
4. End on “Upstream execution count: 1.”

The visual message is compression at `tools/list` and `CallToolResult`, not
different tool execution. Do not add a compression percentage overlay: the
published numbers are fixture-specific and belong on the evidence page.

## 中文口播

“Slim Guard 把十二个 MCP 工具压成三个固定入口。工具参数原样执行一次；大结果先交付
可读投影，需要时再从同一快照恢复。最后看上游计数，仍然只有一次。”
