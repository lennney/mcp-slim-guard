# Lazy Loading Design Spec

> mcp-slim-guard — 按需展开工具 schema，减少 tools/list 体积

---

## 1. 概述

### 1.1 目标

实现 lazy loading：`tools/list` 不返回所有工具的完整 schema，而是只返回 `name + description`，LLM 通过额外的 `mcp__get_schema` 工具按需获取完整 schema，然后直接调用真实工具名。

### 1.2 动机

路线图 Phase 1 P0 项。当上游 MCP server 暴露大量工具时（如 GitHub MCP 暴露 60+ 工具），完整 schema 会让 `tools/list` 响应体积膨胀到数万 token，浪费 LLM 上下文窗口。lazy loading 让 LLM 只在真正要调用某工具时才加载该工具的 schema。

### 1.3 设计参考

参考竞品 slim-mcp (Joncik91) 的预算预加载机制（`maxToolsLoaded` + `HIGH_PRIORITY_PATTERNS`）。slim-mcp 使用 promote-on-call + retry 路线（LLM 调 slim 工具时返回 error 要求重试），我们采用 discover-then-call 路线（LLM 主动调 `mcp__get_schema` 获取 schema，省一次 error 往返）。两条路线的差异详见 §7 竞品对比。

### 1.4 约束

- TypeScript strict 模式，零 `any`
- 不新增生产依赖（保持 5 个）
- 向后兼容：`lazy_loading` 默认 false，现有行为不变
- 安全管道（SSRF/注入/白名单/限速）在所有模式下对真实工具名生效
- 基线：334 测试全通过

---

## 2. 核心架构

### 2.1 纯函数 Pipeline

工具列表生成重构为纯函数 pipeline。每个阶段是 `(tools: Tool[]) => Tool[]` 的纯函数，零状态零副作用。pipeline 用 `reduce` 组合，可以任意重排、独立测试。

```typescript
/** 一个压缩/lazy 阶段：输入工具列表，输出变换后的工具列表 */
type ToolStage = (tools: Tool[]) => Tool[];

/**
 * 构建 pipeline — 根据配置组合有序阶段函数
 * originalTools 用于 applyLazyBudget 从原始工具恢复完整 schema
 *   （因为 levelToStage 可能在 applyLazyBudget 之前已精简 schema）
 */
function buildPipeline(
  config: CompressorConfig,
  allow: string[],
  deny: string[],
  originalTools: Map<string, Tool>,
): ToolStage[] {
  const stages: ToolStage[] = [];

  // 阶段 0: 白名单过滤 — 最先执行，后续阶段只看到允许的工具
  stages.push(whitelistFilter(allow, deny));

  // 阶段 1: 压缩级别变换
  stages.push(levelToStage(config.level, config.lazy_loading));

  // 阶段 2 + 3: lazy loading（正交于级别）
  if (config.lazy_loading) {
    stages.push(applyLazyBudget(config.lazy_budget ?? 8, originalTools));
    stages.push(injectGetSchema);
  }

  return stages;
}

/**
 * 生成 tools/list 返回的工具列表 — pipeline 串行执行
 */
export function generateTools(
  fullTools: Tool[],
  config: CompressorConfig,
  allow: string[] = [],
  deny: string[] = [],
): Tool[] {
  if (!config.enabled) return fullTools;
  // 原始工具 Map，供 applyLazyBudget 从原始恢复完整 schema
  const originalTools = new Map(fullTools.map((t) => [t.name, t]));
  return buildPipeline(config, allow, deny, originalTools).reduce((tools, stage) => stage(tools), fullTools);
}
```

### 2.2 四个阶段

| 阶段 | 函数                               | 职责                                                     | 输入 → 输出                   |
| ---- | ---------------------------------- | -------------------------------------------------------- | ----------------------------- |
| 0    | `whitelistFilter(allow, deny)`     | 按 allow/deny 模式过滤工具                               | 全部工具 → 白名单允许的工具   |
| 1    | `levelToStage(level, lazyLoading)` | 按 CompressionLevel 变换 schema                          | 工具 → 压缩后的工具           |
| 2    | `applyLazyBudget(budget)`          | 按 budget 预加载高频工具完整 schema，低频工具移除 schema | 工具 → 混合（full + slim）    |
| 3    | `injectGetSchema`                  | 在工具列表末尾注入 `mcp__get_schema` 发现工具            | 工具 → 工具 + mcp__get_schema |

### 2.3 阶段执行示例

配置：`lazy_loading=true, level=off, budget=8`，上游 10 个工具：

| 阶段              | 输入    | 输出                                               |
| ----------------- | ------- | -------------------------------------------------- |
| whitelistFilter   | 10 工具 | 8 工具（2 个被 deny）                              |
| passthrough (off) | 8 工具  | 8 工具（无变化）                                   |
| applyLazyBudget   | 8 工具  | 8 工具（3 个高频保留完整 schema，5 个移除 schema） |
| injectGetSchema   | 8 工具  | 9 工具（+ mcp__get_schema）                        |

---

## 3. 阶段函数详解

### 3.1 whitelistFilter — 白名单过滤

```typescript
const whitelistFilter: (allow: string[], deny: string[]) => ToolStage = (allow, deny) => (tools) => {
  const isAllowed = (name: string): boolean => {
    // deny 匹配 → 不允许
    if (deny.length > 0 && deny.some((p) => isMatch(name, p))) return false;
    // allow 非空 → 必须匹配至少一个
    if (allow.length > 0) return allow.some((p) => isMatch(name, p));
    // 无 allow 模式 → 全部允许
    return true;
  };
  return tools.filter((t) => isAllowed(t.name));
};
```

**替代现有重复逻辑**：删除 `handleWrapperTool` 内部的 `isToolVisible` 函数（compressor.ts:126-137），白名单逻辑统一在 pipeline 第一阶段。

### 3.2 levelToStage — 压缩级别变换

将现有 `getCompressedTools`（light/normal）和 `getTransformTools`（extreme/maximum）的逻辑重构为阶段函数：

```typescript
const levelToStage: (level: CompressionLevel, lazyLoading: boolean) => ToolStage = (level, lazyLoading) => (tools) => {
  // lazy_loading=true 时，light/normal/tight 退化为 passthrough
  // 因为 lazy 不走 wrapper 模式
  if (lazyLoading && (level === "light" || level === "normal" || level === "tight")) {
    return tools; // passthrough
  }

  // 注：config-loader 的 normalizeCompressionLevel 已把 "tight" 归一化为 "normal"，
  // 所以 "tight" 分支在运行时不会被触发，保留仅为类型完整性
  switch (level) {
    case "off":
      return tools; // passthrough

    case "light":
    case "normal":
    case "tight":
      return makeWrapperTools(tools, level === "light");

    case "extreme":
      return tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: stripPropertyDescriptions(t.inputSchema),
      }));

    case "maximum":
      return tools.map((t) => ({
        name: t.name,
        description: `${t.description ?? ""} ${buildSignature(t)}`.trim(),
        inputSchema: { type: "object" as const, properties: {} },
      }));
  }
};
```

### 3.3 applyLazyBudget — 预算预加载

借鉴 slim-mcp 的 `HIGH_PRIORITY_PATTERNS` 启发式：LLM 通常先调读操作（search/list/read/get/find/describe/info），预加载这些工具的完整 schema 能减少首次 `get_schema` 调用次数。

```typescript
const HIGH_PRIORITY = /^(search|list|read|get|find|describe|info)/i;

const applyLazyBudget: (budget: number) => ToolStage = (budget) => (tools) => {
  // 选择高优先级工具（最多 budget 个），保留完整 schema
  const fullSet = new Set<string>();
  for (const t of tools) {
    if (fullSet.size >= budget) break;
    if (HIGH_PRIORITY.test(t.name)) fullSet.add(t.name);
  }

  // 高优先级工具：保留完整 schema
  // 其余工具：移除 schema，只留 name + description（slim 格式）
  return tools.map((t) => (fullSet.has(t.name) ? t : { name: t.name, description: t.description ?? "" }));
};
```

**与 compression level 的交互**：当 `lazy_loading=true` + `level=extreme` 时，pipeline 顺序是 `levelToStage` → `applyLazyBudget`。`levelToStage` 先把所有工具的 schema 精简（剥离描述），`applyLazyBudget` 再选高频工具——但此时高频工具的 schema 已被精简。

**决策**：当 `lazy_loading=true` 时，`applyLazyBudget` 对高优先级工具应该保留**完整原始 schema**（而非 level 精简后的）。这意味着 pipeline 顺序需要调整：`applyLazyBudget` 应该在 `levelToStage` **之前**对 lazy 模式的工具做决策，或者在 `levelToStage` 之后对高优先级工具从 `fullTools`（原始）恢复完整 schema。

**采用方案**：`applyLazyBudget` 接收原始 `fullTools` 作为参考，对高优先级工具从原始列表恢复完整 schema：

```typescript
const applyLazyBudget: (budget: number, originalTools: Map<string, Tool>) => ToolStage =
  (budget, originalTools) => (tools) => {
    const fullSet = new Set<string>();
    for (const t of tools) {
      if (fullSet.size >= budget) break;
      if (HIGH_PRIORITY.test(t.name)) fullSet.add(t.name);
    }

    return tools.map((t) => {
      if (fullSet.has(t.name)) {
        // 高优先级：从原始工具恢复完整 schema
        return originalTools.get(t.name) ?? t;
      }
      // 低频：移除 schema
      return { name: t.name, description: t.description ?? "" };
    });
  };
```

### 3.4 injectGetSchema — 注入发现工具

```typescript
const GET_SCHEMA = "mcp__get_schema";

const injectGetSchema: ToolStage = (tools) => {
  const toolNames = tools
    .map((t) => t.name)
    .sort()
    .join(", ");
  return [
    ...tools,
    {
      name: GET_SCHEMA,
      description:
        "Get the full input schema (parameters, types, constraints) for a specific tool. Call this before invoking a tool whose schema is not included in the tools list. Returns the complete original schema.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tool_name: {
            type: "string",
            description: `The tool name to get schema for. Available tools: ${toolNames}`,
          },
        },
        required: ["tool_name"],
      },
    },
  ];
};
```

---

## 4. 配置变更

### 4.1 config-types.ts

```typescript
export interface CompressorConfig {
  enabled: boolean;
  level: CompressionLevel;
  /**
   * 按需展开 schema：tools/list 不返回完整 schema，
   * 通过 mcp__get_schema 按需获取。
   * light/normal/tight 级别下退化为 off 行为。
   * 默认 false。
   */
  lazy_loading?: boolean;
  /**
   * lazy loading 模式下预暴露完整 schema 的工具数上限。
   * 高优先级工具（匹配 search/list/read/get/find/describe/info 模式）
   * 优先预加载。默认 8。
   */
  lazy_budget?: number;
}
```

### 4.2 config-schema.ts

```yaml
compressor:
  type: object
  properties:
    enabled:
      type: boolean
      default: false
    level:
      type: string
      enum: ["off", "light", "normal", "tight", "extreme", "maximum"]
      default: "off"
    lazy_loading:
      type: boolean
      default: false
    lazy_budget:
      type: number
      minimum: 0
      maximum: 100
      default: 8
```

### 4.3 normalizeCompressionLevel 扩展

现有 `normalizeCompressionLevel()` 处理 `tight` → `normal` 别名。无需扩展——`lazy_loading` 是独立 boolean 字段，不需要归一化。

---

## 5. 交互流程

### 5.1 六种 level × lazy 组合

| level    | lazy_loading | tools/list 返回                                      | 工具调用路径                               | 安全管道视角     |
| -------- | ------------ | ---------------------------------------------------- | ------------------------------------------ | ---------------- |
| off      | false        | 完整工具（含完整 schema）                            | 直接真实工具                               | 真实工具名       |
| light    | false        | 3 wrapper（list+get_schema+invoke）                  | mcp__invoke_tool                           | mcp__invoke_tool |
| normal   | false        | 2 wrapper（get_schema+invoke）                       | mcp__invoke_tool                           | mcp__invoke_tool |
| extreme  | false        | 真实工具 + 精简 schema                               | 直接真实工具                               | 真实工具名       |
| maximum  | false        | 真实工具 + 签名 + 空 schema                          | 直接真实工具                               | 真实工具名       |
| **任何** | **true**     | 真实工具（预加载 full + 其余 slim）+ mcp__get_schema | 先 get_schema 取完整 schema → 直接真实工具 | 真实工具名       |

### 5.2 lazy_loading=true 详细流程

```
1. LLM 收到 tools/list
   → 看到真实工具名 + 描述
   → 高频工具有完整 schema（可直接调用）
   → 低频工具只有 name + description（无 schema）
   → 末尾有 mcp__get_schema 发现工具

2a. LLM 调用高频工具（已有完整 schema）
   → 直接 tools/call github_search_repositories
   → 安全管道（真实工具名）→ 转发

2b. LLM 调用低频工具（无 schema）
   → 先调 mcp__get_schema({tool_name: "github_create_issue"})
   → 代理返回完整原始 schema（参数、类型、约束）
   → LLM 根据 schema 构造参数
   → tools/call github_create_issue
   → 安全管道（真实工具名）→ 转发
```

### 5.3 安全管道视角

lazy_loading 模式下，LLM 直接调用真实工具名（不经过 `mcp__invoke_tool` wrapper），安全管道看到的是真实工具名（如 `github_search_repositories`），白名单/限速/SSRF/注入全部基于真实工具名生效。

`mcp__get_schema` 调用本身不需要走安全管道（它是发现工具，不执行真实操作），但需要白名单检查——被 deny 的工具不返回 schema（已在 pipeline 阶段 0 过滤，handleWrapperTool 不再需要重复检查）。

---

## 6. proxy.ts 改造

### 6.1 tools/list handler 简化

```typescript
this.server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allNames = this.fullTools.map((t) => t.name);
  this.audit.logDiscovery(this.sessionId, ++this.requestCounter, "all", this.fullTools.length, allNames);
  return {
    tools: generateTools(this.fullTools, this.config.compressor, this.config.tools.allow, this.config.tools.deny),
  };
});
```

删除现有的三层 if 分支（off / extreme+maximum / light+normal），统一调 `generateTools()`。

### 6.2 tools/call handler 简化

```typescript
this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name: prefixedName, arguments: args = {} } = request.params;

  // mcp__* 前缀 → wrapper/discovery 工具
  if (prefixedName.startsWith(PREFIX)) {
    const wrapperResult = await handleWrapperTool(prefixedName, args, this.fullTools, (targetName, targetArgs) =>
      forwardToolCall(targetName, targetArgs),
    );
    if (wrapperResult) {
      const reqId = ++this.requestCounter;
      this.audit.log(
        { toolName: prefixedName, arguments: args, serverName: "compressor" },
        { allowed: true },
        [],
        this.sessionId,
        reqId,
        0,
      );
      return wrapperResult;
    }
  }

  // 真实工具 → 安全管道
  return forwardToolCall(prefixedName, args);
});
```

删除现有的 `isWrapperLevel` 判断，改为按工具名前缀拦截——简单且正确，lazy 模式下只有 `mcp__get_schema` 会被拦截（LLM 直接调真实工具名）。

### 6.3 handleWrapperTool 简化

删除 `allowPatterns` / `denyPatterns` 参数和内部的 `isToolVisible` 函数（白名单已移到 pipeline 阶段 0）。

```typescript
export async function handleWrapperTool(
  toolName: string,
  args: Record<string, unknown>,
  fullTools: Tool[],  // 已经过白名单过滤
  serverCall: (resolvedToolName: string, resolvedArgs: Record<string, unknown>) => Promise<{...}>,
): Promise<{...} | null> {
  if (!toolName.startsWith(PREFIX)) return null;

  const nameToSchema: Record<string, Tool> = {};
  for (const t of fullTools) nameToSchema[t.name] = t;

  switch (toolName) {
    case LIST_TOOLS: {
      const entries = fullTools.map(t => ({
        name: t.name,
        description: t.description || "(no description)",
      }));
      return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
    }

    case GET_SCHEMA: {
      const targetName = args.tool_name as string;
      if (!targetName || !nameToSchema[targetName]) {
        return {
          content: [{ type: "text", text: `Unknown tool: "${targetName}"` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(nameToSchema[targetName], null, 2) }],
      };
    }

    case INVOKE: {
      const targetName = args.tool_name as string;
      const input = (args.input || {}) as Record<string, unknown>;
      if (!targetName) {
        return { content: [{ type: "text", text: "Missing required parameter: tool_name" }], isError: true };
      }
      return serverCall(targetName, input);
    }

    default:
      return null;
  }
}
```

---

## 7. 竞品对比

| 维度                  | slim-mcp (Joncik91)                           | mcp-slim-guard（本设计）                     |
| --------------------- | --------------------------------------------- | -------------------------------------------- |
| 按需加载路线          | promote-on-call + retry（隐式，错误驱动）     | discover-then-call（显式，get_schema 发现）  |
| 发现工具              | 无                                            | `mcp__get_schema`                            |
| LLM 调用真实工具      | 是（直接调真实名，proxy 拦截 slim）           | 是（直接调真实名，不经 invoke_tool wrapper） |
| 未加载工具被调用时    | 返回 error "Please retry" + 自动提升          | LLM 先调 get_schema 拿到 schema 再调         |
| 首次往返成本          | 3 次（失败 + list + 成功）                    | 2 次（get_schema + 调用）                    |
| 依赖 LLM 遵守指令     | 低（自动补救）                                | 高（需理解 get_schema 协议）                 |
| 预算预加载            | `maxToolsLoaded=8` + `HIGH_PRIORITY_PATTERNS` | `lazy_budget=8` + `HIGH_PRIORITY`（借鉴）    |
| lazy 与 compress 关系 | 正交、可叠加                                  | 正交、可叠加（pipeline 阶段分离）            |
| 安全层                | 无                                            | 完整 PolicyPipeline                          |
| 代码结构              | 命令式，嵌入 proxy handler                    | 纯函数 pipeline                              |

**我们的差异化价值**：slim-mcp 没有安全层。我们的 lazy loading 与 PolicyPipeline 协同，安全管道始终基于真实工具名生效。

---

## 8. 删除的旧函数

| 函数                                     | 替代                               | 影响文件                     |
| ---------------------------------------- | ---------------------------------- | ---------------------------- |
| `getCompressedTools(fullTools, config)`  | `generateTools()` + `levelToStage` | proxy.ts, compressor.test.ts |
| `getTransformTools(fullTools, level)`    | `generateTools()` + `levelToStage` | proxy.ts, compressor.test.ts |
| `handleWrapperTool` 内部 `isToolVisible` | `whitelistFilter` pipeline 阶段    | compressor.ts                |

现有 `getCompressedTools` 和 `getTransformTools` 只被 `proxy.ts` 引用，删除后 proxy.ts 改调 `generateTools()`。测试中引用改为调 `generateTools()` 或直接调阶段函数。

---

## 9. 测试策略

### 9.1 单元测试（tests/unit/compressor.test.ts 扩展）

| 类别                 | 用例                                                                                     | 数量   |
| -------------------- | ---------------------------------------------------------------------------------------- | ------ |
| `whitelistFilter`    | allow 匹配/deny 拦截/空 allow 全通过/混合模式                                            | 4      |
| `levelToStage`       | off 透传/light 3 wrapper/normal 2 wrapper/extreme 剥描述/maximum 签名/lazy+light 退化    | 6      |
| `applyLazyBudget`    | 全部高频/budget=0 全 slim/budget=100 全 full/混合/从原始恢复 schema                      | 5      |
| `injectGetSchema`    | 注入位置/描述含工具名列表/空工具列表                                                     | 3      |
| `buildPipeline` 组合 | lazy+off / lazy+extreme / lazy+maximum / lazy+light 退化 / 非 lazy+extreme / 非 lazy+off | 6      |
| **小计**             |                                                                                          | **24** |

### 9.2 集成测试（tests/integration/compressor-pipeline.test.ts 扩展）

| 用例                | 场景                                                                   | 数量  |
| ------------------- | ---------------------------------------------------------------------- | ----- |
| lazy+off 端到端     | tools/list 返回预加载 + slim + get_schema → get_schema 调用 → 真实调用 | 1     |
| lazy+extreme 端到端 | level 先精简 → lazy 预加载从原始恢复                                   | 1     |
| lazy+maximum 端到端 | level 先签签名 → lazy 预加载从原始恢复                                 | 1     |
| budget 边界         | budget=0 全 slim / budget 大于工具数全 full                            | 2     |
| **小计**            |                                                                        | **5** |

### 9.3 回归测试

现有 334 测试全部保持通过。删除的 `getCompressedTools`/`getTransformTools` 的测试改为调 `generateTools()`，断言行为等价。

### 9.4 最终测试数

334（基线）+ 24（新单元）+ 5（新集成）= **363 tests**

---

## 10. 文件变更清单

| 文件                                            | 变更类型 | 内容                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/compressor.ts`                             | 重构     | 删除 `getCompressedTools`/`getTransformTools`；新增 `generateTools`/`buildPipeline`/`whitelistFilter`/`levelToStage`/`applyLazyBudget`/`injectGetSchema`/`makeWrapperTools`/`makeGetSchemaTool`；简化 `handleWrapperTool`；保留 `buildSignature`/`stripPropertyDescriptions`/`PREFIX`/`LIST_TOOLS`/`GET_SCHEMA`/`INVOKE` |
| `src/config-types.ts`                           | 扩展     | `CompressorConfig` 加 `lazy_loading?` / `lazy_budget?`                                                                                                                                                                                                                                                                   |
| `src/config-schema.ts`                          | 扩展     | schema 加 `lazy_loading` / `lazy_budget` 属性                                                                                                                                                                                                                                                                            |
| `src/proxy.ts`                                  | 简化     | tools/list 改调 `generateTools()`；tools/call 按前缀拦截；删除 `isWrapperLevel`                                                                                                                                                                                                                                          |
| `src/cli.ts`                                    | 扩展     | `--compressor` 帮助文本加 lazy_loading/lazy_budget 说明；status 输出显示 lazy 模式                                                                                                                                                                                                                                       |
| `docs/COMPRESSOR.md`                            | 扩展     | 新增 lazy loading 章节、6 种组合表、配置说明                                                                                                                                                                                                                                                                             |
| `tests/unit/compressor.test.ts`                 | 扩展     | +24 单元测试                                                                                                                                                                                                                                                                                                             |
| `tests/integration/compressor-pipeline.test.ts` | 扩展     | +5 集成测试                                                                                                                                                                                                                                                                                                              |

---

## 11. 验收标准

1. `npx tsc --noEmit` 通过（零 any，strict 模式）
2. `npx vitest run` 全部通过（363 tests）
3. 现有 5 级压缩行为不变（回归测试通过）
4. `lazy_loading=false` 时行为与改动前完全一致
5. `lazy_loading=true` + `level=off` 时 tools/list 返回预加载 + slim + get_schema
6. `lazy_loading=true` + `level=light/normal/tight` 退化为 `level=off` 行为
7. `mcp__get_schema` 返回完整原始 schema
8. 安全管道在 lazy 模式下基于真实工具名生效
9. 白名单过滤在 pipeline 阶段 0 生效，handleWrapperTool 不再重复检查
10. CLI `--help` 显示 lazy_loading/lazy_budget 选项
