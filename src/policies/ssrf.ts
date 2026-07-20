/**
 * SSRF 防护策略
 *
 * 从工具参数中提取 URL，DNS 解析后检查是否为私有 IP，支持域名白名单/黑名单。
 *
 * @module policies/ssrf
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";
import micromatch from "micromatch";
import type { Policy, PolicyContext, PolicyResult } from "../types.js";
import type { SSRFConfig } from "../config-types.js";

const { isMatch } = micromatch;

// RFC 1918 + RFC 6598 + loopback + link-local
const PRIVATE_RANGES: Array<{ start: number; end: number }> = [
  { start: ipToInt("10.0.0.0"), end: ipToInt("10.255.255.255") },
  { start: ipToInt("172.16.0.0"), end: ipToInt("172.31.255.255") },
  { start: ipToInt("192.168.0.0"), end: ipToInt("192.168.255.255") },
  { start: ipToInt("100.64.0.0"), end: ipToInt("100.127.255.255") }, // CGNAT
  { start: ipToInt("127.0.0.0"), end: ipToInt("127.255.255.255") },
  { start: ipToInt("169.254.0.0"), end: ipToInt("169.254.255.255") },
  { start: ipToInt("0.0.0.0"), end: ipToInt("0.255.255.255") },
];

/**
 * SSRF 防护策略。
 *
 * 检查流程：
 * 1. `mode: "off"` 时放行所有请求
 * 2. 从参数中提取 URL（支持嵌套对象）
 * 3. 对每个 URL：黑名单 → 白名单（跳过 DNS）→ DNS 解析 → 私有 IP 检查
 */
export class SSRFPolicy implements Policy {
  readonly name = "ssrf";
  readonly phase = "tool_call" as const;

  constructor(private config: SSRFConfig) {}

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    if (this.config.mode === "off") return { allowed: true };

    // 从参数中提取所有 URL
    const urls = extractURLs(ctx.arguments);

    for (const url of urls) {
      try {
        const hostname = new URL(url).hostname;

        // 1. 域名黑名单检查
        if (this.isDomainBlocked(hostname)) {
          return {
            allowed: false,
            reason: `SSRF blocked: domain "${hostname}" is in block list`,
            policy: "ssrf",
          };
        }

        // 2. 域名白名单检查 — 命中则跳过该 URL
        if (this.isDomainAllowed(hostname)) continue;

        // 3. DNS 解析 → IP 检查
        const ips = await this.resolveHost(hostname);
        for (const ip of ips) {
          if (this.isPrivateIP(ip)) {
            return {
              allowed: false,
              reason: `SSRF blocked: "${url}" resolves to private IP ${ip}`,
              policy: "ssrf",
            };
          }
        }
      } catch {
        // 非合法 URL 或 DNS 解析失败 → 跳过（可能是文件名或其他参数）
      }
    }

    return { allowed: true };
  }

  private async resolveHost(hostname: string): Promise<string[]> {
    try {
      // 如果 hostname 本身是 IP，直接返回
      if (net.isIPv4(hostname)) return [hostname];
      if (net.isIPv6(hostname)) return [hostname];

      const records = await dns.resolve4(hostname);
      return records;
    } catch {
      return [];
    }
  }

  private isPrivateIP(ip: string): boolean {
    if (!this.config.block_private_ips) return false;
    const int = ipToInt(ip);
    return PRIVATE_RANGES.some((r) => int >= r.start && int <= r.end);
  }

  private isDomainBlocked(hostname: string): boolean {
    return this.config.block_domains.some((p) => isMatch(hostname, p));
  }

  private isDomainAllowed(hostname: string): boolean {
    return this.config.allow_domains.some((p) => isMatch(hostname, p));
  }
}

// --- Helpers ---

/**
 * 将 IPv4 字符串转为 32 位整数。
 * 用于范围比较，不做输入校验。
 */
export function ipToInt(ip: string): number {
  return (
    ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0
  );
}

/**
 * 从参数递归提取所有 HTTP/HTTPS URL。
 * 仅提取字符串值中的 URL，支持嵌套对象。
 */
export function extractURLs(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      const matches = value.match(/https?:\/\/[^\s"'<>]+/gi);
      if (matches) urls.push(...matches);
    } else if (typeof value === "object" && value !== null) {
      urls.push(...extractURLs(value as Record<string, unknown>));
    }
  }
  return urls;
}
