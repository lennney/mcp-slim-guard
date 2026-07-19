/**
 * MCP Guard 审计日志模块
 *
 * 提供 AuditLogger 类，使用 pino 记录结构化审计日志。
 * 支持 stdout 和 file 两种输出模式，维护内存日志条目列表供测试用。
 *
 * @module audit
 */

import pino from "pino";
import type { PolicyContext, PolicyResult, AuditEntry } from "./types.js";

/**
 * AuditLogger 构造选项。
 */
export interface AuditLoggerOptions {
  /** 输出目标，`"stdout"` 或 `"file"`（默认 `"stdout"`） */
  output?: "stdout" | "file";
  /** 输出文件路径（当 output="file" 时必须提供） */
  filePath?: string;
  /** pino 日志级别（默认 `"info"`） */
  level?: string;
}

/**
 * 审计日志器。
 *
 * 基于 pino 的结构化 JSON 日志器，同时维护内存中的审计条目列表
 * 用于测试和查询。每次工具调用评估后调用 {@link log} 记录审计条目。
 */
export class AuditLogger {
  private entries: AuditEntry[] = [];
  private logger: pino.Logger;

  /**
   * @param options - 日志器配置选项
   */
  constructor(options: AuditLoggerOptions = {}) {
    const { output = "stdout", filePath, level = "info" } = options;

    if (output === "file" && filePath) {
      this.logger = pino(
        { level },
        pino.destination({ dest: filePath, sync: true }),
      );
    } else {
      this.logger = pino({ level });
    }
  }

  /**
   * 记录一次策略评估的审计条目。
   *
   * @param ctx - 策略评估上下文
   * @param result - 策略评估结果
   * @param durationMs - 策略评估耗时（毫秒，可选）
   */
  log(ctx: PolicyContext, result: PolicyResult, durationMs?: number): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      toolName: ctx.toolName,
      serverName: ctx.serverName,
      arguments: ctx.arguments,
      action: result.allowed ? "allowed" : "blocked",
      ...(result.allowed === false ? { reason: result.reason } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };

    this.entries.push(entry);
    this.logger.info(entry, "audit entry");
  }

  /**
   * 返回所有已记录的审计条目（副本，不影响内部数组）。
   */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /**
   * 清空内存中的审计条目列表。
   */
  clear(): void {
    this.entries = [];
  }
}
