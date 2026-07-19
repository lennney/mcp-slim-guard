/**
 * Policy 接口 + 策略管道
 *
 * 定义 Policy 接口和 PolicyPipeline 类，支持串行执行策略管道，短路求值。
 *
 * @module policies/base
 */

import type { Policy, PolicyContext, PolicyResult } from "../types.js";

export type { Policy, PolicyContext, PolicyResult };

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

  /** 获取已注册的策略名列表 */
  getPolicyNames(): string[] {
    return this.policies.map((p) => p.name);
  }
}
