import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

type CompiledValidator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

export interface ToolInputValidation {
  valid: boolean;
  errorMessage?: string;
}

const ARGUMENT_VALIDATION_KIND = "mcp-slim-guard/argument-validation";

/**
 * Build a repairable Tool error without including the submitted arguments.
 * Schema errors name the rule that failed, but never echo potentially secret
 * argument values back to the model, audit output, or downstream Host.
 */
export function invalidToolArgumentsResult(tool: string, errorMessage?: string): CallToolResult {
  const schemaError = errorMessage ?? "inputSchema validation failed";
  return {
    content: [
      {
        type: "text",
        text: `Arguments for ${tool} do not match its input schema. Correct the arguments and retry.`,
      },
    ],
    isError: true,
    structuredContent: {
      kind: ARGUMENT_VALIDATION_KIND,
      error: "input_schema_invalid",
      tool,
      schema_error: schemaError,
      upstream_invoked: false,
      retry: "Correct the arguments to match the advertised input schema, then retry.",
    },
  };
}

/** True only for the local validation result that is guaranteed not to have reached an upstream Tool. */
export function isInvalidToolArgumentsResult(result: CallToolResult): boolean {
  const structured = result.structuredContent;
  return (
    result.isError === true &&
    typeof structured === "object" &&
    structured !== null &&
    !Array.isArray(structured) &&
    structured.kind === ARGUMENT_VALIDATION_KIND &&
    structured.upstream_invoked === false
  );
}

/**
 * Compiles imported Tool schemas once and validates calls without changing the
 * argument object that Slim Guard forwards upstream.
 */
export class ToolInputValidator {
  private readonly provider = new AjvJsonSchemaValidator();
  private readonly compiled = new WeakMap<object, CompiledValidator>();

  validate(tool: Tool, args: Record<string, unknown> | undefined): ToolInputValidation {
    const schema = tool.inputSchema;
    let validator = this.compiled.get(schema);
    if (!validator) {
      validator = this.provider.getValidator(schema);
      this.compiled.set(schema, validator);
    }

    const result = validator(args ?? {});
    return result.valid ? { valid: true } : { valid: false, errorMessage: result.errorMessage };
  }
}
