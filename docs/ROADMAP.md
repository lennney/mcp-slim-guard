# mcp-slim-guard 路线图

> The control plane between AI agents and MCP servers.

---

## 定位

**唯一同时做「压缩」+「安全」的 MCP 代理。**

| 维度            |  我们   | mcp-compressor | mcp-slim | slim-mcp |
| --------------- | :-----: | :------------: | :------: | :------: |
| Schema 压缩     | ✅ 5 级 |    ✅ 4 级     |    ✅    | ✅ 5 级  |
| SSRF 防护       |   ✅    |       ❌       |    ❌    |    ❌    |
| 注入检测        |   ✅    |       ❌       |    ❌    |    ❌    |
| 工具白名单      |   ✅    |       ❌       |    ❌    |    ❌    |
| 审计日志        |   ✅    |       ❌       |    ❌    |    ❌    |
| Schema 统计展示 |   ✅    |       ❌       |    ❌    |    ❌    |

**一句话定位**：Reclaim ~83% of MCP tool-schema context without changing your existing servers — and verify the result yourself.

---

## 传播核心数据

```
14 MCP tools
Before: 1,736 schema tokens
After:    300 schema tokens
Saved:     83%  (light mode)

light:   ~83% savings
normal:  ~86% savings
extreme: ~72% savings
maximum: ~77% savings
```

安全层：allow/deny + SSRF + 注入检测 + 限速 + 审计。

---

## 30 天发布执行计划

### 第 1 周（7/23 — 7/30）：修可信度与转化

| #   | 任务                                              | 状态 |
| --- | ------------------------------------------------- | :--: |
| 1   | LICENSE 统一为 MIT                                |  ✅  |
| 2   | Node.js 版本 README 与 package.json 统一为 >=18   |  ✅  |
| 3   | npm description 改英文 + keywords 补齐            |  ✅  |
| 4   | package.json 添加 mcpName                         |  ✅  |
| 5   | 创建 server.json                                  |  ✅  |
| 6   | CHANGELOG 去掉 YAML frontmatter                   |  ✅  |
| 7   | 包名 micro-mcp → mcp-slim-guard                   |  ✅  |
| 8   | CLI 嵌入 schema 统计（字符数 + est. tokens）      |  ✅  |
| 9   | 创建 SECURITY.md                                  |  ✅  |
| 10  | 发布 GitHub Release v0.1.0                        |  ✅  |
| 11  | 制作 20-30 秒 demo GIF（init → validate → start） |  ⬜  |
| 12  | 更新 Glama 信息（glama.json 已推送，待手动提交）  |  🔄  |

### 第 2 周（7/31 — 8/6）：集中发布

| #   | 任务                                                                         | 状态 |
| --- | ---------------------------------------------------------------------------- | :--: |
| 1   | 官方 MCP Registry 提交（server.json 已验证，已 login）                       |  🔄  |
| 2   | Smithery 发布（MCPB）                                                        |  ⬜  |
| 3   | Glama 单独提交 mcp-slim-guard（同第 1 周 #12）                               |  🔄  |
| 4   | mcp.so 收录                                                                  |  ⬜  |
| 5   | PulseMCP 收录                                                                |  ⬜  |
| 6   | Awesome MCP Servers PR（Security / Developer Tools 分类）                    |  ⬜  |
| 7   | best-of-mcp-servers 提交                                                     |  ⬜  |
| 8   | 发布英文技术文章："Your MCP tools may consume more context than your prompt" |  ⬜  |

### 第 3 周（8/7 — 8/13）：真实用户案例

| #   | 任务                                                                | 状态 |
| --- | ------------------------------------------------------------------- | :--: |
| 1   | 找 10-20 个多 MCP 用户试用                                          |  ⬜  |
| 2   | 收集：工具数 / schema token / 压缩率 / 工具选错 / 误拦截 / 安装卡点 |  ⬜  |
| 3   | 发布 v0.2.0（基于反馈）                                             |  ⬜  |
| 4   | 发布案例文章（真实数据）                                            |  ⬜  |

### 第 4 周（8/14 — 8/20）：集成

| #   | 任务                                                           | 状态 |
| --- | -------------------------------------------------------------- | :--: |
| 1   | 向 3-5 个 MCP 客户端/管理器提交集成 PR                         |  ⬜  |
| 2   | 教程：Secure and compress Agent Search MCP with mcp-slim-guard |  ⬜  |
| 3   | 公开 Benchmark 仓库（`npx mcp-slim-guard benchmark`）          |  ⬜  |

---

## 30 天目标指标

| 指标             | agent-search-mcp | mcp-slim-guard |
| ---------------- | :--------------: | :------------: |
| 外部真实用户     |       100        |       30       |
| 成功完成首次调用 |        70        |       20       |
| GitHub Star      |       150        |      100       |
| 外部 Issue/反馈  |        10        |       10       |
| 社区目录收录     |        6         |       6        |
| 第三方教程或引用 |        3         |       3        |

---

## 社区渠道

| 优先级 | 平台                                      | 内容形式  |
| :----: | ----------------------------------------- | --------- |
|   P0   | 官方 MCP Registry                         | 元数据    |
|   P0   | Smithery                                  | MCPB 发布 |
|   P0   | Glama                                     | 目录收录  |
|   P0   | Awesome MCP Servers                       | PR        |
|   P0   | Hacker News                               | Show HN   |
|   P1   | Reddit: r/mcp, r/ClaudeCode, r/LocalLLaMA | 技术文章  |
|   P1   | best-of-mcp-servers                       | 提交      |
|   P1   | mcp.so, PulseMCP                          | 目录收录  |
|   P1   | MCP Discord                               | 发布通知  |
|   P2   | X / Bluesky                               | 社交传播  |
|   P2   | V2EX / 掘金 / Linux.do                    | 中文社区  |

---

## 不做的事

- ❌ Python / Rust SDK — TS 生态优先
- ❌ OAuth 支持 — 复杂度高，ROI 低
- ❌ 云端管理面板 — CLI-first
- ❌ 大模型下载 — 用小模型 + 按需加载
- ❌ 安装 Search 时默认依赖 mcp-slim-guard — 增加首次使用成本
- ❌ 直接发"我做了一个 MCP，欢迎 Star" — 发包含问题/实验/失败经验的技术内容

---

## 长期技术路线（发布后）

### 智能层

| 功能              | 优先级 | 说明                                |
| ----------------- | ------ | ----------------------------------- |
| 自动配置检测      | P1     | 自动发现 Claude/Cursor/Codex 配置   |
| 用法追踪 + 持久化 | P1     | SQLite 存每次请求的 token 节省      |
| 响应优化          | P2     | 自动截断数组、去 null、剥 metadata  |
| 实时仪表盘        | P2     | HTTP 端口，压缩率/缓存命中/调用统计 |

### 生态集成

| 功能            | 优先级 | 说明                           |
| --------------- | ------ | ------------------------------ |
| Hermes 深度集成 | P1     | 作为 Hermes 默认安全代理       |
| GitHub Actions  | P2     | CI 中集成安全扫描              |
| 策略模板        | P2     | Istio-style 严格/中等/宽松预设 |

---

## 推广资源分配

```
Search:  40% — 低门槛流量，让别人认识你
Guard:   60% — 建立技术品牌，技术壁垒 + 商业化空间
```

Search 负责流量入口，Guard 负责品牌深度。不强行捆绑，但提供组合教程。

---

## 竞品速查

| 竞品                       | 语言           |  压缩   | 安全 | 许可证 |
| -------------------------- | -------------- | :-----: | :--: | ------ |
| mcp-compressor (Atlassian) | Python/TS/Rust |   ✅    |  ❌  | MIT    |
| mcp-slim (dopatools)       | TS             |   ✅    |  ❌  | MIT    |
| slim-mcp (Joncik91)        | TS             |   ✅    |  ❌  | MIT    |
| Headroom (headroomlabs)    | Python         |   ✅    |  ❌  | ?      |
| **mcp-slim-guard**         | TS             | ✅ 5 级 |  ✅  | MIT    |
