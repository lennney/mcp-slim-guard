/**
 * MCP Guard 运行时类型定义
 *
 * 定义策略管道、审计日志等运行时使用的类型。
 * 配置类型见 {@link module:config-types}。
 *
 * @module types
 */

import type { UpstreamServer } from "./config-types.js";

/**
 * 策略评估上下文。
 * 每次工具调用触发策略管道时创建。
 */
export interface PolicyContext {
  /** MCP 工具名（如 `search_repositories`） */
  toolName: string;
  /** 工具调用参数 */
  arguments: Record<string, unknown>;
  /** 上游 MCP 服务器名 */
  serverName: string;
  /** 发起调用的 AI 代理 ID（可选） */
  agentId?: string;
}

/**
 * 策略评估结果。
 * 使用可辨识联合类型：
 * - `{ allowed: true }`: 允许通过
 * - `{ allowed: false; reason: string; policy: string }`: 阻止
 */
export type PolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string; policy: string };

/**
 * 审计日志条目（完整可追溯）。
 */
export interface AuditEntry {
  /** 事件时间戳（ISO 8601） */
  timestamp: string;
  /** 会话 ID — 同一 Agent 连接内唯一，可跨工具调用关联 */
  sessionId: string;
  /** 请求序号 — 同一会话内递增，从 1 开始 */
  requestId: number;
  /** MCP 工具名（含前缀，如 github_search_repos）*/
  toolName: string;
  /** 上游 MCP 服务器名 */
  serverName: string;
  /** 工具调用参数 */
  arguments: Record<string, unknown>;
  /**
   * 事件类型。
   * - `"allowed"`: 工具调用通过所有策略
   * - `"blocked"`: 工具调用被策略拒绝
   * - `"discovery"`: tools/list 事件
   */
  action: "allowed" | "blocked" | "discovery";
  /**
   * 策略决策链路。
   * 按执行顺序记录每个策略的 pass/block，用于追溯"谁拦截的"。
   */
  decisionTrail: Array<{ policy: string; result: "pass" | "block" | "warn"; reason?: string }>;
  /** 原因（被阻止时） */
  reason?: string;
  /** 策略评估耗时（毫秒） */
  durationMs?: number;
}

/**
 * 策略检查函数签名。
 * @param ctx - 策略评估上下文
 * @returns 策略评估结果（支持异步）
 */
export type PolicyCheck = (ctx: PolicyContext) => PolicyResult | Promise<PolicyResult>;

/**
 * 安全策略定义。
 * 策略管道由一组按 {@link phase} 和声明的先后顺序串行执行。
 */
export interface Policy {
  /** 策略名（用于审计和调试） */
  name: string;
  /**
   * 策略阶段。
   * - `"tool_call"`: 工具调用前执行
   */
  phase: "tool_call" | "pre" | "post";
  /** 策略检查函数 */
  check: PolicyCheck;
}

/**
 * 用户已有的 MCP 配置结构（`.mcp.json` / `mcpServers`）。
 * 用于加载用户已有的 MCP 服务器定义并注入 Guard。
 */
export interface MCPConfig {
  /** MCP 服务器映射，key 为用户定义的服务器名 */
  mcpServers: Record<string, UpstreamServer>;
}

/**
 * 解析后的工具信息。
 * 将原始工具名映射到对应的服务器和 MCP 工具名。
 */
export interface ResolvedTool {
  /** 上游 MCP 服务器名 */
  serverName: string;
  /** MCP 工具原始名 */
  originalToolName: string;
}

/**
 * 策略管道配置。
 */
export interface PipelineConfig {
  /** 按执行顺序排列的策略列表 */
  policies: Policy[];
}
