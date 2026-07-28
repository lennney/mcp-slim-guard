import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type CompiledValidator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

export interface ToolInputValidation {
  valid: boolean;
  errorMessage?: string;
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
