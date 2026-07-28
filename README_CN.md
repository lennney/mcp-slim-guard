<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-lockup.svg" alt="Slim Guard" width="640">
</p>

<p align="center"><strong>MCP 上下文压缩层</strong></p>

<p align="center">
  在工具目录和大型结果进入 Agent 前压缩。<br>
  上游调用保持不变，原始结果可以精确恢复。
</p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 or newer"></a>
</p>

<p align="center">
  <a href="#安装-alpha">安装</a> ·
  <a href="#数据证明">数据证明</a> ·
  <a href="#兼容性">兼容性</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md">架构</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README.md">English</a>
</p>

![Slim Guard 冻结 Alpha 基准图](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/benchmark-alpha.svg)

<p align="center"><sub>
冻结的 12 工具、24 个中英文 MCP 协议任务。使用 <code>o200k_base</code> 计数，
不调用模型或 API。这是 fixture 内结果，不代表通用节省率。
</sub></p>

## 安装 Alpha

需要 Node.js 20 或更高版本。

安装已发布的预览版：

```bash
npm install -g mcp-slim-guard@alpha
```

发布前，请使用绝对路径安装已验收的 tarball：

```bash
npm install -g /absolute/path/to/mcp-slim-guard-0.1.1-alpha.1.tgz
```

然后初始化并校验配置：

```bash
cd your-project
mcp-slim-guard init
mcp-slim-guard validate
```

`init` 会导入项目已有的 MCP Server 配置，并生成
`mcp-slim-guard.yml`。随后把宿主中的原始 Server 列表替换为一个 Slim Guard
入口：

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

宿主通过 stdio 启动 Slim Guard，Agent 只看到：

```text
find_tool
call_tool
read_result
```

已验证支持原生 MCP Tool 发现的宿主可以保留原始 Tool 身份：

```json
{
  "mcpServers": {
    "slim-guard": {
      "command": "mcp-slim-guard",
      "args": ["start", "--surface", "native"],
      "cwd": "/absolute/path/to/your-project"
    }
  }
}
```

该入口公开授权后的原始 Tool 和 `read_result`。省略 `--surface native` 时，
Slim Guard 保持 `find_tool`、`call_tool`、`read_result` 三工具兼容入口。

API key 必须使用环境变量。`init` 会拒绝敏感配置字段中的明文值。Codex、VS Code
及常见 `mcpServers` 宿主的配置见
[宿主接入配方](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md)。

## 一次完整调用

仓库 Demo 从 12 个上游工具开始，发现其中一个工具，捕获 73,507 字符结果，再
精确恢复一个分片。上游计数保持为一次。

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

## 压缩范围

压缩由运行时自动完成。正常产品路径不提供“普通/极端”档位、算法菜单或分片大小选项。

| MCP 上下文                      | Slim Guard 交付                   |
| ------------------------------- | --------------------------------- |
| 大型授权工具目录                | 三个 Agent 入口，按需发现工具     |
| 大段普通文本                    | 头尾投影和精确快照                |
| 统一 JSON 数组                  | 仅在 Token 更少时使用字段名复用表 |
| 日志                            | 保留错误和边界，明确标记重复噪声  |
| 小结果、代码、diff 或不确定内容 | 原样返回                          |
| 复杂 MCP 结果                   | 保存完整 JSON 快照和所有字段      |

压缩从上游结果返回后开始，不会改变目标工具或调用参数。

`read_result` 读取已捕获的快照，不会再次调用上游。Agent 无需完整恢复当前结果
也可以继续调用其他工具。

## 数据证明

| 冻结协议 fixture | 原始 MCP | `mcp-compressor 0.31.6` | Slim Guard |
| ---------------- | -------: | ----------------------: | ---------: |
| 正常路径 Token   |   71,388 |                  54,710 | **17,007** |
| Agent 可见工具   |       12 |                       2 |      **3** |
| 完成任务         |    24/24 |                   24/24 |  **24/24** |
| 上游调用         |       24 |                      24 |     **24** |

在这组 fixture 中，Slim Guard 正常路径比原始 MCP 少 76.18%，比
`mcp-compressor` 少 68.91%。23 个大型结果都能精确重建。

两个大报告强制完整恢复后，Slim Guard 使用 39,899 Token，竞品路径使用
37,975 Token。5.07% 的额外开销已公开，并保留为优化目标。

### 压力上限，不是默认宣传口径

在一个刻意放大的合成 fixture 中，100 个 Tool 返回 8,000 行结果。同一套自动
Alpha 路径使用 1,437 个模型可见正常路径 Token，原始 MCP 为 499,556；上游
只调用一次，首个投影包含完成标记，69 次 `read_result` 后精确恢复一致。这是
压力测试结果，不是用户可以普遍期待的节省率。

无需模型额度即可复现：

```bash
npm install
npm run build
npm run bench:compression:verify
```

查看
[基准方法和 capture](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md)、
[自动压缩压力证据](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-27-automatic-compression-stress.md)及
[三类真实 Server 证据](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-real-mcp-server-smoke.md)。

## 执行契约

```text
MCP 宿主
  |
  | tools/list
  v
Slim Guard 目录投影 -> find_tool / call_tool / read_result
  |
  | 使用精确引用和原始参数调用 call_tool
  v
上游 MCP Server，只执行一次
  |
  | CallToolResult
  v
小结果或不确定结果 -> 原样返回
大型结果           -> 投影 + 精确快照
```

Slim Guard 保留：

- 与当前目录绑定的上游路由和原始参数对象；
- 每次 `call_tool` 对应一次上游执行；
- content block 类型与顺序、`isError`、`structuredContent`、`_meta`
  和未知字段；
- 无需重跑上游的精确恢复；
- 分类、投影、校验、存储或单结果 Capsule 容量检查失败时的原始结果。

## 追踪一次调用

每次模型侧工具调用都会获得一个不透明的 `traceId`。审计流按实际发生的阶段记录：

```text
policy/success -> upstream/success -> projection/projected
recovery/chunk
```

上游 MCP 返回错误时记录为 `upstream/upstream_error`，不会冒充策略拦截。投影交付
失败但已返回精确上游结果时，记录为 `projection/fail_open`。

```bash
mcp-slim-guard log --file ./mcp-slim-guard-audit.log
```

审计条目不写入结果正文，也不保留原始 `tool_ref` / `result_ref`。运维元数据仅包含
有界字段，例如内容类型、投影策略、字符数、恢复 cursor，以及是否调用过上游。
runtime warning 只打印错误类型，不打印完整 Error 对象，避免 stderr 绕过这条边界。

同一条审计流还记录 runtime 生命周期：`starting`、`ready`（或
`ready_degraded`）、`reloading`、`stopping` 和 `stopped`。reload 会先连接
候选上游，并等待已经接收的工具调用正常完成后再切换；stdio 断开、`SIGINT` 和
`SIGTERM` 复用同一条清理路径。

## 兼容性

| 路径                  | 当前证据                                      |
| --------------------- | --------------------------------------------- |
| 本地 stdio 入口       | Alpha 主要路径                                |
| stdio 上游            | 支持                                          |
| Streamable HTTP 上游  | 通过统一 Adapter 支持                         |
| GitHub MCP Server     | 只读 `text` + `resource` 多 block 调用通过    |
| Filesystem MCP Server | 大型结构化文本精确恢复                        |
| Everything MCP Server | 小型 `structuredContent` 原样透传             |
| ContextForge          | 真实 HTTP bridge 到 Slim Guard stdio 调用通过 |
| Codex CLI             | 原生 Tool 模型选择、调用和精确恢复通过        |
| VS Code               | 原生入口和逐 Tool 审批模型检查通过            |
| 下游 Streamable HTTP  | 实验能力，仅 loopback                         |

Codex 证据包含一次模型选择调用和一次精确快照恢复。VS Code 证据覆盖本地入口和
审批模型，不包含 VS Code 模型调用。具体边界见
[宿主采用检查点](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-28-host-adoption-checkpoint.md)。

## 当前边界

Slim Guard 适合一次加载很多工具，或经常返回长报告、JSON 和日志的 MCP
工作流。本地确定性压缩无需另一个模型，并在同一连接中保留恢复路径。

默认 Alpha 入口使用三个固定 Tool。已验证的宿主可以通过
`start --surface native` 公开授权后的原始 Tool 和 `read_result`，保留逐 Tool
身份与审批控制。生产级远程入口、多租户控制面和相关性恢复不进入本次发布。

安全能力提供检查和审计 finding。Slim Guard 不会自动修改可恢复的原始结果。

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

参见[路线图](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md)、
[架构](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md)和
[Alpha 计划](https://github.com/lennney/mcp-slim-guard/blob/main/docs/plans/2026-07-26-alpha-market-entry.md)。

## License

MIT
