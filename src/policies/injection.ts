/**
 * 注入检测策略
 *
 * 检测工具调用参数中的注入攻击模式：
 * - Shell 注入（命令拼接、重定向）
 * - SQL 注入（经典注入串）
 * - Prompt 注入（角色劫持、指令覆盖）
 * - 路径遍历（../ 绕过）
 *
 * 灵敏度：
 * - low: 明显攻击模式（高置信度，低误报）
 * - medium: 日常攻击模式（默认）
 * - high: 激进检测（可能误报，但更安全）
 *
 * @module policies/injection
 */

import type { Policy, PolicyContext, PolicyResult } from "../types.js";
import type { InjectionConfig } from "../config-types.js";

interface InjectionPattern {
  pattern: RegExp;
  category: string;
  description: string;
  sensitivities: ("low" | "medium" | "high")[];
}

// Use RegExp constructor to avoid escaping issues with backslashes
function re(source: string, flags = "i"): RegExp {
  return new RegExp(source, flags);
}

const PATTERNS: InjectionPattern[] = [
  // ── Shell ──
  { pattern: re("\\b(?:curl|wget)\\s+.*\\|\\s*(?:bash|sh|zsh)"), category: "shell_injection", description: "pipe to shell", sensitivities: ["low"] },
  { pattern: re("\\b(?:rm\\s+-rf\\b|\\bdel\\s+/F\\b)"), category: "shell_injection", description: "destructive ops", sensitivities: ["low"] },
  { pattern: re("[;|&$()`]\\s*(?:bash|sh|zsh|python|node|ruby)"), category: "shell_injection", description: "cmd chaining", sensitivities: ["medium"] },
  { pattern: re("\\b(?:nc|netcat|ncat)\\s+-[lL]"), category: "shell_injection", description: "reverse shell", sensitivities: ["medium"] },
  { pattern: re("\\b(?:/etc/(?:passwd|shadow)|C:\\\\Windows\\\\System32)\\b"), category: "shell_injection", description: "sensitive files", sensitivities: ["high"] },

  // ── SQL ──
  { pattern: re("'.*\\bOR\\b.*'.*'="), category: "sql_injection", description: "classic OR", sensitivities: ["low"] },
  { pattern: re("\\b(?:DROP\\s+TABLE|ALTER\\s+TABLE|TRUNCATE\\s+TABLE)\\b"), category: "sql_injection", description: "DDL", sensitivities: ["low"] },
  { pattern: re("\\b(?:UNION\\s+(?:ALL\\s+)?SELECT)\\b"), category: "sql_injection", description: "UNION SELECT", sensitivities: ["medium"] },
  { pattern: re("(?:--\\s*$|;\\s*--)"), category: "sql_injection", description: "SQL comment", sensitivities: ["medium"] },

  // ── Prompt injection ──
  { pattern: re("\\b(?:ignore|forget|disregard)\\s+(?:all\\s+)?(?:previous|above|prior)\\s+(?:instructions?|directives?|commands?|context)\\b"), category: "prompt_injection", description: "ignore instructions", sensitivities: ["low"] },
  { pattern: re("\\b(?:you\\s+are\\s+now|you\\s+must|you\\s+will)\\b"), category: "prompt_injection", description: "role hijack", sensitivities: ["medium"] },
  { pattern: re("\\b(?:system\\s+prompt|hidden\\s+instruction|secret\\s+rule)\\b"), category: "prompt_injection", description: "prompt probing", sensitivities: ["medium"] },
  { pattern: re("\\b(?:DAN\\b|jailbreak\\b|bypass.*filter)\\b"), category: "prompt_injection", description: "jailbreak", sensitivities: ["high"] },

  // ── Path traversal ──
  { pattern: re("(?:\\.\\./|\\.\\.\\\\){2,}"), category: "path_traversal", description: "dir traversal", sensitivities: ["low"] },
  { pattern: re("%2e%2e%2[fF]"), category: "path_traversal", description: "URL-encoded ../", sensitivities: ["medium"] },
  { pattern: re("/proc/(?:self|stat|cpuinfo|meminfo)"), category: "path_traversal", description: "Linux /proc", sensitivities: ["high"] },
];

/** Recursively flatten args into a searchable string. */
function stringifyArgs(args: Record<string, unknown>, depth = 0): string {
  if (depth > 5) return "";
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (val === null || val === undefined) continue;
    if (typeof val === "string") parts.push(val);
    else if (typeof val === "number" || typeof val === "boolean") parts.push(String(val));
    else if (typeof val === "object") {
      try { parts.push(JSON.stringify(val)); } catch { /* skip */ }
    }
  }
  return parts.join(" ");
}

export class InjectionPolicy implements Policy {
  readonly name = "injection";
  readonly phase = "tool_call" as const;

  constructor(private config: InjectionConfig) {}

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    if (!this.config.enabled) return { allowed: true };

    const argString = stringifyArgs(ctx.arguments).trim();
    if (!argString) return { allowed: true };

    const sensitivity = this.config.sensitivity ?? "medium";
    const mode = this.config.mode ?? "block";
    const activeLevels = new Set<string>(["low"]);
    if (sensitivity !== "low") activeLevels.add("medium");
    if (sensitivity === "high") activeLevels.add("high");

    const hits: string[] = [];

    for (const p of PATTERNS) {
      if (!p.sensitivities.some(l => activeLevels.has(l))) continue;
      if (p.pattern.test(argString)) {
        hits.push(`${p.category}: ${p.description}`);
      }
    }

    if (hits.length > 0) {
      // mode=log: 只记录，不拦截
      if (mode === "log") {
        return { allowed: true };
      }
      // mode=block: 根据灵敏度和类别决定拦截
      const hasShell = hits.some(h => h.startsWith("shell_injection"));
      const hasSQL = hits.some(h => h.startsWith("sql_injection"));
      const hasPrompt = hits.some(h => h.startsWith("prompt_injection"));
      const hasPathTraversal = hits.some(h => h.startsWith("path_traversal"));

      if (sensitivity === "high") {
        // high: 拦截所有类别
        return { allowed: false, reason: `Injection detected: ${hits.join("; ")}`, policy: "injection" };
      }
      // low/medium: 至少拦截 shell + sql
      if (hasShell || hasSQL) {
        return { allowed: false, reason: `Injection detected: ${hits.join("; ")}`, policy: "injection" };
      }
      // prompt 和 path_traversal 在 low/medium 下只记录不拦截
    }

    return { allowed: true };
  }
}
