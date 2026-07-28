<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>MCP 上下文压缩</strong></p>

<p align="center">
  继续调用你现有的 MCP 工具，向 Agent 发送更少 Token。<br>
  上游调用不变，原始结果可精确恢复。
</p>

<p align="center"><sub>0.1.1 Alpha · 本地 stdio · Node.js 20+</sub></p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 or newer"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#选择宿主入口">宿主入口</a> ·
  <a href="#验证数据">验证数据</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README.md">English</a>
</p>

Slim Guard 压缩现有 MCP Server 产生的工具目录和调用结果。它位于真实上游调用
之后、结果进入模型上下文之前。它不会替换工具、修改参数，也不会在恢复时再次
调用上游。

![Slim Guard 压缩 MCP 上下文](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/mcp-context-flow.svg)

## 它做什么

- **减少 MCP 上下文。** 大型工具目录变成按需发现入口；符合条件的大型结果变成
  紧凑视图。
- **保留真实工具调用。** Slim Guard 将相同参数传给上游，每次请求最多执行一次
  选定工具。
- **精确恢复原始结果。** `read_result` 读取不可变快照，不会重新执行上游。
- **在已验证宿主中保留工具身份。** Codex 可以通过 `--surface native` 发现并
  调用授权后的原始工具。
- **为其他宿主提供兼容入口。** 默认公开 `find_tool`、`call_tool` 和
  `read_result`。
- **只压缩确定安全的结果。** 小型、结构化、绑定 schema、混合、错误、源码类和
  不确定结果保持原样。
- **执行后故障保持原结果。** 交付、存储、观察或审计失败时返回精确上游结果。
- **本地确定性运行。** 压缩不调用模型或外部 API。

## 快速开始

需要：

- Node.js 20 或更高版本
- npm
- 已有的项目级 MCP 配置

预发布版本进入 npm `alpha` 渠道后，使用：

```bash
npm install -g mcp-slim-guard@alpha
```

发布前，内部测试者和 reviewer 使用绝对路径安装已验收的冻结候选：

```bash
npm install -g /absolute/path/to/mcp-slim-guard-0.1.1-alpha.1.tgz
```

该冻结候选早于本次 README 修订。npm 发布前必须重新冻结并验证发布包。

导入项目中已经配置的 MCP Server：

```bash
cd /absolute/path/to/your-project
mcp-slim-guard init
mcp-slim-guard validate
```

`init` 生成 `mcp-slim-guard.yml`。检查该文件后，将宿主原来的 MCP Server
条目替换为一个 Slim Guard 条目。不要同时暴露原始入口和 Slim Guard。

`init` 可以导入常见 JSON、Cursor 和 VS Code MCP 配置，但不能导入 Codex
TOML。只有 Codex 配置的项目必须先根据
[手工上游模板](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md#codex-cli)
创建 `mcp-slim-guard.yml`，再把 Slim Guard 加入 `.codex/config.toml`。

## 选择宿主入口

Slim Guard 不根据宿主元数据猜测入口。请显式选择。

| 入口    | 宿主可见内容                              | 适用场景                           |
| ------- | ----------------------------------------- | ---------------------------------- |
| Native  | 授权后的原始工具和 `read_result`          | 宿主保留工具发现、身份和逐工具审批 |
| Generic | `find_tool`、`call_tool` 和 `read_result` | 宿主需要通用兼容入口               |

### Codex：原始工具

在项目的 `.codex/config.toml` 中加入：

```toml
[mcp_servers.slim_guard]
command = "mcp-slim-guard"
args = ["start", "--surface", "native"]
cwd = "/absolute/path/to/your-project"
```

检查解析结果：

```bash
codex mcp list
```

Codex CLI 已经通过该入口完成模型选择的原始工具调用和多页精确恢复。

### VS Code：原始工具

在 `.vscode/mcp.json` 中加入：

```json
{
  "servers": {
    "slim-guard": {
      "type": "stdio",
      "command": "mcp-slim-guard",
      "args": ["start", "--surface", "native"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

当前证据检查了 VS Code 接口和逐工具审批模型，尚未验证 VS Code 模型选择调用。

### 通用 `mcpServers` 宿主

使用默认入口：

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

宿主应当只看到：

```text
find_tool
call_tool
read_result
```

命令定位、连接检查和配置边界见
[宿主接入指南](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md)。

## 结果如何交付

| MCP 结果                               | 交付方式                              |
| -------------------------------------- | ------------------------------------- |
| 大型纯文本                             | 头尾视图和精确快照                    |
| 统一 JSON 数组                         | 更省 Token 时转成字段只出现一次的表格 |
| 日志类文本                             | 保留错误和边界，标记重复噪声          |
| 小型、代码、diff 或不确定结果          | 原样返回                              |
| 结构化、混合、错误或绑定 schema 的结果 | 原样返回                              |

压缩只在上游 `CallToolResult` 已经产生后开始。原样路径保留 `isError`、内容顺序
和类型、`structuredContent`、`_meta`、`outputSchema` 及未知字段。

紧凑结果包含 `result_ref` 时，使用 `read_result` 分段读取快照。恢复不会执行
上游。

## 查看一次完整调用

本地演示加载 12 个上游工具，发现其中一个，捕获 73,507 字符的结果，并恢复
精确分片。上游计数保持为一。

```text
$ npm run demo:alpha

1. Upstream catalog: 12 tools
2. Agent catalog: 3 tools -> find_tool, call_tool, read_result
3. Discovery: fixture_generate_report -> tool_3b5c122fb5b6a0d...
4. Large result: head-tail-v1, 73507 chars -> capsule
5. On-demand recovery: 24000 exact chars
6. Upstream execution count: 1
PASS: Compress what agents see. Preserve what tools do.
```

![Slim Guard 调用流程](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-demo.gif)

## 验证数据

![Slim Guard 冻结 Alpha 基准](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/benchmark-alpha.svg)

| 冻结的 12 工具、24 任务 fixture | 原始 MCP | `mcp-compressor 0.31.6` | Slim Guard |
| ------------------------------- | -------: | ----------------------: | ---------: |
| 正常路径 Token                  |   71,388 |                  54,710 | **17,007** |
| Agent 可见工具                  |       12 |                       2 |      **3** |
| 完成任务                        |    24/24 |                   24/24 |  **24/24** |
| 上游调用                        |       24 |                      24 |     **24** |

在该 fixture 中，Slim Guard 正常路径比原始 MCP 少 76.18% Token，比
`mcp-compressor` 少 68.91%。23 个超大结果用例全部精确重建。

这是使用 `o200k_base` 测量的确定性协议 fixture，没有调用模型或 API。它不是
通用节省比例。

两个大型报告强制完整恢复后使用 39,899 Token，竞品路径为 37,975 Token。
已公开的 5.07% 额外开销仍是优化目标。

复现：

```bash
npm install
npm run build
npm run bench:compression:verify
```

阅读固定版本的
[基准方法](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md)、
[真实 MCP Server smoke](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-26-real-mcp-server-smoke.md)
和
[宿主采用检查点](https://github.com/lennney/mcp-slim-guard/blob/9ecade9/docs/evidence/2026-07-28-host-adoption-checkpoint.md)。

## 适用场景

以下情况适合使用 Slim Guard：

- 一个宿主加载很多 MCP 工具；
- 上游工具经常返回长报告、JSON 数组或日志；
- Agent 通常只需要紧凑结果，但必须保留精确恢复能力；
- 宿主需要保留原始工具名称和逐工具审批。

Slim Guard 不压缩模型 provider prompt、对话历史、源文件或所有结果形态。它只
处理 MCP 工具目录和工具结果。

## 安全与可观察性

- 未授权工具不会进入发现和调用路径。
- 每次调用绑定当前目录中的一个确定条目。
- 非法工具参数在执行上游前返回 `InvalidParams`。
- API key 必须使用环境变量引用；`init` 拒绝敏感字段中的明文值。
- 审计默认不记录凭证、参数、结果正文和原始 capability 引用。

跟踪一次调用：

```bash
mcp-slim-guard log --file ./mcp-slim-guard-audit.log
```

典型阶段：

```text
policy/success -> upstream/success -> projection/projected
recovery/chunk
```

## 兼容性

| 路径                  | 当前证据                             |
| --------------------- | ------------------------------------ |
| 本地 stdio 入口       | Alpha 主要路径                       |
| stdio 上游            | 支持                                 |
| Streamable HTTP 上游  | 通过共享 adapter 支持                |
| GitHub MCP Server     | 只读多 block 结果通过                |
| Filesystem MCP Server | 大型结构化结果精确恢复               |
| Everything MCP Server | 结构化结果原样通过                   |
| ContextForge          | HTTP bridge 到 Slim Guard stdio 通过 |
| Codex CLI             | 原始工具模型选择和精确恢复通过       |
| VS Code               | 已检查原生接口和审批模型             |
| 下游 Streamable HTTP  | 实验能力，仅限 loopback              |

## 当前限制

- 本次 README 修订需要在 npm 发布前重新冻结包。
- 交互式宿主审批界面尚未完整验证。
- VS Code 模型选择调用尚未验证。
- 结果引用只属于一个 runtime generation。
- 生产级远程入口、多租户控制面和相关性检索不进入本次 Alpha。
- 安全检查只报告 finding，不会改写可恢复的原始结果。

## 开发

```bash
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run demo:alpha
npm run smoke:package
```

参见
[架构](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md)、
[路线图](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md)和
[已验收的 Host-native 目标](https://github.com/lennney/mcp-slim-guard/blob/main/GOAL.md)。

## License

MIT
