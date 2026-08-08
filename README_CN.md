# MCP Slim Guard

MCP Slim Guard 为 Host 提供一条受控的路径来访问已授权的上游工具。它保留原始
输入 schema，在调用上游前校验参数，并能在不重复执行上游调用的前提下精确恢复超大结果。

## 选择模式

| 模式    | Host 看到的工具                                                                    | 适用场景                                       |
| ------- | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| Native  | 已授权的原始工具名和完整 schema，外加 `read_result`                                | 能良好处理普通 MCP 工具目录的 Host，包括 Codex |
| Compact | `find_tool`、`call_tool`、`read_result`；发现结果携带每个匹配工具的完整原始 schema | 需要小而稳定入口面的 Host                      |
| Extreme | 与 Compact 相同的工具面和 schema；仅对足够大的结果提供更短、可恢复的首次交付       | 首次结果大小特别重要的 Host                    |

`start` 默认使用 Compact。Codex 的安装计划默认使用 Native。Claude Code 的安装
计划默认使用 Compact，可选 Extreme；不提供 Native 安装计划。

三种模式共享同一套 allow/deny 授权。Compact 和 Extreme 最多返回三个匹配项，每个
匹配项都包含原始的必填字段、枚举和嵌套 schema。调用会先按原始 schema 校验，再联系上游。

## 快速开始

```bash
npm install -g mcp-slim-guard@0.2.0-alpha.1
cd /path/to/project-with-mcp-config
mcp-slim-guard init
mcp-slim-guard validate

# 默认启动 Compact。
mcp-slim-guard start
```

`init` 会生成版本为 `2` 的 `mcp-slim-guard.yml`。该文件只保存上游和安全设置；
模式由 Host 启动命令选择，不写入 YAML。

```bash
# 只查看 Host 安装计划，不改动 Host 文件。
mcp-slim-guard plan --host codex
mcp-slim-guard plan --host claude-code --mode extreme

# 只读验证已配置的运行时；不会改动 Host 配置，也不会调用业务工具。
mcp-slim-guard verify --host codex

# 在审阅后执行安装。
mcp-slim-guard install --host codex --mode native
```

## Host 配置

Codex 中需要正常的已授权 MCP 工具目录时，使用 Native：

```toml
[mcp_servers.slim_guard]
command = "mcp-slim-guard"
args = ["start", "--mode", "native"]
cwd = "/absolute/path/to/project"
```

Claude Code 默认使用 Compact：

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

完整配置和验证步骤见 [Host 配置](docs/host-setup.md)。

## 配置文件

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

版本 1 配置会明确报错，不提供自动迁移。已移除的 `compressor` 配置块同样会被拒绝。

## 修复无效调用

如果参数不符合已授权工具的原始 schema，Slim Guard 会返回带
`structuredContent` 的标准 MCP 工具错误。错误会说明 schema 校验原因，并确认
没有调用上游工具；它不会回显提交的参数值。修正参数后可直接重试。

## 结果恢复

需要可恢复交付的响应会带有 `result_ref`。使用 `read_result` 的 `query` 可定位最多三个
本地片段；省略 `query` 并沿用 `next_cursor` 可精确恢复完整快照。两条路径都基于同一不可变
快照，且不会再次调用上游工具。不要同时传入 `query` 和 `cursor`。Native 和 Compact 使用
标准交付边界。Extreme 使用更小的边界，但只有首次交付至少比精确结果小一半时才会使用；
否则原样直通精确结果。

## 证据与检查

仓库保留了 24-task 的模式对比、结果恢复 fixture，以及 100-tool / 8,000-row 压力
fixture。运行当前产物：

```bash
npm run build
npm run bench:task
npm run bench:compression
npm run bench:stress
npm run bench:compression:verify
```

报告按模式生成。旧 Alpha 基准数字不应被视为这条产品线的宣传依据。

## 开发

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm run verify:package-boundary
npm run smoke:package
```

这是 Alpha 软件。将它用于高权限工具前，请审阅授权规则和上游配置。
