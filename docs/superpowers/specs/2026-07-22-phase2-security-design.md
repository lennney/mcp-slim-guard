# Phase 2 — 安全增强 设计文档

> 日期: 2026-07-22
> 状态: Draft
> 关联: docs/ROADMAP.md Phase 2

## 目标

安全层从"可用"到"可卖"。3 个新功能：

1. **策略模板** — init 时 `--profile strict|medium|loose`，一键预设安全策略
2. **风险评分** — `mcp-slim-guard score`，动态连接 server 评估风险，0-100 分 + A/B/C/D 等级
3. **安全报告 CLI** — `mcp-slim-guard audit`，配置审查 + 日志分析 + 风险评分一体化报告

## 架构

```
mcp-slim-guard init --profile strict    ──→ src/profiles.ts        (模板注入配置)
mcp-slim-guard score                     ──→ src/risk-score.ts      (动态连接 server，打分)
mcp-slim-guard audit                     ──→ src/security-report.ts (配置审查 + 日志分析 + 调用 score)
```

### 分层依赖

```
audit 命令 ──→ security-report.ts ──→ risk-score.ts (复用)
                                      config-types.ts (配置)
                                      audit.ts (日志读取)
score 命令 ──→ risk-score.ts ─────────→ server-manager.ts (连接 server)
init 命令  ──→ profiles.ts ──────────→ config-loader.ts (生成配置)
```

- profiles 不依赖其他两个
- risk-score 独立（纯函数核心 + 连接逻辑）
- security-report 依赖 risk-score（组合）

### 新增文件

| 文件                     | 职责                                              | 被谁调用                   |
| ------------------------ | ------------------------------------------------- | -------------------------- |
| `src/profiles.ts`        | 3 个预设模板，生成对应配置                        | `init` 命令                |
| `src/risk-score.ts`      | 连接 server 获取真实工具 → 0-100 分 + findings    | `score` 命令, `audit` 命令 |
| `src/security-report.ts` | 配置审查 + 日志分析 → 完整报告（内嵌 score 结果） | `audit` 命令               |

### CLI 新增

- `init --profile strict|medium|loose`（新增选项，默认 medium）
- `mcp-slim-guard score`（新命令）
- `mcp-slim-guard audit`（新命令）

---

## 功能 1: 策略模板（profiles.ts）

### 3 个模板

| 模板               | 适用场景        | tools.allow                                                 | tools.deny                                        | SSRF                      | injection              | rate_limit | compressor |
| ------------------ | --------------- | ----------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ---------------------- | ---------- | ---------- |
| **strict**         | 生产 / 高安全   | `[]`（fail-closed）                                         | `*_delete_*`, `*_drop_*`, `*_admin_*`, `*_exec_*` | block + block_private_ips | enabled, high, block   | 30/min     | off        |
| **medium**（默认） | 开发环境        | `*_read_*`, `*_search_*`, `*_list_*`, `*_get_*`, `*_find_*` | `*_delete_*`, `*_drop_*`, `*_admin_*`             | block + block_private_ips | enabled, medium, block | 60/min     | off        |
| **loose**          | 测试 / 快速上手 | `*`（全允许）                                               | `[]`                                              | log                       | enabled, low, log      | 120/min    | off        |

### 关键决策

- 模板只覆盖安全策略部分（tools/ssrf/injection/rate_limit），不碰 servers 和 compressor
- 用户仍可 `--compressor light` 单独设置压缩
- strict 的 `allow: []` 是故意的 fail-closed，强制用户显式配置
- `--profile` 不指定时默认 medium
- deny 列表中的 `*_exec_*` 覆盖 shell_exec / exec_command 等危险工具

### 接口

```typescript
// profiles.ts
export type ProfileName = "strict" | "medium" | "loose";

export interface ProfileConfig {
  tools: { allow: string[]; deny: string[] };
  ssrf: { mode: "block" | "log" | "off"; block_private_ips: boolean };
  injection_detection: { enabled: boolean; sensitivity: "low" | "medium" | "high"; mode: "block" | "log" };
  rate_limit: { default: string };
}

export const PROFILES: Record<ProfileName, ProfileConfig>;

/** 将 profile 的安全策略合并到已有的基础配置上 */
export function applyProfile(config: GuardConfig, profile: ProfileName): GuardConfig;
```

### init 命令修改

```typescript
// cli.ts init 命令增加 --profile 选项
.option("--profile <name>", "Security profile: strict, medium, loose", "medium")

// init action 中：
// 1. discoverMCPConfig → 生成基础配置
// 2. applyProfile(config, options.profile) → 覆盖安全策略
// 3. applyCompressor（如果 --compressor 指定）
// 4. 写 mcp-slim-guard.yml
```

---

## 功能 2: 风险评分（risk-score.ts）

### 评分模型：0-100 分，分数越高越安全

### 评分维度（6 项，加权求和）

| 维度             | 权重 | 检查内容                                        | 0分（危险）         | 满分（安全）              |
| ---------------- | ---- | ----------------------------------------------- | ------------------- | ------------------------- |
| **危险工具暴露** | 30%  | 工具名含 shell/exec/write/delete/drop 的数量    | ≥5 个危险工具       | 0 个危险工具              |
| **白名单覆盖**   | 20%  | `tools.allow` 是否非空（fail-closed vs 全暴露） | allow 为空 = 无限制 | allow 明确限制            |
| **SSRF 防护**    | 15%  | SSRF mode + block_private_ips                   | off                 | block + private IP        |
| **注入检测**     | 15%  | injection enabled + sensitivity                 | disabled            | enabled + high            |
| **速率限制**     | 10%  | rate_limit.default 值                           | 无限制              | ≤30/min                   |
| **deny 列表**    | 10%  | `tools.deny` 是否配置了高危模式                 | 无 deny             | deny 含 delete/drop/admin |

### 危险工具关键词

```typescript
const DANGEROUS_KEYWORDS = [
  "exec",
  "shell",
  "write",
  "delete",
  "drop",
  "remove",
  "rm",
  "kill",
  "admin",
  "root",
  "sudo",
  "chmod",
  "chown",
];
```

### 等级映射

```
A (85-100): 安全 — 适合生产
B (70-84):  中等 — 建议加固
C (50-69):  风险 — 仅限测试
D (0-49):   危险 — 需立即修复
```

### 危险工具评分逻辑

```
0 个危险工具:  30 分
1 个:         24 分 (30 * 0.8)
2 个:         18 分 (30 * 0.6)
3 个:         12 分 (30 * 0.4)
4 个:          6 分 (30 * 0.2)
≥5 个:         0 分
```

### 速率限制评分逻辑

```
≤30/min:    10 分
31-60/min:   7 分
61-120/min:  4 分
>120/min:    0 分
无限制:       0 分
```

### 输出示例

```
🛡️ mcp-slim-guard score

Server: github (12 tools)
  危险工具:    2 (github_create_file, github_delete_file)  -12
  白名单覆盖:  ✅ allow 列表已配置                          +20
  SSRF:        block + private IP                          +15
  注入检测:    enabled, medium                             +10
  速率限制:    60/min                                      +7
  Deny 列表:   *_delete_*, *_admin_*                        +10
  ─────────────────────────────────────
  Score: 50/100  Grade: C  (风险 — 仅限测试)

  💡 建议:
    - 注入检测灵敏度可提高到 high
    - github_create_file / github_delete_file 建议加入 deny 列表

Server: filesystem (14 tools)
  ...
  Score: 78/100  Grade: B  (中等 — 建议加固)
```

### 接口

```typescript
// risk-score.ts

export interface RiskFinding {
  dimension: string; // "危险工具暴露", "白名单覆盖" 等
  score: number; // 该维度得分
  maxScore: number; // 该维度满分
  detail: string; // 人类可读描述
  recommendation?: string; // 改进建议
}

export interface RiskReport {
  serverName: string;
  score: number; // 0-100
  grade: "A" | "B" | "C" | "D";
  toolCount: number;
  dangerousTools: string[];
  findings: RiskFinding[];
  recommendations: string[];
}

/**
 * 纯函数：根据 config 和工具列表计算风险评分。
 * 不连接 server — 调用方负责获取工具列表。
 */
export function calculateRiskScore(
  config: GuardConfig,
  serverName: string,
  tools: { name: string; description?: string }[],
): RiskReport;

/**
 * CLI 入口：连接每个 server 获取真实工具列表，调用 calculateRiskScore。
 * 返回每个 server 的报告。
 */
export async function runScoreCommand(config: GuardConfig): Promise<RiskReport[]>;
```

### CLI 命令

```
mcp-slim-guard score

连接每个上游 server，获取工具列表，输出风险评分。
如果 server 不可达，跳过并标注 "connection failed"。
退出码：有任何 server 评分为 D 时 exit 1，否则 exit 0。
```

---

## 功能 3: 安全报告（security-report.ts）

### `mcp-slim-guard audit` — 一体化安全报告

分 3 个部分：

#### Part 1: 配置审查（静态）

不连接 server，分析 `mcp-slim-guard.yml` 配置：

| 检查项                | 说明                           | 级别        |
| --------------------- | ------------------------------ | ----------- |
| allow 列表为空        | fail-closed 会导致所有工具被拦 | ⚠️ warning  |
| allow 为 `["*"]`      | 全允许，无白名单               | 🔴 critical |
| SSRF 关闭             | ssrf.mode = "off"              | 🔴 critical |
| 注入检测关闭          | injection.enabled = false      | 🔴 critical |
| 注入检测低灵敏度      | sensitivity = "low"            | ⚠️ warning  |
| 速率限制过高          | >120/min                       | ⚠️ warning  |
| deny 列表为空         | 无显式拒绝高危工具             | ℹ️ info     |
| 审计日志输出到 stdout | 生产环境建议 file              | ℹ️ info     |
| 审计轮转未配置        | maxSize/maxFiles 缺失          | ⚠️ warning  |

#### Part 2: 日志分析（动态）

读取 `mcp-slim-guard-audit.log`，统计：

```
📊 Audit Log Analysis (last 7 days)
  Total calls:     1,234
  ✅ Allowed:      1,180 (95.6%)
  🚫 Blocked:      54 (4.4%)
  Top blocked tools:
    github_delete_file     (23 blocks)
    filesystem_write_file  (15 blocks)
  Block reasons:
    whitelist deny:    40
    injection:         10
    ratelimit:          4
  Peak hour: 14:00-15:00 (210 calls)
```

如果日志文件不存在，跳过此部分并标注 "no audit log found"。

#### Part 3: 风险评分（动态）

调用 `runScoreCommand`，为每个 server 输出风险评分（同 `mcp-slim-guard score` 的输出）。

### 完整输出结构

```
🛡️ mcp-slim-guard audit — Security Report
═══════════════════════════════════════════════

📋 Part 1: Configuration Review
  ✅ tools.allow: 3 pattern(s)
  🔴 tools.deny: empty — no explicit deny for dangerous tools
  ✅ SSRF: block + private IP blocking
  🔴 Injection detection: disabled
  ⚠️ Rate limit: 120/min (consider lowering)
  ✅ Audit: file (mcp-slim-guard-audit.log, 10MB rotation)
  ...

📊 Part 2: Audit Log Analysis
  Total calls:     1,234
  ✅ Allowed:      1,180 (95.6%)
  🚫 Blocked:      54 (4.4%)
  ...

🎯 Part 3: Risk Score
  Server: github     Score: 78/100  Grade: B
  Server: filesystem Score: 52/100  Grade: C
  ...

📝 Summary
  Config issues: 2 critical, 1 warning
  Log: 54 blocked calls (4.4% block rate)
  Overall: C — 需要加固

  💡 Top recommendations:
    1. Enable injection detection (critical)
    2. Add deny list for *_delete_*, *_admin_*
    3. Lower rate limit to 60/min
```

### 接口

```typescript
// security-report.ts

export interface ConfigIssue {
  check: string;
  level: "critical" | "warning" | "info";
  message: string;
  recommendation?: string;
}

export interface LogStats {
  totalCalls: number;
  allowedCount: number;
  blockedCount: number;
  blockRate: number; // 0-1
  topBlockedTools: { name: string; count: number }[];
  blockReasons: Record<string, number>;
  peakHour?: string;
}

export interface SecurityReport {
  configIssues: ConfigIssue[];
  logStats: LogStats | null; // null if no log file
  riskReports: RiskReport[]; // from risk-score.ts
  summary: {
    criticalCount: number;
    warningCount: number;
    overallGrade: "A" | "B" | "C" | "D";
    topRecommendations: string[];
  };
}

/**
 * 纯函数：审查配置，返回问题列表。
 */
export function reviewConfig(config: GuardConfig): ConfigIssue[];

/**
 * 纯函数：分析审计日志，返回统计。
 */
export function analyzeAuditLog(logPath: string): LogStats | null;

/**
 * 组合：配置审查 + 日志分析 + 风险评分 = 完整报告。
 * 连接 server 获取工具列表（同 score 命令）。
 */
export async function generateSecurityReport(
  config: GuardConfig,
  logPath: string,
  riskReports: RiskReport[], // 由调用方通过 runScoreCommand 获取
): Promise<SecurityReport>;
```

### CLI 命令

```
mcp-slim-guard audit [--no-score]  [--log <path>]

--no-score  跳过风险评分（不连接 server，仅静态分析）
--log       指定日志文件路径（默认 mcp-slim-guard-audit.log）
```

退出码：有 critical 问题或任何 server 评分为 D 时 exit 1，否则 exit 0。

---

## 测试策略

### profiles.ts

- 单元测试：每个 profile 的配置值正确
- 单元测试：applyProfile 正确覆盖基础配置
- 单元测试：applyProfile 不覆盖 servers 和 compressor
- 集成测试：init --profile strict 生成的 yml 包含正确配置

### risk-score.ts

- 单元测试：calculateRiskScore 纯函数
  - 0 个危险工具 → 30 分
  - 5+ 个危险工具 → 0 分
  - allow 为空 → 0 分（白名单维度）
  - allow 非空 → 20 分
  - SSRF off → 0 分, block+private → 15 分
  - 注入 disabled → 0 分, enabled+high → 15 分
  - 各等级分值正确
  - grade 映射正确（A/B/C/D 边界）
  - recommendations 生成正确
- 集成测试：runScoreCommand 连接 mock server

### security-report.ts

- 单元测试：reviewConfig
  - allow 为 ["*"] → critical
  - SSRF off → critical
  - 注入 disabled → critical
  - 各 warning/info 级别正确
- 单元测试：analyzeAuditLog
  - 无日志文件 → null
  - 正常日志 → 正确统计
  - 空日志 → 正确处理
- 集成测试：generateSecurityReport 组合正确
- 集成测试：audit CLI 命令端到端

### 目标

- 3 个新文件各 15-20 个单元测试
- 2-3 个集成测试
- 总测试数从 395 增加到 ~460-470
- tsc --noEmit clean

---

## 约束

1. 不新增生产依赖（复用 micromatch、js-yaml）
2. TypeScript strict 模式，零 any
3. 纯函数优先（calculateRiskScore、reviewConfig、analyzeAuditLog 都是纯函数）
4. 评分逻辑独立可测，不依赖 CLI
5. 每个 CLI 命令可单独运行
6. audit --no-score 不需要连接 server（纯静态分析模式）

---

## 文件变更清单

### 新增

- `src/profiles.ts` — 3 个策略模板 + applyProfile 函数
- `src/risk-score.ts` — 风险评分纯函数 + CLI 入口
- `src/security-report.ts` — 配置审查 + 日志分析 + 报告生成
- `tests/profiles.test.ts` — 策略模板测试
- `tests/risk-score.test.ts` — 风险评分测试
- `tests/security-report.test.ts` — 安全报告测试

### 修改

- `src/cli.ts` — init 加 `--profile`，新增 `score` 和 `audit` 命令
- `README.md` — 新增策略模板 + 安全报告说明
- `CHANGELOG.md` — Phase 2 变更记录
- `AGENTS.md` — 更新项目状态
- `docs/ROADMAP.md` — Phase 2 标记完成
