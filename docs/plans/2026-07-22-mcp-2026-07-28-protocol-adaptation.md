# MCP 2026-07-28 协议适配计划

## 背景

MCP 2026-07-28 协议更新涉及 4 项对 mcp-slim-guard 的改动。SDK 1.29.0 (实际安装版本) 仅支持 `_meta` 字段，`resultType`/`ttlMs`/`server/discover` 均未实现 → 采用 polyfill 策略手动注入。

## SDK 兼容状态

| 变更                   | SDK 1.29.0 | 策略                                     |
| ---------------------- | ---------- | ---------------------------------------- |
| `_meta` in request     | ✅ 支持    | 直接传入 `client.callTool()`             |
| `resultType` in result | ❌ 不支持  | 手动注入到返回对象                       |
| `ttlMs` in result      | ❌ 不支持  | `set()` 接受可选参数，未来上游实现即可用 |
| `server/discover`      | ❌ 不支持  | ServerManager 新增合成实现               |

---

## Task 1: proxy.ts — 注入 `resultType: "complete"`

### 文件：`src/proxy.ts`

### 测试：`tests/unit/proxy.test.ts`

### 改动

`forwardToolCall` 函数 (line 113-187) 有 4 个返回路径，每个都需加 `resultType: "complete"`：

**路径 A** — 未知工具错误 (line 119-125):

```ts
return {
  content: [...],
  isError: true,
  resultType: "complete",  // NEW
};
```

**路径 B** — 策略拒绝 (line 147-155):

```ts
return {
  content: [...],
  isError: true,
  resultType: "complete",  // NEW
};
```

**路径 C** — 缓存命中 (line 162-173):

```ts
// cached already has content/isError from cache; spread + add resultType
return { ...cached, resultType: "complete" };
```

**路径 D** — 正常调用结果 (line 186):

```ts
// callResult from serverManager.callTool; spread + add resultType
return { ...callResult, resultType: "complete" };
```

### 测试更新

`proxy.test.ts` 中所有检查 `tools/call` 返回值的断言需要更新：

- `expect(result).toEqual(...)` → 加入 `resultType: "complete"`
- 缓存命中路径确认返回包含 `resultType`
- 约 15-20 处断言需要更新

### 验收标准

1. 所有 4 个返回路径都包含 `resultType: "complete"`
2. `proxy.test.ts` 全部通过
3. `tsc --noEmit` 通过
4. 集成测试通过（`full-pipeline.test.ts` + `compressor-pipeline.test.ts`）

---

## Task 2: server-manager.ts — 注入 `_meta`

### 文件：`src/server-manager.ts`

### 测试：`tests/unit/server-manager.test.ts`

### 改动

`callTool` 方法 (line 178-196) 注入 `_meta`：

```ts
async callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<...> {
  const conn = this.connections.get(serverName);
  if (!conn) { throw ...; }

  const result = await conn.client.callTool(
    {
      name: toolName,
      arguments: args,
      _meta: {                          // NEW
        protocolVersion: "2025-11-25",  // SDK's actual supported version
        clientCapabilities: {},
      },
    },
    CallToolResultSchema,
  );

  return { content: ... };
}
```

> `protocolVersion` 用 `"2025-11-25"` 而非 `"DRAFT-2026-v1"` — 因为 SDK Zod schemas 用的是 `2025-11-25`，且 `_meta` 是 open-ended `[key: string]: unknown`，不会触发校验错误。

### 测试更新

`server-manager.test.ts` 中 `callTool` 调用断言需验证 `_meta` 被传递：

```ts
expect(mockClient.callTool).toHaveBeenCalledWith(
  {
    name: "search_repositories",
    arguments: { q: "test" },
    _meta: { protocolVersion: "2025-11-25", clientCapabilities: {} },
  },
  expect.anything(),
);
```

### 验收标准

1. `callTool` 调用上游时携带 `_meta`
2. `server-manager.test.ts` 全部通过
3. `tsc --noEmit` 通过

---

## Task 3: cache.ts — 消费上游 `ttlMs` 提示 (可选)

### 文件：`src/cache.ts`

### 测试：`tests/unit/cache.test.ts`

### 改动

`set()` 方法签名增加可选 `ttlMs` 参数：

```ts
set(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  ttlMs?: number,  // NEW: upstream TTL hint in milliseconds
): void {
  if (!this.config.enabled) return;
  if (result.isError) return;
  const key = makeKey(toolName, args);
  const ttl = ttlMs !== undefined
    ? ttlMs                          // use upstream hint (in ms)
    : this.getTTL(toolName) * 1000;  // fallback to pattern-inferred (in s, convert to ms)
  this.map.set(key, { result, expiresAt: Date.now() + ttl });
  // ... LRU logic unchanged
}
```

> 注意：`getTTL()` 返回秒，`ttlMs` 是毫秒。`expiresAt` 始终用毫秒。

### proxy.ts 配套改动

`forwardToolCall` 中缓存写入路径 (line 182-184) 传递 `ttlMs` (当前 SDK 不返回，传 `undefined`，但预留管线):

```ts
// 当前 SDK 不返回 ttlMs，未来上游实现后 callResult 可能包含此字段
const upstreamTtlMs = (callResult as any).ttlMs;
this.cache.set(prefixedName, args, callResult, upstreamTtlMs);
```

### 测试更新

新增 2 个测试用例：

```ts
it("uses upstream ttlMs when provided", () => { ... });
it("falls back to pattern TTL when ttlMs is undefined", () => { ... });
```

### 验收标准

1. 传入 `ttlMs=5000` 时，条目 5 秒后过期
2. 未传入 `ttlMs` 时，行为不变（模式推断 TTL）
3. `cache.test.ts` 全部通过
4. `tsc --noEmit` 通过

---

## Task 4: server-manager.ts — `server/discover` 转发

### 文件：`src/server-manager.ts`

### 测试：`tests/unit/server-manager.test.ts`

### 改动

新增 `discover()` 方法，合成返回所有已连接服务器的元数据：

```ts
/**
 * Synthesize server discovery metadata for all connected upstream servers.
 * Returns a response compatible with the MCP 2026-07-28 server/discover format.
 */
async discover(): Promise<{
  servers: Array<{
    name: string;
    version?: string;
    capabilities: Record<string, unknown>;
  }>;
}> {
  const servers: Array<{
    name: string;
    version?: string;
    capabilities: Record<string, unknown>;
  }> = [];

  for (const [name, conn] of this.connections) {
    try {
      // Try to get server info from the connected client
      const serverInfo = conn.client.getServerVersion?.() ?? {};
      servers.push({
        name,
        version: (serverInfo as any).version,
        capabilities: {
          tools: { listChanged: false },  // mcp-slim-guard currently assumes static tool lists
        },
      });
    } catch {
      // Best-effort: return minimal info even if the upstream doesn't respond
      servers.push({
        name,
        capabilities: { tools: { listChanged: false } },
      });
    }
  }

  return { servers };
}
```

> **设计决策**：`server/discover` 尚未进入 SDK (1.29.0)，实现为 `ServerManager` 的独立方法而非 MCP Server handler。等 SDK 支持后可在 `proxy.ts` 注册为 `setRequestHandler("server/discover", ...)`。

### 测试更新

新增 3 个测试用例：

```ts
it("returns all connected servers with capabilities", () => { ... });
it("returns empty when no servers connected", () => { ... });
it("handles server info failure gracefully", () => { ... });
```

### 验收标准

1. `discover()` 返回所有已连接服务器的名称和能力信息
2. 无连接服务器时返回空数组
3. 单个服务器获取失败不影响其他服务器
4. `server-manager.test.ts` 全部通过
5. `tsc --noEmit` 通过

---

## 依赖关系

```
Task 1 (resultType) ──┐
                       ├── 无依赖，可并行
Task 2 (_meta) ───────┤
                       │
Task 3 (ttlMs) ───────┤
                       │
Task 4 (discover) ────┘
```

4 项修改互不依赖（不同文件 + 不同测试），可并行实施。

## 完成标准

- [ ] `npm test` 全部通过（397 tests → 预计 400+）
- [ ] `npx tsc --noEmit` 通过
- [ ] 集成测试通过（build 后 `full-pipeline.test.ts` + `compressor-pipeline.test.ts`）
- [ ] HANDOVER.md 待办勾选 ✅
- [ ] CHANGELOG 追加 `0.4.0` 条目
