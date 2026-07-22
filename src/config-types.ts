/**
 * MCP Guard 配置类型定义
 *
 * 定义所有配置文件（YAML/JSON）中使用的类型。
 * 根配置为 {@link GuardConfig}，版本 v1。
 *
 * @module config-types
 */

/**
 * 上游 MCP 服务器定义。
 * 映射到用户 `.mcp.json` / `mcpServers` 中的单个条目。
 */
export interface UpstreamServer {
  /** MCP 服务器启动命令（可执行文件路径） */
  command: string;
  /** 命令行参数 */
  args: string[];
  /** 环境变量 */
  env: Record<string, string>;
}

/**
 * 单个工具参数的约束规则。
 */
export interface ParamRule {
  /** 参数最大长度（字符数） */
  max_length?: number;
  /** 参数是否为必需 */
  required?: boolean;
  /** 参数值的正则校验模式 */
  pattern?: string;
}

/**
 * 工具访问控制配置。
 */
export interface ToolsConfig {
  /**
   * 允许的工具名 glob 模式列表。
   * 工具名格式：`serverName_toolName`（例如 `github_search_repositories`）。
   * 空数组表示不设限制。
   */
  allow: string[];
  /**
   * 拒绝的工具名 glob 模式列表。
   * 优先级高于 `allow`。
   */
  deny: string[];
  /**
   * 按工具名的参数约束。
   * key 为带前缀的工具名（精确匹配，如 `github_search_repositories`），
   * value 为按参数名的规则映射。注意：当前按精确工具名匹配，不支持 glob。
   */
  param_restrictions?: Record<string, Record<string, ParamRule>>;
}

/**
 * SSRF 防护配置。
 */
export interface SSRFConfig {
  /**
   * SSRF 防护模式。
   * - `"block"`: 阻止所有对内网地址的请求
   * - `"log"`: 放行但在审计 trail 中标记为 warn（命中内网/黑名单时记录，不阻止）
   * - `"off"`: 完全禁用 SSRF 防护
   */
  mode: "block" | "log" | "off";
  /** 是否阻止请求私有 IP 地址（127.0.0.1、10.x.x.x、192.168.x.x 等） */
  block_private_ips: boolean;
  /** 允许访问的域名白名单（即使匹配私有 IP 也放行） */
  allow_domains: string[];
  /** 阻止访问的域名黑名单 */
  block_domains: string[];
}

/**
 * 速率限制配置。
 * 支持三种格式：
 * - 数字（每秒请求数）
 * - 带窗口和上限的对象
 * - 字符串如 "60/min"、"10/second"、"100/hour"
 */
export interface RateLimitConfig {
  /** 默认速率限制。数字、对象或字符串格式。 */
  default: number | { window_ms: number; max_requests: number } | string;
  /**
   * 按 agent ID 的速率限制覆盖。
   * key 为 agent ID，value 格式同 `default`。
   */
  per_agent?: Record<string, number | { window_ms: number; max_requests: number } | string>;
}

/**
 * 注入检测配置。
 *
 * 默认模式为 "block"，检测到 Shell/SQL/Prompt/路径遍历注入时直接拦截。
 * - mode="log": 仅记录不拦截，用于调优灵敏度
 * - sensitivity="low": 仅明显攻击
 * - sensitivity="medium" (默认): shell + sql 拦截
 * - sensitivity="high": 所有类别拦截
 */
export interface InjectionConfig {
  /** 是否启用注入检测 */
  enabled: boolean;
  /**
   * 检测灵敏度。
   * - "low": 仅检测明显注入
   * - "medium": 中等灵敏度（默认）
   * - "high": 高灵敏度（可能增加误报率）
   */
  sensitivity?: "low" | "medium" | "high";
  /**
   * 注入检测模式。
   * - "block": 检测到注入时直接拦截（默认）
   * - "log": 仅记录日志，不拦截
   */
  mode?: "block" | "log";
}

/**
 * MCP Guard 根配置。
 * 所有配置文件的顶层结构。
 */
export interface GuardConfig {
  /** 配置文件版本（当前仅支持 `1`） */
  version: 1;
  /** 工具访问控制配置 */
  tools: ToolsConfig;
  /** SSRF 防护配置 */
  ssrf: SSRFConfig;
  /** 速率限制配置 */
  rate_limit: RateLimitConfig;
  /** 注入检测配置（P2 预留） */
  injection_detection: InjectionConfig;
  /** Schema 压缩配置 */
  compressor: CompressorConfig;
  /** 请求缓存配置（可选，默认 disabled） */
  cache?: CacheConfig;
  /** 审计日志配置 */
  audit: AuditConfig;
  /**
   * 上游 MCP 服务器映射。
   * key 为服务器名，value 为 {@link UpstreamServer}。
   */
  servers: Record<string, UpstreamServer>;
}

/** Compression levels for schema compression */
export type CompressionLevel = "off" | "light" | "normal" | "tight" | "extreme" | "maximum";

/**
 * Schema 压缩配置 — 无损压缩，通过 wrapper tools 或 schema transformation。
 *
 * 低级别 (off/light/normal) 使用 wrapper tools 模式:
 *   - off: 不回压缩，返回全部工具
 *   - light: 3 个 wrapper (list_tools + get_tool_schema + invoke_tool)
 *   - normal: 2 个 wrapper (get_tool_schema + invoke_tool)，原名 tight
 *
 * 高级别 (extreme/maximum) 使用 schema transformation 模式:
 *   - extreme: 工具保留真名，inputSchema 只保留 type/required/enum
 *   - maximum: 工具保留真名，inputSchema 替换为 {type:"object"}，描述嵌入 TS 签名
 *
 * 借鉴 slim-mcp (Joncik91) 的 schema transformation 思路。
 */
export interface CompressorConfig {
  /** 是否启用压缩 */
  enabled: boolean;
  /**
   * 压缩等级:
   * - `"off"`: 透传，无压缩
   * - `"light"`: 3 个 wrapper，含工具发现
   * - `"normal"`: 2 个 wrapper，无工具发现（原 `"tight"`）
   * - `"tight"`: `"normal"` 的别名（已弃用，建议改用 `"normal"`）
   * - `"extreme"`: 工具保留真名，剥离参数描述，保留 type/required/enum
   * - `"maximum"`: 工具保留真名，inputSchema 最小化，描述嵌入 TS 函数签名
   */
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

/**
 * 请求缓存配置 — 只读工具调用结果内存缓存，TTL + LRU。
 */
export interface CacheConfig {
  /** 是否启用缓存。默认 false。 */
  enabled: boolean;
  /** 全局默认 TTL（秒）。默认 30。 */
  ttl: number;
  /** LRU 容量上限。默认 500。 */
  max_entries: number;
  /** 强制可缓存的工具名 glob（空 = 模式推断）。 */
  allow: string[];
  /** 强制不可缓存的工具名 glob。 */
  deny: string[];
  /** 按工具名精确覆盖 TTL（秒）。key 为带前缀的工具名。 */
  ttl_per_tool?: Record<string, number>;
}

/**
 * 审计日志配置。
 */
export interface AuditConfig {
  /** 输出目标 */
  output: "stdout" | "file";
  /** 审计日志文件路径（output 为 file 时有效） */
  filePath: string;
  /**
   * 每个日志文件的最大大小。
   * 格式：数字 + 单位，如 "10MB"、"1GB"、"500KB"。
   * 达到此大小时触发轮转。
   */
  maxSize?: string;
  /** 保留的历史日志文件数（默认 5）。轮转后的文件为 .1、.2、...、.{maxFiles}。 */
  maxFiles?: number;
  /** 是否压缩历史日志文件（gzip），默认 false。 */
  compress?: boolean;
  /** 内存中保留的审计条目上限（默认 10000），超出时丢弃最旧的 */
  maxMemoryEntries?: number;
}
