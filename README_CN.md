<p align="center">
  <img src="https://raw.githubusercontent.com/lennney/mcp-slim-guard/5141b7c78c7d5a8c21151fcc5d17a1af209b87a0/docs/assets/slim-guard-lockup.svg" alt="MCP Slim Guard" width="640">
</p>

<p align="center"><strong>在 MCP 上下文进入 Agent 前压缩它。</strong></p>

<p align="center">
  <strong>标准基准中少发 76% MCP Token</strong><br>
  <strong>合成压力测试中最高减少 99.7%</strong><br>
  上游调用不变 · 原始结果可精确恢复
</p>

MCP Slim Guard 在 Generic 入口缩减工具目录，并在两个入口缩减适合压缩的大型
结果。宿主收到更少的上下文。MCP Slim Guard 原样转发被选中工具的参数，上游
工具最多执行一次。

| Token 减少 | 少发 Token |  完成任务 | 上游调用 |
| ---------: | ---------: | --------: | -------: |
| **76.18%** | **54,381** | **24/24** |   **24** |

<p align="center"><sub>0.1.1 Alpha · 本地 stdio · Node.js 20+</sub></p>

<p align="center">
  <a href="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml"><img src="https://github.com/lennney/mcp-slim-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/mcp-slim-guard"><img src="https://img.shields.io/npm/v/mcp-slim-guard.svg?label=npm" alt="npm"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-ff5a1f.svg" alt="MIT license"></a>
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/package.json"><img src="https://img.shields.io/badge/node-%3E%3D20-282b2d.svg" alt="Node.js 20 或更高版本"></a>
</p>

<p align="center">
  <a href="#7-条命令开始试用">安装</a> ·
  <a href="#验证数据">验证</a> ·
  <a href="#宿主兼容矩阵">宿主</a> ·
  <a href="#试用与参与贡献">贡献</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md">文档</a> ·
  <a href="https://github.com/lennney/mcp-slim-guard/blob/main/README.md">English</a>
</p>

![Slim Guard 运行演示：12 个 MCP 工具变成三个 Generic 入口，大型结果变成紧凑投影，精确恢复后上游计数仍为一](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/slim-guard-demo.gif)

<p align="center"><sub>Generic 运行演示：12 个工具 → 3 个入口 · 73,507 字符 → 紧凑投影 · 精确恢复 · 上游执行 1 次</sub></p>

## 它做什么

- **减少目录上下文。** Generic 入口暴露 `find_tool`、`call_tool` 和
  `read_result`；Native 入口保留已授权的原始工具名。
- **减少适合压缩的结果上下文。** Slim Guard 用本地确定性投影器处理长文本、
  统一 JSON 和日志。
- **保留精确恢复。** 每次有损交付保存一份不可变快照。`read_result` 读取快照，
  不再次执行上游。
- **让试用可逆。** `analyze`、`plan`、`install`、`profile` 和 `rollback`
  覆盖从评估到恢复的完整试用流程。

## 30 秒看懂工作方式

![Slim Guard 最多执行一次已授权工具，交付紧凑结果，并在不再次执行上游的情况下精确读取快照](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/mcp-context-flow-cn-v2.svg)

- **目录投影**减少 Generic 入口加载的工具定义。
- **Payload Router**只压缩存在安全本地策略的结果形态。
- **Result Capsule**保存原始内容，支持有边界的精确读取。
- **Fail-open 交付**在投影、存储、观察或审计失败时返回准确的上游结果。

## 7 条命令开始试用

从 npm `alpha` 渠道安装 Alpha：

```bash
npm install -g mcp-slim-guard@alpha
cd /absolute/path/to/your-project

# 1. 测量当前目录，不写文件，也不调用工具。
mcp-slim-guard analyze

# 2-3. 导入上游 Server，并验证 Guard 配置。
mcp-slim-guard init
mcp-slim-guard validate

# 4. 预览准确的宿主变更，不写文件。
mcp-slim-guard plan --host codex

# 5. 备份、写入并验证一次宿主配置变更。
mcp-slim-guard install --host codex --json

# 6. 宿主正常调用后，检查本地交付证据。
mcp-slim-guard profile --last

# 7. 恢复安装前的准确宿主配置。
mcp-slim-guard rollback --host codex --json
```

Claude Code 使用 `--host claude-code`。如果 Codex 项目没有可导入的 JSON MCP
配置，需要先根据
[上游模板](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md#codex-cli)
创建 `mcp-slim-guard.yml`。

`install` 在写入前创建备份。如果用户在安装后修改了目标文件，`rollback` 会
拒绝覆盖。

## 验证数据

### 冻结的标准基准

![Slim Guard 冻结基准：正常路径 Token 减少 76.18%，从 71,388 降至 17,007，24 项任务对应 24 次上游调用](https://raw.githubusercontent.com/lennney/mcp-slim-guard/main/docs/assets/benchmark-alpha-cn-v2.svg)

| 路径       | 正常路径 Token |  任务 | 上游调用 |
| ---------- | -------------: | ----: | -------: |
| Direct MCP |         71,388 | 24/24 |       24 |
| Slim Guard |     **17,007** | 24/24 |   **24** |

该 fixture 使用 12 个确定性工具和 24 项中英文协议任务，通过 `o200k_base`
计数，不调用模型或 API。23 个超大投影用例均完成精确重建。

76.18% 只描述这组 fixture，不测量模型回答质量、供应商缓存或账单。

复现：

```bash
npm install
npm run build
npm run bench:compression:verify
```

查看
[基准方法](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-alpha-benchmark-bilingual.md)
和
[真实 MCP Server smoke](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-26-real-mcp-server-smoke.md)。

### 压力测试上界

在包含 100 个合成工具和一份 8,000 行结果的极端 fixture 中，正常路径协议
Token 从 499,556 降到 1,437。上游工具执行一次，完整恢复精确匹配。

99.71% 是压力测试上界。查看
[压力测试证据](https://github.com/lennney/mcp-slim-guard/blob/main/docs/evidence/2026-07-27-automatic-compression-stress.md)。

## 哪些内容会减少

| MCP 内容                               | Slim Guard 交付                          |
| -------------------------------------- | ---------------------------------------- |
| 已授权的工具目录                       | 三个 Generic 入口；Native 保留原始工具名 |
| 适合压缩的大型纯文本                   | 头尾视图和一份精确快照                   |
| 适合压缩的统一 JSON 数组               | 更短时使用字段只出现一次的表格           |
| 适合压缩的日志                         | 保留错误和边界，标记重复噪声             |
| 小型、代码、diff 或不确定数据          | 原始结果                                 |
| 结构化、混合、错误或绑定 schema 的数据 | 原始结果                                 |

投影只在上游 `CallToolResult` 已经产生后开始。原样路径保留 `isError`、内容顺序
和类型、`structuredContent`、`_meta`、`outputSchema` 及未知字段。

## 宿主兼容矩阵

| 宿主        | Alpha 状态 | 入口                      | 配置                 |
| ----------- | ---------- | ------------------------- | -------------------- |
| Codex       | 支持       | Native 优先；Generic 回退 | `.codex/config.toml` |
| Claude Code | 支持       | Generic                   | `.mcp.json`          |
| VS Code     | 仅配置预览 | Native 配置预览           | `.vscode/mcp.json`   |
| OpenCode    | Alpha 后   | 尚未发布                  | 不适用               |

发布门禁覆盖通过公共 CLI 安装 Codex 和 Claude Code 配置并精确回滚，也覆盖
打包后的 Generic/Native 运行路径、恢复、协议 stdout 和审计隐私。最终 Tag
对应的包必须在发布前通过这些检查。

## 试用与参与贡献

欢迎提交贡献和真实兼容性报告。请把 Slim Guard 接到你正在使用的 Host 和 MCP
Server，并记录准确版本、传输方式、结果形态和恢复结果。

- 遇到可复现问题，请提交
  [Bug 报告](https://github.com/lennney/mcp-slim-guard/issues/new?template=bug-report.md)。
- 验证了新的 Host 与 Server 组合，请提交
  [兼容性报告](https://github.com/lennney/mcp-slim-guard/issues/new?template=compatibility-report.yml)。
- 希望增加一个聚焦的行为，请提交
  [功能建议](https://github.com/lennney/mcp-slim-guard/issues/new?template=feature-request.md)
  或直接发起 Pull Request。

文档修正、结果形态 fixture 和 Host 兼容性测试都适合作为第一次贡献。开始前请阅读
[贡献指南](https://github.com/lennney/mcp-slim-guard/blob/main/CONTRIBUTING.md)。

## 适合使用 · 适合跳过

**以下情况适合使用 Slim Guard：**

- 一个宿主加载很多 MCP 工具；
- 上游经常返回长报告、JSON 数组或日志；
- 首次交付需要紧凑，同时必须能精确恢复；
- 希望本地试用后能恢复原来的宿主配置。

**以下情况适合跳过 Slim Guard：**

- 只有少量短工具定义和短结果；
- 需要压缩对话历史、供应商 prompt 或源文件；
- 需要跨会话持久恢复；
- 需要正式远程 HTTP 服务或托管控制平面。

<details>
<summary><b>交付与恢复合同</b></summary>

- 每次调用绑定当前目录中的一个准确条目。
- 被选中工具的参数原样传给上游。
- 被选中的上游工具最多执行一次。
- 有损交付先保存一份不可变快照，再返回 `result_ref`。
- `read_result` 读取快照，不执行上游工具。
- Alpha 的恢复引用只属于当前运行时世代。

</details>

<details>
<summary><b>安全与失败行为</b></summary>

- 未授权工具不会进入发现、schema 和调用路径。
- 交付、存储、观察器或审计失败时返回准确的上游结果。
- stdio stdout 只包含 MCP 协议数据。
- 审计默认不记录凭证、参数、结果正文和原始 capability 引用。
- 安装会先创建备份。
- 回滚拒绝覆盖安装后的用户修改。

</details>

## 项目链接

- [宿主接入](https://github.com/lennney/mcp-slim-guard/blob/main/docs/host-setup.md)
- [架构](https://github.com/lennney/mcp-slim-guard/blob/main/docs/architecture-mcp-slim-guard.md)
- [路线图](https://github.com/lennney/mcp-slim-guard/blob/main/docs/ROADMAP.md)
- [参与贡献](https://github.com/lennney/mcp-slim-guard/blob/main/CONTRIBUTING.md)
- [支持](https://github.com/lennney/mcp-slim-guard/blob/main/SUPPORT.md)
- [安全策略](https://github.com/lennney/mcp-slim-guard/blob/main/SECURITY.md)

## License

[MIT](https://github.com/lennney/mcp-slim-guard/blob/main/LICENSE)
