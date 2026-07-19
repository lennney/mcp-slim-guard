/**
 * 工具白名单策略
 *
 * 实现工具名 glob 匹配（deny 优先），可选参数级限制。
 *
 * @module policies/whitelist
 */

import { isMatch } from "micromatch";
import type { Policy, PolicyContext, PolicyResult } from "../types.js";
import type { ToolsConfig, ParamRule } from "../config-types.js";

/**
 * 工具白名单策略。
 *
 * 检查流程：
 * 1. deny 优先 — 匹配任何 deny 模式即拒绝
 * 2. allow 检查 — 必须匹配至少一个 allow 模式
 * 3. 参数级限制 — max_length、required、pattern
 */
export class WhitelistPolicy implements Policy {
  readonly name = "whitelist";
  readonly phase = "tool_call" as const;

  constructor(private config: ToolsConfig) {}

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const { toolName } = ctx;
    const args = ctx.arguments;

    // 1. deny 优先 — 匹配任何 deny 模式即拒绝
    for (const pattern of this.config.deny) {
      if (isMatch(toolName, pattern)) {
        return {
          allowed: false,
          reason: `Tool "${toolName}" matches deny pattern "${pattern}"`,
          policy: "whitelist",
        };
      }
    }

    // 2. allow 检查 — 必须匹配至少一个 allow 模式
    const allowed = this.config.allow.some((pattern) =>
      isMatch(toolName, pattern),
    );
    if (!allowed) {
      return {
        allowed: false,
        reason: `Tool "${toolName}" not in allow list`,
        policy: "whitelist",
      };
    }

    // 3. 参数级限制
    const restrictions = this.config.param_restrictions?.[toolName];
    if (restrictions && args) {
      for (const [param, rule] of Object.entries(restrictions)) {
        const value = args[param];

        if (rule.required && (value === undefined || value === null)) {
          return {
            allowed: false,
            reason: `Required param "${param}" missing for tool "${toolName}"`,
            policy: "whitelist",
          };
        }

        if (
          rule.max_length !== undefined &&
          typeof value === "string" &&
          value.length > rule.max_length
        ) {
          return {
            allowed: false,
            reason: `Param "${param}" exceeds max length ${rule.max_length} for tool "${toolName}"`,
            policy: "whitelist",
          };
        }

        if (rule.pattern && typeof value === "string") {
          try {
            if (!new RegExp(rule.pattern).test(value)) {
              return {
                allowed: false,
                reason: `Param "${param}" does not match required pattern for tool "${toolName}"`,
                policy: "whitelist",
              };
            }
          } catch {
            // 无效正则表达式 — 放行（应记录警告）
          }
        }
      }
    }

    return { allowed: true };
  }
}
