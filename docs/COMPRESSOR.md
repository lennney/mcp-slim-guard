# mcp-guard + mcp-compressor 搭配指南

## 两种模式对比

| | mcp-guard 内置压缩 | mcp-compressor (Atlassian) |
|---|---|---|
| **安装** | 零依赖，`--compressor light` 即开 | 需要 Rust 工具链 |
| **压缩率** | 40-70%（裁剪描述+冗余） | 70-97%（wrapper 工具） |
| **无损** | ✅ get_tool_schema 按需获取 | ✅ get_tool_schema 按需获取 |
| **安全** | ✅ 完整 pipeline（白名单+SSRF+限速+注入检测） | ❌ 纯压缩，无安全 |
| **适用** | 快速上手，安全优先 | 极致 token 节省 |

## 推荐组合

```bash
# 只用安全（默认）
mcp-guard init && mcp-guard start

# 安全 + 无损压缩（推荐）
mcp-guard init --compressor light && mcp-guard start

# 安全 + 极致压缩（工具多 > 30 时推荐）
mcp-guard init --compressor tight && mcp-guard start
```

## 决策树

```
需要安全？ ──No──→ 直接用 mcp-compressor
  │
  Yes
  │
  工具数 < 15？ ──Yes──→ mcp-guard 默认（不开压缩）
  │
  No
  │
  有 Rust？ ──Yes──→ mcp-compressor → mcp-guard 链式
  │                    (Agent → compressor → guard → MCP Server)
  No
  │
  └──→ mcp-guard --compressor tight
```

## 链式架构（mcp-compressor + mcp-guard）

```
Agent → mcp-compressor (压缩) → mcp-guard (安全) → MCP Server
         │                         │
         工具压缩为 2-3 wrapper     白名单/SSRF/限速/注入检测照常运行
```

## 内置压缩 vs 外挂压缩

| | 内置 (`--compressor light`) | 外挂 (mcp-compressor) |
|---|---|---|
| Agent 可见工具数 | 3 (wrapper) | 2-3 (wrapper) |
| Policy 拦截 | ✅ 通过 invoke_tool 照样拦截 | ✅ 先压缩后安全，传输不变 |
| 热重载 | ✅ SIGHUP | 需要重启 |
| 注入检测 | ✅ 检测 invoke_tool 的参数 | ❌ 传不到 guard |
