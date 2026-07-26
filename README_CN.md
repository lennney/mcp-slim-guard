# mcp-slim-guard

**MCP 上下文压缩运行时。**

**压缩 Agent 看到的内容，保留工具真实执行。**

mcp-slim-guard 位于 MCP 宿主与现有 MCP Server 之间，把大型授权工具目录收口为三个固定入口：

- `find_tool`：返回少量完整、可调用的工具定义；
- `call_tool`：把参数原样交给上游工具；
- `read_result`：按需从已捕获的大结果快照恢复原文。

压缩发生在 MCP 上下文交付层，不改变上游工具调用。上游调用只执行一次；
分类、投影、校验或存储异常时直接返回原始结果；`read_result` 不是继续调用其他工具的前置条件。

## 产品路径

```text
宿主 tools/list
  -> 三工具 Catalog Projection
  -> find_tool
  -> call_tool 参数原样进入上游，执行一次
  -> CallToolResult 返回后自动路由
     -> 小结果直接返回
     -> 大结果生成确定性投影并保存不可变快照
  -> 需要时 read_result，无需重跑上游
```

当前 Payload Router 只识别普通文本、统一 JSON、日志和不透明 MCP 结果。
代码、diff、小结果和无法确定的复杂结果保持原样。用户不需要选择算法、压缩档位或分片大小。

## 可复现证据

冻结基准使用 12 个工具和 24 个中英文确定性 MCP 任务，不调用模型：

| 路径                  | 任务成功 | 上游调用 | Agent 可见工具 | 正常路径 Token |
| --------------------- | -------: | -------: | -------------: | -------------: |
| 原始 MCP              |    24/24 |       24 |             12 |         71,388 |
| mcp-compressor 0.31.6 |    24/24 |       24 |              2 |         54,710 |
| Slim Guard            |    24/24 |       24 |              3 |         18,385 |

在这组冻结 fixture 中，Slim Guard 正常路径比 `mcp-compressor` 少 66.40%；
这不是通用节省率。两个完整大报告强制恢复时仍有 5.01% 额外开销，已公开披露并列为后续优化项。

```bash
npm run bench:compression:verify
```

详细证据见[完整任务报告](docs/evidence/2026-07-26-complete-task-benchmark.md)与
[内容投影报告](docs/evidence/2026-07-26-content-projection-compression.md)。

## 安装当前稳定版

需要 Node.js 18 或更高版本。

```bash
npm install -g mcp-slim-guard

cd your-project
mcp-slim-guard init
mcp-slim-guard validate
mcp-slim-guard start
```

本地 stdio 是当前主要发布路径。向上游连接时支持 stdio 和 Streamable HTTP；
Slim Guard 自身的下游 HTTP 入口仍是仅绑定 loopback 的实验能力。

## Alpha 状态

首个公开预览计划使用 `0.1.1-alpha.1`，但本次仓库变更没有发布它。
得到独立发布授权后，将用已验证的同一 tarball 发布到 npm `alpha`：

```bash
npm install -g mcp-slim-guard@alpha
```

`latest` 继续保持 `0.1.0`。只有安装失败、协议损坏或结果丢失等 P0 问题才考虑 `alpha.2`。

## 边界

固定三工具会替代原始工具在模型侧的身份，因此部分宿主无法继续显示每个原始工具的独立权限标签。
Alpha 优先保证上下文压缩、参数原样调用、结果可恢复与上游恰好执行一次；动态工具提升留到未来。

本产品不做大型 Gateway 控制面、Registry、Marketplace、Dashboard、Kubernetes
Operator、托管多租户平台、用户自选压缩参数或默认依赖远程模型的语义压缩。

参见[架构](docs/architecture-mcp-slim-guard.md)、[路线图](docs/ROADMAP.md)和
[Alpha 执行计划](docs/plans/2026-07-26-alpha-market-entry.md)。

## 开发

```bash
npm install
npm run build
npm test
npm run demo:alpha
npm run smoke:package
```

仓库变更不代表已经 bump 版本、push、tag、publish、创建 Release 或发布外部文章。

## License

MIT
