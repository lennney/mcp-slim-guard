/**
 * Policy 接口 + 策略管道
 *
 * 定义 Policy 接口和 PolicyPipeline 类，支持串行执行策略管道，短路求值。
 *
 * @module policies/base
 */

import type { Policy, PolicyContext, PolicyResult } from "../types.js";

export type { Policy, PolicyContext, PolicyResult };

/** 决策步骤 */
export interface DecisionStep {
  policy: string;
  result: "pass" | "block" | "warn";
  reason?: string;
}

/**
 * 串行策略管道 — 按注册顺序执行，任一拒绝即停止。
 * 前一个策略的结果影响后一个（短路求值）。
 * 空管道返回 `{ allowed: true }`。
 */
export class PolicyPipeline {
  private policies: Policy[];

  constructor(policies: Policy[]) {
    this.policies = policies;
  }

  /**
   * 串行执行所有策略。
   * 按注册顺序遍历，任一策略返回 `allowed: false` 则立即短路返回。
   */
  async execute(ctx: PolicyContext): Promise<PolicyResult> {
    for (const policy of this.policies) {
      const result = await policy.check(ctx);
      if (!result.allowed) {
        return result;
      }
    }
    return { allowed: true };
  }

  /**
   * 串行执行所有策略，并返回完整的决策链路。
   * 用于审计追溯——可以看到每个策略的 pass/block 结果。
   */
  async executeWithTrail(
    ctx: PolicyContext,
  ): Promise<{ result: PolicyResult; trail: DecisionStep[] }> {
    const trail: DecisionStep[] = [];

    for (const policy of this.policies) {
      const result = await policy.check(ctx);
      if (!result.allowed) {
        trail.push({
          policy: policy.name,
          result: "block",
          reason: (result as Extract<PolicyResult, { allowed: false }>).reason,
        });
        return { result, trail };
      }
      // allowed but carrying a reason → warn (e.g. SSRF log mode hit),
      // so the audit trail records the observation instead of a plain pass.
      const warnReason = (result as Extract<PolicyResult, { allowed: true }>).reason;
      if (warnReason) {
        trail.push({ policy: policy.name, result: "warn", reason: warnReason });
      } else {
        trail.push({ policy: policy.name, result: "pass" });
      }
    }

    return { result: { allowed: true }, trail };
  }

  /** 获取已注册的策略名列表 */
  getPolicyNames(): string[] {
    return this.policies.map((p) => p.name);
  }
}
