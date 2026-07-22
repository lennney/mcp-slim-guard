/**
 * MCP Guard — JSON Schema 定义与原生校验器
 *
 * 定义 GuardConfig 的 JSON Schema（Draft-07 子集），
 * 并用纯 TS 实现轻量校验器（无额外依赖）。
 * 校验失败时返回具体路径错误（如 "rate_limit.default: expected string, number, or object"）。
 *
 * @module config-schema
 */

// ---------------------------------------------------------------------------
// JSON Schema 定义
// ---------------------------------------------------------------------------

/** 基础 JSON Schema 类型（Draft-07 常用子集） */
export interface SchemaNode {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode | SchemaNode[];
  additionalProperties?: boolean | SchemaNode;
  enum?: (string | number | boolean | null)[];
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  description?: string;
  default?: unknown;
  /** 自定义：允许的额外属性名模式（用于 servers 等） */
  patternProperties?: Record<string, SchemaNode>;
}

/**
 * GuardConfig 的 JSON Schema 定义。
 * 覆盖所有必选和可选字段，包括三种 rate_limit 格式。
 */
export const GUARD_CONFIG_SCHEMA: SchemaNode = {
  type: "object",
  required: ["version", "tools", "ssrf", "rate_limit", "injection_detection", "servers"],
  properties: {
    version: {
      type: "number",
      enum: [1],
      description: "配置文件版本（当前仅支持 1）",
    },
    compressor: {
      type: "object",
      required: ["enabled", "level"],
      properties: {
        enabled: { type: "boolean" },
        level: { type: "string", enum: ["off", "light", "normal", "tight", "extreme", "maximum"] },
      },
      additionalProperties: false,
      description: "Schema 压缩配置",
    },
    injection_detection: {
      type: "object",
      required: ["enabled"],
      properties: {
        enabled: { type: "boolean" },
        sensitivity: {
          type: "string",
          enum: ["low", "medium", "high"],
        },
        mode: {
          type: "string",
          enum: ["block", "log"],
          description: "block=拦截, log=仅记录",
        },
      },
      additionalProperties: false,
      description: "注入检测配置",
    },
    rate_limit: {
      type: "object",
      required: ["default"],
      properties: {
        default: {
          description: "默认速率限制。支持数字、对象或 '60/min' 格式字符串",
          oneOf: [
            { type: "number" },
            {
              type: "object",
              required: ["window_ms", "max_requests"],
              properties: {
                window_ms: { type: "number" },
                max_requests: { type: "number" },
              },
              additionalProperties: false,
            },
            { type: "string" },
          ],
        },
        per_agent: {
          type: "object",
          description: "按 agent ID 的速率限制覆盖",
          additionalProperties: {
            oneOf: [
              { type: "number" },
              {
                type: "object",
                required: ["window_ms", "max_requests"],
                properties: {
                  window_ms: { type: "number" },
                  max_requests: { type: "number" },
                },
                additionalProperties: false,
              },
              { type: "string" },
            ],
          },
        },
      },
      additionalProperties: false,
    },
    servers: {
      type: "object",
      description: "上游 MCP 服务器映射",
      additionalProperties: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          args: {
            type: "array",
            items: { type: "string" },
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    },
    ssrf: {
      type: "object",
      required: ["mode", "block_private_ips", "allow_domains", "block_domains"],
      properties: {
        mode: { type: "string", enum: ["block", "log", "off"] },
        block_private_ips: { type: "boolean" },
        allow_domains: { type: "array", items: { type: "string" } },
        block_domains: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    tools: {
      type: "object",
      required: ["allow", "deny"],
      properties: {
        allow: { type: "array", items: { type: "string" } },
        deny: { type: "array", items: { type: "string" } },
        param_restrictions: {
          type: "object",
          description: "按工具名的参数约束",
          additionalProperties: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                max_length: { type: "number" },
                required: { type: "boolean" },
                pattern: { type: "string" },
              },
              additionalProperties: false,
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: true,
};

// ---------------------------------------------------------------------------
// 校验结果类型
// ---------------------------------------------------------------------------

/** 单个字段的校验错误 */
export interface SchemaError {
  /** 错误路径（如 "rate_limit.default"） */
  path: string;
  /** 错误描述 */
  message: string;
}

// ---------------------------------------------------------------------------
// 原生校验器
// ---------------------------------------------------------------------------

/**
 * 校验值类型是否符合 schema 类型要求。
 * 支持单个类型和联合类型数组（如 ["string", "number"]）。
 */
function checkType(
  value: unknown,
  expected: string | string[] | undefined,
  path: string,
  errors: SchemaError[],
): void {
  if (expected === undefined) return;

  const types = Array.isArray(expected) ? expected : [expected];
  // special-case: "array" is "object" in typeof, so check Array.isArray
  const actual =
    types.includes("array") && Array.isArray(value)
      ? "array"
      : typeof value;

  // null is "object" in typeof but we want to catch it
  if (value === null) {
    // if "null" is explicitly allowed, skip
    if (!types.includes("null")) {
      errors.push({
        path,
        message: `expected ${types.join("|")}, got null`,
      });
    }
    return;
  }

  // "integer" is a JSON Schema type — treat as number with whole check
  const matched = types.some((t) => {
    if (t === "integer") return Number.isInteger(value);
    if (t === "number" && typeof value === "number") return true;
    if (t === "array") return Array.isArray(value);
    if (t === "object") return typeof value === "object" && !Array.isArray(value) && value !== null;
    return typeof value === t;
  });

  if (!matched) {
    errors.push({
      path,
      message: `expected ${types.join("|")}, got ${actual === "object" && Array.isArray(value) ? "array" : actual}`,
    });
  }
}

/**
 * 校验值是否符合 oneOf 约束。
 * 至少有一个变体通过校验即视为通过。
 */
function checkOneOf(
  value: unknown,
  oneOf: SchemaNode[],
  path: string,
  errors: SchemaError[],
): boolean {
  if (oneOf.length === 0) return false;

  for (const variant of oneOf) {
    const subErrors: SchemaError[] = [];
    validateNode(value, variant, path, subErrors);
    if (subErrors.length === 0) return true;
  }

  errors.push({
    path,
    message: `does not match any allowed format (oneOf)`,
  });
  return false;
}

/**
 * 递归校验节点值与 schema 定义。
 */
function validateNode(
  value: unknown,
  schema: SchemaNode,
  path: string,
  errors: SchemaError[],
): void {
  // --- type check ---
  if (schema.type) {
    checkType(value, schema.type, path, errors);
  }

  // --- enum check ---
  if (schema.enum !== undefined && value !== undefined && value !== null) {
    if (!schema.enum.includes(value as never)) {
      const allowed = schema.enum.map((e) => JSON.stringify(e)).join(", ");
      errors.push({
        path,
        message: `expected one of [${allowed}], got ${JSON.stringify(value)}`,
      });
    }
  }

  // --- oneOf check (for value-type polymorphism) ---
  if (schema.oneOf !== undefined && value !== undefined && value !== null) {
    checkOneOf(value, schema.oneOf, path, errors);
  }

  // --- anyOf check ---
  if (schema.anyOf !== undefined && value !== undefined && value !== null) {
    const passed = schema.anyOf.some((variant) => {
      const sub: SchemaError[] = [];
      validateNode(value, variant, path, sub);
      return sub.length === 0;
    });
    if (!passed) {
      errors.push({
        path,
        message: `does not match any allowed schema (anyOf)`,
      });
    }
  }

  // --- skip further checks for non-object/non-array primitives ---
  if (value === null || value === undefined) return;
  if (typeof value !== "object") return;

  // --- object checks ---
  if (!Array.isArray(value)) {
    const props = schema.properties;
    const required = schema.required;

    // required fields
    if (required) {
      for (const key of required) {
        if (!(key in value)) {
          errors.push({
            path: `${path}.${key}`,
            message: "required field is missing",
          });
        }
      }
    }

    // property validation
    if (props) {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        const propSchema = props[key];
        if (propSchema) {
          validateNode(val, propSchema, `${path}.${key}`, errors);
        }
        // if no propSchema, check additionalProperties below
      }
    }

    // additionalProperties
    const addl = schema.additionalProperties;
    if (addl === false && props) {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (!(key in props)) {
          // allow patternProperties keys
          if (schema.patternProperties) {
            const matched = Object.keys(schema.patternProperties).some((pattern) => {
              try {
                return new RegExp(`^${pattern}$`).test(key);
              } catch {
                return false;
              }
            });
            if (matched) continue;
          }
          errors.push({
            path: `${path}.${key}`,
            message: "unexpected field",
          });
        }
      }
    } else if (typeof addl === "object" && addl !== null) {
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        if (!props || !(key in props)) {
          validateNode(val, addl, `${path}.${key}`, errors);
        }
      }
    }

    // patternProperties
    if (schema.patternProperties) {
      for (const [pattern, propSchema] of Object.entries(schema.patternProperties)) {
        try {
          const re = new RegExp(`^${pattern}$`);
          for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            if (re.test(key)) {
              validateNode(val, propSchema, `${path}.${key}`, errors);
            }
          }
        } catch {
          // invalid regex pattern — skip
        }
      }
    }

    return;
  }

  // --- array checks ---
  if (schema.items) {
    const itemSchemas = Array.isArray(schema.items) ? schema.items : [schema.items];
    // tuple validation: validate each element against corresponding schema
    // for non-tuple, all items use the same schema
    for (let i = 0; i < (value as unknown[]).length; i++) {
      const itemSchema = itemSchemas.length === 1 ? itemSchemas[0] : itemSchemas[Math.min(i, itemSchemas.length - 1)];
      validateNode((value as unknown[])[i], itemSchema, `${path}[${i}]`, errors);
    }
  }
}

/**
 * 校验配置对象是否匹配 GuardConfig JSON Schema。
 *
 * @param config - 已解析的 YAML/JSON 配置对象
 * @returns 错误数组（空数组表示校验通过）
 */
export function validateConfigSchema(config: Record<string, unknown>): SchemaError[] {
  const errors: SchemaError[] = [];
  validateNode(config, GUARD_CONFIG_SCHEMA, "$", errors);
  return errors;
}

/**
 * 格式化 schema 校验错误为可读字符串（每行一条）。
 */
export function formatSchemaErrors(errors: SchemaError[]): string {
  if (errors.length === 0) return "";
  const lines = errors.map((e) => `  ❌ ${e.path}: ${e.message}`);
  return `Schema validation failed (${errors.length} error(s)):\n${lines.join("\n")}`;
}
