export type ToolArgValue = string | number | boolean | null;

export interface ToolArgSchema {
  readonly type: 'string' | 'number' | 'boolean';
  readonly required?: boolean;
  readonly enum?: readonly string[];
  readonly description?: string;
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly args: Readonly<Record<string, ToolArgSchema>>;
  readonly requiresConfirmation?: boolean;
  /** Shown in the panel while the tool runs, e.g. "Searching your files…". */
  readonly status?: string;
}

export type ToolArgs = Readonly<Record<string, ToolArgValue>>;

export interface ToolResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface Tool {
  readonly schema: ToolSchema;
  execute(args: ToolArgs): Promise<ToolResult>;
}

export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export function validateArgs(schema: ToolSchema, args: ToolArgs): void {
  for (const [key, spec] of Object.entries(schema.args)) {
    const value = args[key];
    if (value === undefined || value === null) {
      if (spec.required === true) {
        throw new ToolValidationError(`Missing required arg '${key}' for tool '${schema.name}'`);
      }
      continue;
    }
    if (typeof value !== spec.type) {
      throw new ToolValidationError(
        `Arg '${key}' expected ${spec.type}, got ${typeof value}`,
      );
    }
    if (spec.enum !== undefined && typeof value === 'string' && !spec.enum.includes(value)) {
      throw new ToolValidationError(
        `Arg '${key}' must be one of [${spec.enum.join(', ')}]`,
      );
    }
  }
  for (const key of Object.keys(args)) {
    if (!(key in schema.args)) {
      throw new ToolValidationError(`Unknown arg '${key}' for tool '${schema.name}'`);
    }
  }
}
