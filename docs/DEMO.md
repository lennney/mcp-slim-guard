# mcp-slim-guard Demo

5 分钟体验：安装 → 初始化 → 验证 → 启动 → 对接 Claude Code。

## 前置条件

- Node.js ≥ 18
- 至少一个 MCP Server（本 demo 用 `@agent-mcp-tools/agent-search-mcp` 举例）

## Step 1: 安装

```bash
npm install -g @agent-mcp-tools/mcp-slim-guard
```

验证安装：

```bash
mcp-slim-guard --version
# → 0.1.0
```

## Step 2: 初始化

`init` 命令自动发现你已有的 MCP 配置，生成 `mcp-slim-guard.yml`：

```bash
mcp-slim-guard init
```

它会扫描以下位置：

- Claude Code: `~/.claude/claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`
- Codex: `~/.config/opencode/opencode.jsonc`

输出示例：

```
🔍 Found 2 MCP servers: github, playwright
📝 Config written to ./mcp-slim-guard.yml

Next steps:
  mcp-slim-guard validate   # dry-run check
  mcp-slim-guard start      # start proxy
```

如果不想自动发现，也可以手动写 `mcp-slim-guard.yml`：

```yaml
version: 1

tools:
  allow:
    - "*"
  deny:
    - "*_delete_*"
    - "*_drop_*"

ssrf:
  mode: block
  block_private_ips: true

rate_limit:
  default: "100/min"

injection_detection:
  enabled: true
  sensitivity: medium

servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}"
```

## Step 3: 验证

dry-run 检查配置是否正确，能连上上游服务器：

```bash
mcp-slim-guard validate
```

输出示例：

```
🔍 Validating mcp-slim-guard config...

  github:
    ✅ search_repositories — allowed
    ✅ create_issue — allowed
    ❌ delete_repository — denied (matches *_delete_*)
    ✅ list_issues — allowed

📊 4 tools: 3 allowed, 1 blocked
📊 Compression: normal (est. 86% token savings)
```

## Step 4: 启动

```bash
mcp-slim-guard start
```

输出示例：

```
🛡️ mcp-slim-guard started
   Audit log: stdout
   Compressor: normal (estimated 86% token savings)
   2 servers, 14 tools (248 est. tokens, 86% saved)

📊 MCP tool schema:
  Tools: 14 total
    ├─ Full schema:  0
    ├─ Slim schema:  12
    └─ Wrapper:      2

  Characters: 6,942 → 992 (86% reduction)
  Est. tokens: ~1,736 → ~248 (86% reduction)

   Send SIGHUP to reload config (kill -HUP <pid>)
```

## Step 5: 对接 Claude Code / Cursor / OpenCode

### Claude Code

在 `~/.claude/claude_desktop_config.json` 中，把原来的 MCP Server 配置改为指向 mcp-slim-guard：

```json
{
  "mcpServers": {
    "mcp-slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start"],
      "cwd": "/path/to/your/mcp-slim-guard.yml/directory"
    }
  }
}
```

⚠️ 注意：原来的 `github`、`playwright` 等配置要**删除**，因为 mcp-slim-guard 内部已经接管了它们。

### Cursor

在 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "mcp-slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start"],
      "cwd": "/path/to/config"
    }
  }
}
```

### OpenCode (Codex)

在 `~/.config/opencode/opencode.jsonc`：

```jsonc
{
  "mcp": {
    "mcp-slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start"],
      "cwd": "/path/to/config",
    },
  },
}
```

## 验证效果

重启 Claude Code / Cursor 后，问 AI：

> "What tools do you have available?"

AI 会看到 mcp-slim-guard 暴露的工具列表。如果开启了压缩（默认 `normal`），AI 看到的是 slim schema（只有名字和描述），需要时通过 `mcp__get_schema` 按需获取完整 schema。

## 压缩级别选择

| 级别      | 节省 | 适合场景                         |
| --------- | :--: | -------------------------------- |
| `off`     |  0%  | 不压缩，透传所有工具             |
| `light`   | ~83% | 3 个 wrapper，工具少时推荐       |
| `normal`  | ~86% | 2 个 wrapper，**默认推荐**       |
| `extreme` | ~72% | 直接压缩 schema，无 wrapper      |
| `maximum` | ~77% | 最激进压缩，inputSchema 拆到最小 |

```bash
# 切换压缩级别
mcp-slim-guard start --compressor light
mcp-slim-guard start --compressor extreme
mcp-slim-guard start --compressor off
```

## 下一步

- 启用审计日志：`audit output: file` → `mcp-slim-guard log --tail`
- 启用缓存：`cache enabled: true`
- 热重载配置：`kill -HUP <pid>`
- 查看详细文档：[README.md](../README.md)
