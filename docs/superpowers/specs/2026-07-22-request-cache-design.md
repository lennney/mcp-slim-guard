# Request Cache TTL+LRU — Design Spec

> Phase 1 剩余 P0 | 2026-07-22

## 背景

Phase 1 压缩对标中唯二剩余 P0 之一。目标：对只读 MCP 工具调用结果做内存缓存，减少重复上游调用，降低延迟和 token 消耗。

## 架构

```
tools/call → resolveTool → policy pipeline → [CACHE CHECK] → upstream call → [CACHE WRITE] → return
                                              ↓ miss                              ↓ store
                                              [CACHE HIT] → return cached + audit
```

- 缓存内联于 `GuardProxy.forwardToolCall`，在安全管道通过后、`serverManager.callTool()` 之前
- 不进入 PolicyPipeline（Policy 返回 allowed/blocked，不返回工具结果内容）
- 新增独立模块 `src/cache.ts`，`GuardProxy` 注入

## Config

```yaml
cache:
  enabled: true          # 默认 false（向后兼容）
  ttl: 30                # 全局默认 TTL（秒）
  max_entries: 500       # LRU 容量上限
  allow: []              # 强制可缓存的工具名 glob（空 = 用模式推断）
  deny: []               # 强制不可缓存的工具名 glob
  ttl_per_tool:          # 按工具名精确覆盖 TTL
    github_search_repositories: 15
```

```ts
interface CacheConfig {
  enabled: boolean;
  ttl: number;
  max_entries: number;
  allow: string[];
  deny: string[];
  ttl_per_tool?: Record<string, number>;
}
```

`GuardConfig` 新增 `cache: CacheConfig` 字段。

## 可缓存判断

优先级：`deny` 匹配 → 不可缓存；`allow` 非空 → 必须在 `allow` 内；否则模式推断。

模式推断：工具名匹配 `^(?:[^_]+_)?(search|list|find|query|read|get|describe|info|check)` → 可缓存；其他不可。

## TTL 推断

优先级：`ttl_per_tool` 精确匹配 → 模式推断 → 全局默认。

模式推断：
- 含 `search|list|find|query` → 15s
- 含 `read|get|describe|info|check` → 60s
- 其他 → 全局 `config.ttl`（默认 30s）

## ToolCache 模块

```ts
// src/cache.ts
interface CacheEntry {
  result: ToolResult;
  expiresAt: number;  // Date.now() + ttl*1000
}

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export class ToolCache {
  constructor(config: CacheConfig);
  isCacheable(toolName: string): boolean;
  getTTL(toolName: string): number;
  get(toolName: string, args: Record<string, unknown>): ToolResult | null;
  set(toolName: string, args: Record<string, unknown>, result: ToolResult): void;
  clear(): void;
  stats(): { size: number; hits: number; misses: number };
}
```

**Cache key：** `JSON.stringify([toolName, sortedKeys(args)])`，保证参数顺序无关。

**LRU 淘汰：** `accessOrder` 数组维护访问顺序。`get()` 命中时移到末尾，`set()` 追加到末尾。超出 `max_entries` 时 shift 头部。

**过期检查：** `get()` 时检查 `expiresAt`，过期返回 null 并删除。

**审计集成：** 缓存命中时，审计日志中 `decisionTrail` 追加 `{ policy: "cache", result: "pass" }`，`action` 仍为 `"allowed"`。

## 集成点

**proxy.ts `forwardToolCall`：**
```ts
// 在 policy pipeline 通过后、serverManager.callTool() 之前
if (this.cache) {
  const cached = this.cache.get(prefixedName, args);
  if (cached) return cached;
}

const result = await this.serverManager.callTool(serverName, originalToolName, args);

if (this.cache?.isCacheable(prefixedName)) {
  this.cache.set(prefixedName, args, result);
}
return result;
```

**cli.ts：** `start` 和 SIGHUP reload 时从 `config.cache` 构建 `new ToolCache(config.cache)`。

**热重载：** `GuardProxy.reload()` 重建 `this.cache = new ToolCache(newConfig.cache)`，清空旧缓存。

## 测试策略

| 文件 | 覆盖 |
|------|------|
| `tests/unit/cache.test.ts` | isCacheable/deny/allow 逻辑、TTL 三层推断、LRU 淘汰、过期检查、stats 统计、key 生成（参数排序无关性）、isError 结果不缓存 |
| `tests/unit/proxy.test.ts` | 缓存命中/未命中链路、disabled 时跳过 |
| `tests/integration/full-pipeline.test.ts` | 端到端缓存命中 → 不调用上游、缓存过期后重新调用上游 |

## 约束

- 5 个生产依赖，不新增
- 不引入外部 KV 存储（纯内存 Map）
- 缓存仅对 `tools/call` 生效，不影响 `tools/list`
- `isError: true` 的响应不缓存
- 向后兼容：`enabled: false` 时零 overhead