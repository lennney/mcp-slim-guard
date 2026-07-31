# Three Real MCP Servers

Date: 2026-07-26  
Status: Passed on the recorded Windows host

An MCP TypeScript SDK client connected to Slim Guard over stdio and completed
one real upstream Tool call against each recorded Server.

| Server | Result shape | Observed delivery |
| ------ | ------------ | ----------------- |
| GitHub MCP Server `1.7.0` | Large multi-block result with text and an embedded resource | Snapshot recovery preserved the resource block |
| `@modelcontextprotocol/server-filesystem@2026.7.10` | Large UTF-8 text plus `structuredContent` | Exact text and position markers recovered |
| `@modelcontextprotocol/server-everything@2026.7.4` | Small text plus a structured weather object | Passed through unchanged with its output contract |

## Recorded assertions

- The Generic surface exposed exactly `find_tool`, `call_tool`, and
  `read_result`.
- Three `call_tool` operations caused exactly three upstream calls.
- `read_result` recovered stored snapshots without another upstream call.
- Mixed and structured MCP content preserved its required fields.
- The GitHub Server was limited to a read-only public-file operation.
- Credentials and result bodies were not written to the public evidence.

These are compatibility observations from one recorded environment. They do
not establish universal Host or Server support, production latency, model
Tool-selection accuracy, or a general Token-reduction rate.

The reproducible smoke harness remains available as:

```bash
npm run smoke:real-servers
```

It requires the external Server binaries and credentials described by the
command's local preflight output.

