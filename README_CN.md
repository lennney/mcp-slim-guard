# mcp-slim-guard

**一个入口，三个工具，默认守卫。**

mcp-slim-guard 是一个有明确主张的 MCP 兼容中间层。它连接现有 MCP
服务器，对外只暴露一个紧凑的 MCP：

- `find_tool`：搜索已授权工具并返回精确输入 schema。
- `call_tool`：通过安全管道执行 catalog 签发的工具引用。
- `read_result`：分块读取已捕获的大结果。

它不是 Registry、Portal、MCP Server 管理平台，也不是通用 LLM 网关。

## 为什么

大型 MCP 工具目录会在 Agent 开始工作前消耗大量上下文。透明代理可以执行策略，
但无法显著减少工具目录。Slim Guard 主动把模型看到的目录收敛为三个稳定工具，
同时在中间层保存精确 schema、真实路由和可恢复结果。

Atlassian
[`mcp-compressor`](https://github.com/atlassian-labs/mcp-compressor)
是主要压缩竞品。Slim Guard 在同口径压缩之外，增加受控执行与结果出口，并且不要求
用户采用专有控制面。

## 工作方式

```text
MCP 客户端或现有网关
  -> mcp-slim-guard
     -> 已授权 catalog
     -> find_tool / call_tool / read_result
     -> allow/deny + 参数与 URL 预检 + 限速
     -> 上游 MCP servers
     -> 有界、可恢复的结果交付
```

工具可见性过滤发生在搜索之前。`call_tool` 只接受当前 catalog 签发的引用，
猜测或过期的工具名不会被转发。大结果只捕获一次，后续分页读取同一个快照，
不会重复执行上游工具。首次响应只携带一份精确预览，`next_cursor` 从预览之后
继续，避免再次传输相同前缀；完整 MCP 原结果始终可以恢复。

仓库包含 baseline MCP、官方 `mcp-compressor` CLI 与 Slim Guard 的可复现完整任务
成本测试。当前四任务结果明确标记为确定性协议回放，不冒充模型选工具准确率或通用
benchmark 结论。

## 快速开始

需要 Node.js 18 或更高版本。

```bash
npm install -g mcp-slim-guard

cd your-project
mcp-slim-guard init
mcp-slim-guard validate
mcp-slim-guard start
```

`init` 会从 `.mcp.json`、`mcp.json`、`claude_desktop_config.json`、
`.cursor/mcp.json` 或 `.vscode/mcp.json` 导入 MCP Server，识别常见顶层
`mcpServers` 和 `servers` 结构，生成一份带安全默认值的
`mcp-slim-guard.yml`。

让宿主生态连接 Slim Guard，不再直接连接原始 server 列表即可。默认使用 stdio，
协议 stdout 只包含 MCP JSON-RPC；人类状态和原本配置为 stdout 的审计日志会写入
stderr。

## 上游兼容

Slim Guard 会根据每个条目自动选择标准上游传输：

- 有 `command` 就连接本地 stdio；
- 有 `url` 就先尝试 Streamable HTTP，失败后只兼容回退一次旧 HTTP+SSE；
- 只有明确的旧服务才需要写 `type: sse`。

这是同一条兼容路径，不是让用户选择传输模式。本地与远程 MCP 可以混合接入，
模型侧仍然只看到三个工具：

```yaml
servers:
  local:
    command: node
    args: ["server.js"]
  remote:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: "Bearer ${REMOTE_MCP_TOKEN}"
```

连接时会解析 `${NAME}`、`${env:NAME}` 和非敏感字段的
`${NAME:-default}`。敏感环境变量、header 和 URL query 参数必须引用运行时环境
变量，明文 fallback 会被拒绝。Slim Guard 不弹窗解析 `${input:name}` 这类宿主
交互变量，请将其改为环境变量。远程 OAuth 暂未实现。

## 安全范围

当前运行时提供：

- catalog 可见性 allow/deny；
- 精确 catalog 引用调用；
- 参数限制；
- URL、域名与 IP 预检；
- 调用参数的启发式注入检测；
- 限速；
- 递归脱敏的 JSON 审计事件；
- 加密随机的 session 与 result 引用。

需要准确理解限制：

- URL 预检不等于进程或 socket 隔离。限制任意上游进程需要 sandbox、container
  或 egress proxy。
- 启发式注入检测不能证明内容绝对安全。
- Slim Guard 自身对下游提供的 Streamable HTTP 入口仍是实验能力，只绑定
  loopback；在认证等 HTTP 加固门禁完成前，不应暴露到远端网络。这个限制与向外
  连接已有远程 MCP Server 是两回事。

参见[架构文档](docs/architecture-mcp-slim-guard.md)和
[当前迭代 Plan](docs/plans/2026-07-26-compatible-middle-layer.md)。

## 兼容性

正常产品面永远是固定三个工具。已有 `compressor.level` 配置和旧 `mcp__*` 调用仍
作为迁移兼容输入接受，但不再进入主要用户体验。

Slim Guard 必须保留标准 MCP 结果语义，包括 `isError`、content block 的类型和顺序、
`structuredContent`、`_meta`，以及没有被明确变换的未知字段。

## 证据

不能只比较初始工具列表的序列化大小。与 `mcp-compressor` 的有效对比必须包含：

- 发现、schema、重试、调用和结果恢复的全部轮次；
- 完整任务累计 Token；
- 任务成功率和首次参数正确率；
- p50/p95 延迟；
- schema 与结果字段保持率；
- 安全误报、漏报和泄露。

```bash
npm run bench
npm run bench:tokens
npm run bench:schema
npm run bench:latency
```

只有来自已提交、可复现、非空证据的数字才会恢复到公开文档。

## 开发

```bash
npm install
npm run build
npm test
npm run lint
```

`main` 上的变更不代表已发布，也不自动触发版本升级。

## License

MIT
