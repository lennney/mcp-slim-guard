/** Shared v2 configuration types. Host-facing modes are intentionally absent. */

export interface StdioUpstreamServer {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface RemoteUpstreamServer {
  type?: "http" | "streamable-http" | "sse";
  url: string;
  headers?: Record<string, string>;
}

export type UpstreamServer = StdioUpstreamServer | RemoteUpstreamServer;

export interface ParamRule {
  max_length?: number;
  required?: boolean;
  pattern?: string;
}

export interface ToolsConfig {
  allow: string[];
  deny: string[];
  param_restrictions?: Record<string, Record<string, ParamRule>>;
}

export interface SSRFConfig {
  mode: "block" | "log" | "off";
  block_private_ips: boolean;
  allow_domains: string[];
  block_domains: string[];
}

export interface RateLimitConfig {
  default: number | { window_ms: number; max_requests: number } | string;
  per_agent?: Record<string, number | { window_ms: number; max_requests: number } | string>;
}

export interface InjectionConfig {
  enabled: boolean;
  sensitivity?: "low" | "medium" | "high";
  mode?: "block" | "log";
}

export interface CacheConfig {
  enabled: boolean;
  ttl: number;
  max_entries: number;
  allow: string[];
  deny: string[];
  ttl_per_tool?: Record<string, number>;
}

export interface AuditConfig {
  output: "stdout" | "file";
  filePath: string;
  maxSize?: string;
  maxFiles?: number;
  compress?: boolean;
  maxMemoryEntries?: number;
}

/**
 * Persistent configuration is shared across Hosts and deliberately contains
 * no presentation setting. Select `native`, `compact`, or `extreme` at
 * process start or in the Host installation plan.
 */
export interface GuardConfig {
  version: 2;
  tools: ToolsConfig;
  ssrf: SSRFConfig;
  rate_limit: RateLimitConfig;
  injection_detection: InjectionConfig;
  cache?: CacheConfig;
  audit: AuditConfig;
  servers: Record<string, UpstreamServer>;
}
