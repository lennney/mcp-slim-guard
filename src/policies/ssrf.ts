/**
 * SSRF 防护策略
 *
 * 从工具参数中提取 URL，DNS 解析后检查是否为私有 IP，支持域名白名单/黑名单。
 * 内置 TTL 感知 DNS 缓存（默认 TTL 60s），减少 DNS 查询量和 DNS rebinding 窗口。
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

/** DNS 缓存条目 */
interface DNSCacheEntry {
  ips: string[];
  /** 绝对过期时间戳（毫秒） */
  expiresAt: number;
}

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

  /** DNS 缓存：hostname → { ips, expiresAt } */
  private dnsCache = new Map<string, DNSCacheEntry>();

  constructor(private config: SSRFConfig) {}

  async check(ctx: PolicyContext): Promise<PolicyResult> {
    const isBlock = this.config.mode === "block";
    const isLog = this.config.mode === "log";
    // off 模式完全跳过检测
    if (!isBlock && !isLog) return { allowed: true };

    // 从参数中提取所有 URL
    const urls = extractURLs(ctx.arguments);
    // log 模式下收集命中内网的观察结果（首个用于 warn reason）
    let loggedHit: string | null = null;

    for (const url of urls) {
      try {
        let hostname = new URL(url).hostname;

        // Strip brackets from IPv6 hostnames (URL.hostname includes them)
        if (hostname.startsWith("[") && hostname.endsWith("]")) {
          hostname = hostname.slice(1, -1);
        }

        // 1. 域名黑名单检查（block 模式拦截，log 模式记录）
        if (this.isDomainBlocked(hostname)) {
          if (isBlock) {
            return {
              allowed: false,
              reason: `SSRF blocked: domain "${hostname}" is in block list`,
              policy: "ssrf",
            };
          }
          loggedHit ??= `SSRF log: domain "${hostname}" is in block list`;
          continue;
        }

        // 2. 域名白名单检查 — 命中则跳过该 URL
        if (this.isDomainAllowed(hostname)) continue;

        // 3. DNS 解析 → IP 检查
        const ips = await this.resolveHost(hostname);
        for (const ip of ips) {
          if (this.isPrivateIP(ip)) {
            if (isBlock) {
              return {
                allowed: false,
                reason: `SSRF blocked: "${url}" resolves to private IP ${ip}`,
                policy: "ssrf",
              };
            }
            // log 模式：记录但不阻止
            loggedHit ??= `SSRF log: "${url}" resolves to private IP ${ip}`;
          }
        }
      } catch {
        // 非合法 URL 或 DNS 解析失败 → 跳过（可能是文件名或其他参数）
      }
    }

    // log 模式命中内网时返回 allowed + warn reason，让 audit trail 记录观察
    if (loggedHit) {
      return { allowed: true, reason: loggedHit };
    }
    return { allowed: true };
  }

  private async resolveHost(hostname: string): Promise<string[]> {
    try {
      // 如果 hostname 本身是 IP，直接返回
      if (net.isIPv4(hostname)) return [hostname];
      if (net.isIPv6(hostname)) return [hostname];

      // Normalize alternative IP representations (decimal/hex/octal)
      const normalized = normalizeToIPv4(hostname);
      if (normalized !== null) return [normalized];

      // 检查 DNS 缓存
      const cached = this.dnsCache.get(hostname);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.ips;
      }

      // DNS 解析（带 TTL）
      const records = await dns.resolve4(hostname, { ttl: true });
      const ips = records.map((r) => r.address);
      // 取最小 TTL（保守策略），至少 10 秒，最多 300 秒
      const ttl = Math.max(
        10,
        Math.min(
          300,
          records.reduce((min, r) => Math.min(min, r.ttl), Infinity),
        ),
      );
      this.dnsCache.set(hostname, {
        ips,
        expiresAt: Date.now() + ttl * 1000,
      });
      return ips;
    } catch {
      return [];
    }
  }

  private isPrivateIP(ip: string): boolean {
    if (!this.config.block_private_ips) return false;
    // IPv6 check
    if (net.isIPv6(ip)) return isPrivateIPv6(ip);
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
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// --- IPv6 Private Range Detection ---

/**
 * Check whether an IPv6 address belongs to a private/restricted range.
 * Handles abbreviated and IPv4-mapped forms.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = normalizeIPv6(ip);

  // Loopback: all zeros except last group is 0001
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;

  // Unspecified: all zeros
  if (normalized === "0000:0000:0000:0000:0000:0000:0000:0000") return true;

  // IPv4-mapped: check the embedded IPv4 address.
  // normalizeIPv6 preserves IPv4-mapped notation for accurate extraction.
  // Handle both dotted-decimal ("::ffff:127.0.0.1") and hex ("::ffff:7f00:1") forms.
  if (normalized.startsWith("::ffff:")) {
    const tail = normalized.slice(7);
    // Dotted-decimal form: "127.0.0.1"
    if (tail.includes(".")) {
      if (net.isIPv4(tail)) {
        const int = ipToInt(tail);
        return PRIVATE_RANGES.some((r) => int >= r.start && int <= r.end);
      }
      return false;
    }
    // Hex form: "7f00:1" or "7f00:0001" — extract IPv4 from last 32 bits
    const tailParts = tail.split(":");
    if (tailParts.length === 2) {
      const hi = parseInt(tailParts[0], 16);
      const lo = parseInt(tailParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const b0 = (hi >> 8) & 0xff;
        const b1 = hi & 0xff;
        const b2 = (lo >> 8) & 0xff;
        const b3 = lo & 0xff;
        const v4 = `${b0}.${b1}.${b2}.${b3}`;
        const int = ipToInt(v4);
        return PRIVATE_RANGES.some((r) => int >= r.start && int <= r.end);
      }
    }
    return false;
  }

  // Link-local: fe80::/10
  if (/^fe[89ab][0-9a-f]/i.test(normalized)) return true;

  // Unique local: fc00::/7
  if (/^fc[0-9a-f]/i.test(normalized) || /^fd[0-9a-f]/i.test(normalized)) return true;

  return false;
}

/**
 * Normalize an IPv6 address to its standard uncompressed form
 * (8 groups of 4 hex digits, lowercase). Accepts abbreviated, compressed,
 * and IPv4-mapped forms.
 */
function normalizeIPv6(ip: string): string {
  // Strip IPv6 zone ID (%eth0, %en0, etc.)
  const zoneIdx = ip.indexOf("%");
  const clean = ip.slice(0, zoneIdx !== -1 ? zoneIdx : ip.length);

  // Handle IPv4-mapped IPv6 — preserve the mapped part
  if (clean.toLowerCase().startsWith("::ffff:")) {
    return clean.toLowerCase();
  }

  // Expand "::" to ":" + the right number of zero groups
  if (clean.includes("::")) {
    const [left, right] = clean.split("::") as [string, string | undefined];
    const leftGroups = left ? left.split(":").filter(Boolean) : [];
    const rightGroups = right ? right.split(":").filter(Boolean) : [];
    const zeroCount = 8 - leftGroups.length - rightGroups.length;
    const zeros = Array(zeroCount).fill("0");
    const full = [...leftGroups, ...zeros, ...rightGroups];
    return full.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
  }

  // Already fully expanded? Just zero-pad and lowercase
  return clean
    .split(":")
    .map((g) => g.padStart(4, "0").toLowerCase())
    .join(":");
}

// --- Alternative IP Normalization ---

/**
 * Attempt to normalize a hostname that looks like an alternative IP
 * representation (decimal, hex, or dotted-octal) to standard dotted-decimal.
 * Returns null if the hostname is a regular domain.
 */
function normalizeToIPv4(hostname: string): string | null {
  // Decimal integer: "2130706433" → 127.0.0.1
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
    return null;
  }

  // Hex: "0x7f000001" → 127.0.0.1
  if (/^0x[0-9a-fA-F]+$/.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (!isNaN(n) && n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
    }
    return null;
  }

  // Dotted-octal: each octet is 0-prefixed octal like "0177.0.0.1"
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const parts = hostname.split(".");
    const isOctal = parts.every((p) => /^0\d+$/.test(p));
    if (isOctal) {
      const octets = parts.map((p) => parseInt(p, 8));
      if (octets.every((o) => o >= 0 && o <= 255)) {
        return octets.join(".");
      }
    }
  }

  // Shorthand IPv4: 1-3 octets, POSIX inet_aton semantics — missing
  // middle octets are filled with 0 and the last group stays last:
  //   "127.1" → 127.0.0.1   "10.0.1" → 10.0.0.1   "192.168.1" → 192.168.0.1
  // (Previously zeros were appended at the end, producing 127.1.0.0.)
  const shorthandMatch = /^\d+(?:\.\d+(?:\.\d+)?)?$/.exec(hostname);
  if (shorthandMatch) {
    const parts = hostname.split(".");
    const nums = parts.map((p) => parseInt(p, 10));
    if (nums.every((n) => n >= 0 && n <= 255)) {
      const result = [...nums];
      while (result.length < 4) result.splice(result.length - 1, 0, 0);
      return result.join(".");
    }
  }

  return null;
}

/**
 * 从参数递归提取所有支持的 URL 协议。
 * 当前支持：http://, https://, file://, ftp://, gopher://, dict://, ldap://, sftp://
 * 仅提取字符串值中的 URL，支持嵌套对象。
 */
export function extractURLs(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  // Match all supported protocols in one pass
  const urlRe = /(?:https?|file|ftp|gopher|dict|ldap|sftp):\/\/[^\s"'<>]+/gi;
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      const matches = value.match(urlRe);
      if (matches) urls.push(...matches);
    } else if (typeof value === "object" && value !== null) {
      urls.push(...extractURLs(value as Record<string, unknown>));
    }
  }
  return urls;
}
