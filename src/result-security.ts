/**
 * Fixed-policy inspection for untrusted MCP tool results.
 *
 * The module reports compact findings without copying matched values into
 * metadata. Enforcement remains a separate obligation so detection is never
 * misrepresented as redaction or blocking.
 *
 * @module result-security
 */

import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ResultFindingKind = "credential" | "personal_data" | "untrusted_instruction";
export type ResultFindingSeverity = "high" | "medium";
export type ResultObligation = "redact-before-sharing" | "treat-as-untrusted-data";

export interface ResultSecurityFinding {
  kind: ResultFindingKind;
  severity: ResultFindingSeverity;
  path: string;
  evidence_sha256: string;
}

export interface ResultSecurityAssessment {
  inspected: true;
  findings: ResultSecurityFinding[];
  obligations: ResultObligation[];
}

interface DetectionRule {
  kind: ResultFindingKind;
  severity: ResultFindingSeverity;
  obligation: ResultObligation;
  pattern: RegExp;
}

const RULES: DetectionRule[] = [
  {
    kind: "credential",
    severity: "high",
    obligation: "redact-before-sharing",
    pattern:
      /\b(?:bearer\s+[a-z0-9._~+/=-]{12,}|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/giu,
  },
  {
    kind: "personal_data",
    severity: "medium",
    obligation: "redact-before-sharing",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  },
  {
    kind: "untrusted_instruction",
    severity: "medium",
    obligation: "treat-as-untrusted-data",
    pattern:
      /\b(?:ignore (?:all |any )?(?:previous|prior) instructions?|reveal (?:the )?system prompt|exfiltrate (?:the )?(?:secret|credential|token)s?)\b/giu,
  },
];

const SENSITIVE_KEY = /(?:^|_)(?:authorization|api_?key|access_?token|password|private_?key|secret)(?:$|_)/iu;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function childPath(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}.${key}`;
}

/**
 * Deep in-process Module. Its Interface is deliberately limited to assessment;
 * policy and result delivery remain local to their owning modules.
 */
export class ResultSecurityInspector {
  inspect(result: CallToolResult): ResultSecurityAssessment {
    const findings: ResultSecurityFinding[] = [];
    const obligations = new Set<ResultObligation>();
    const seen = new Set<string>();

    const add = (
      kind: ResultFindingKind,
      severity: ResultFindingSeverity,
      obligation: ResultObligation,
      path: string,
      evidence: string,
    ): void => {
      const findingKey = `${kind}:${path}:${digest(evidence)}`;
      if (seen.has(findingKey)) return;
      seen.add(findingKey);
      findings.push({ kind, severity, path, evidence_sha256: digest(evidence) });
      obligations.add(obligation);
    };

    const visit = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        for (const rule of RULES) {
          for (const match of value.matchAll(rule.pattern)) {
            add(rule.kind, rule.severity, rule.obligation, path, match[0]);
          }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, childPath(path, index)));
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, item] of Object.entries(value)) {
        const itemPath = childPath(path, key);
        if (SENSITIVE_KEY.test(key) && typeof item === "string" && item.length > 0) {
          add("credential", "high", "redact-before-sharing", itemPath, item);
        }
        visit(item, itemPath);
      }
    };

    visit(result, "$");
    return {
      inspected: true,
      findings,
      obligations: [...obligations].sort(),
    };
  }
}
