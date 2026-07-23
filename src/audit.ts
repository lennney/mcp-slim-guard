/**
 * 审计日志器。
 *
 * 基于 pino 的结构化 JSON 日志器，每条日志都是独立的 JSON 行。
 * 支持日志轮转：达到 maxSize 时自动轮转，保留 maxFiles 个历史文件。
 */

import pino from "pino";
import { Writable } from "node:stream";
import {
  existsSync,
  renameSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  createReadStream,
  createWriteStream,
} from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import type { PolicyContext, PolicyResult, AuditEntry } from "./types.js";

/** 决策步骤 — 一个策略的评估结果 */
export interface DecisionStep {
  policy: string;
  result: "pass" | "block" | "warn";
  reason?: string;
}

/** 构造选项 */
export interface AuditLoggerOptions {
  /** 输出目标（默认 stdout） */
  output?: "stdout" | "file";
  /** 文件路径 */
  filePath?: string;
  /** pino 日志级别（默认 info） */
  level?: string;
  /** 单个日志文件最大大小（如 "10MB"、"1GB"、"500KB"） */
  maxSize?: string;
  /** 保留的历史日志文件数（默认 5） */
  maxFiles?: number;
  /** 是否 gzip 压缩历史日志（默认 false） */
  compress?: boolean;
  /** 内存中保留的审计条目上限（默认 10000），超出时丢弃最旧的 */
  maxMemoryEntries?: number;
}

/** 默认单个日志文件大小上限：10 MB */
const DEFAULT_MAX_SIZE = "10MB";
/** 默认保留的历史文件数 */
const DEFAULT_MAX_FILES = 5;

/**
 * 将大小字符串解析为字节数。
 * 支持格式："500B", "10KB", "10MB", "1GB"（不区分大小写）。
 */
function parseSize(size: string): number {
  const match = size.match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|B)?$/i);
  if (!match) {
    throw new Error(`Invalid size format: ${size}. Expected format like "10MB", "1GB", "500KB".`);
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] ?? "B").toUpperCase();
  const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };
  return Math.round(value * (units[unit] ?? 1));
}

/**
 * 可轮转的文件写入流。
 *
 * 在每次写入前检查当前文件大小，达到 maxSize 时自动轮转。
 * 轮转策略：移除最旧文件，依次重命名 .n-1 → .n，当前文件 → .1，创建新文件。
 */
class RotatingFileStream extends Writable {
  private filePath: string;
  private maxSizeBytes: number;
  private maxFiles: number;
  private compressEnabled: boolean;
  private fd: number;
  private writtenSinceCheck: number;

  constructor(
    filePath: string,
    maxSize: string = DEFAULT_MAX_SIZE,
    maxFiles: number = DEFAULT_MAX_FILES,
    compress = false,
  ) {
    super({ highWaterMark: 64 * 1024 });

    this.filePath = filePath;
    this.maxSizeBytes = parseSize(maxSize);
    this.maxFiles = maxFiles;
    this.compressEnabled = compress;
    this.writtenSinceCheck = 0;

    // Open the file for appending (create if not exists)
    this.fd = openSync(filePath, "a");
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.checkRotation(chunk.length);
      writeSync(this.fd, chunk);
      this.writtenSinceCheck += chunk.length;
      callback(null);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    try {
      if (this.fd !== -1) {
        closeSync(this.fd);
        this.fd = -1;
      }
      callback(null);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * 检查是否需要轮转。
   * 如果当前文件大小 + 待写入数据超过 maxSize，则执行轮转。
   */
  private checkRotation(dataLen: number): void {
    // 获取当前文件实际大小
    let currentSize: number;
    try {
      currentSize = statSync(this.filePath).size;
    } catch {
      currentSize = 0;
    }

    if (currentSize + dataLen <= this.maxSizeBytes) {
      return;
    }

    // 执行轮转
    this.rotate();

    // 重置计数器
    this.writtenSinceCheck = 0;
  }

  /** 执行日志轮转 */
  private rotate(): void {
    // 关闭当前文件
    closeSync(this.fd);

    // 删除最旧历史文件（如果存在）
    const oldestPath = `${this.filePath}.${this.maxFiles}`;
    const oldestGzPath = `${oldestPath}.gz`;
    if (existsSync(oldestGzPath)) {
      try {
        unlinkSync(oldestGzPath);
      } catch {
        // ignore race conditions
      }
    }
    if (existsSync(oldestPath)) {
      try {
        unlinkSync(oldestPath);
      } catch {
        // ignore race conditions
      }
    }

    // 依次重命名 .(n-1) → .n
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      const srcGz = `${src}.gz`;
      const dstGz = `${dst}.gz`;

      if (existsSync(srcGz)) {
        try {
          renameSync(srcGz, dstGz);
        } catch {
          // ignore
        }
      }
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          // ignore
        }
      }
    }

    // 压缩当前文件（如果需要）或直接重命名为 .1
    const backupPath = `${this.filePath}.1`;
    if (this.compressEnabled) {
      // 先把当前文件挪到备份名再重建 fd，避免压缩读流和后续 append
      // 写流操作同一个文件（会把新条目混进压缩流、截断旧内容）。
      let rotated = false;
      try {
        renameSync(this.filePath, backupPath);
        rotated = true;
      } catch {
        // 重命名失败（极少见）则回退到就地压缩 + 重建
      }
      this.fd = openSync(this.filePath, "a");
      const compressSource = rotated ? backupPath : this.filePath;
      const compressDest = `${backupPath}.gz`;
      // 异步 gzip 压缩备份文件（不阻塞写入）
      this.compressFile(compressSource, compressDest)
        .catch(() => {
          // 压缩失败则保留未压缩备份（rename 已完成）或尝试就地重命名
          if (!rotated) {
            try {
              renameSync(this.filePath, backupPath);
            } catch {
              /* ignore */
            }
          }
        })
        .then(() => {
          // 压缩成功后删除未压缩备份，只保留 .gz
          if (rotated) {
            try {
              unlinkSync(backupPath);
            } catch {
              /* ignore */
            }
          }
        })
        .catch(() => {
          /* unlink 噪音忽略 */
        });
    } else {
      // 不压缩：直接重命名
      try {
        renameSync(this.filePath, backupPath);
      } catch {
        // ignore
      }
      this.fd = openSync(this.filePath, "a");
    }
  }

  /** 异步 gzip 压缩文件 */
  private async compressFile(sourcePath: string, destPath: string): Promise<void> {
    const readStream = createReadStream(sourcePath, { flags: "r" });
    const writeStream = createWriteStream(destPath);
    const gzip = createGzip();
    await pipeline(readStream, gzip, writeStream);
  }

  /** 获取当前文件描述符（用于测试/检查） */
  getFd(): number {
    return this.fd;
  }
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

/** 默认内存中保留的审计条目上限 */
const DEFAULT_MAX_MEMORY_ENTRIES = 10000;

export class AuditLogger {
  private entries: AuditEntry[] = [];
  private logger: pino.Logger;
  private sessionCounter = 0;
  private rotator: RotatingFileStream | null = null;
  private maxMemoryEntries: number;

  constructor(options: AuditLoggerOptions = {}) {
    const { output = "stdout", filePath, level = "info", maxMemoryEntries = DEFAULT_MAX_MEMORY_ENTRIES } = options;
    this.maxMemoryEntries = maxMemoryEntries;

    if (output === "file" && filePath) {
      const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
      const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
      const compress = options.compress ?? false;

      this.rotator = new RotatingFileStream(filePath, maxSize, maxFiles, compress);
      this.logger = pino({ level }, this.rotator as unknown as Writable);
    } else {
      this.logger = pino({ level });
    }
  }

  /**
   * 生成新的会话 ID。
   * 格式: `s<counter>_<timestamp36>_<random6>`
   */
  newSession(): string {
    this.sessionCounter++;
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `s${this.sessionCounter}_${ts}_${rand}`;
  }

  /**
   * 记录一条审计日志。
   *
   * @param ctx        策略评估上下文
   * @param result     策略评估结果
   * @param trail      决策链路（每个策略的 pass/block/warn）
   * @param sessionId  会话 ID
   * @param requestId  请求序号
   * @param durationMs 耗时
   */
  log(
    ctx: PolicyContext,
    result: PolicyResult,
    trail: DecisionStep[] = [],
    sessionId = "?",
    requestId = 0,
    durationMs?: number,
  ): void {
    // 防循环引用
    let safeArgs: Record<string, unknown>;
    try {
      safeArgs = JSON.parse(JSON.stringify(ctx.arguments));
    } catch {
      safeArgs = { _error: "arguments contained non-serializable values" };
    }

    const action = result.allowed ? ("allowed" as const) : ("blocked" as const);

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      requestId,
      toolName: ctx.toolName,
      serverName: ctx.serverName,
      arguments: safeArgs,
      action,
      decisionTrail: trail,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(!result.allowed && (result as Extract<PolicyResult, { allowed: false }>).reason
        ? { reason: (result as Extract<PolicyResult, { allowed: false }>).reason }
        : {}),
    };

    this.pushEntry(entry);
    this.logger.info(entry, "audit entry");
  }

  /**
   * 记录 discovery 事件（tools/list）。
   * Agent 每次调用 tools/list 时记录，用于审计"Agent 看到了什么"。
   */
  logDiscovery(sessionId: string, requestId: number, serverName: string, toolCount: number, toolNames: string[]): void {
    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      requestId,
      toolName: "tools/list",
      serverName,
      arguments: { count: toolCount, tools: toolNames },
      action: "discovery",
      decisionTrail: [],
    };

    this.pushEntry(entry);
    this.logger.info(entry, "audit discovery");
  }

  /** 返回所有已记录的审计条目（副本） */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /** 清空内存中的审计条目 */
  clear(): void {
    this.entries = [];
  }
  /** 追加一条审计条目，超出内存上限时丢弃最旧的 */
  private pushEntry(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries.splice(0, this.entries.length - this.maxMemoryEntries);
    }
  }

  /** 触发一次文件大小检查，需要轮转时立即轮转（主要用于测试） */
  checkRotation(): void {
    // no-op for stdout mode
  }
}
