import { rootLogger } from '@main/logging/logger';
import type { Tool, ToolArgs, ToolResult } from './types';
import { validateArgs } from './types';

export interface AISchemaTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, { type: string; description?: string; enum?: readonly string[] }>>;
    readonly required?: readonly string[];
  };
}

const log = rootLogger.child('tools');

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.schema.name)) {
      throw new Error(`Tool '${tool.schema.name}' already registered`);
    }
    this.tools.set(tool.schema.name, tool);
    log.debug('registered tool', { name: tool.schema.name });
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** What to show the user while this tool runs. */
  statusFor(name: string): string {
    return this.tools.get(name)?.schema.status ?? 'Working on it…';
  }

  list(): readonly Tool[] {
    return [...this.tools.values()];
  }

  async invoke(name: string, args: ToolArgs): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { ok: false, summary: 'unknown tool', error: `No such tool: ${name}` };
    }
    try {
      validateArgs(tool.schema, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('tool arg validation failed', { name, error: message });
      return { ok: false, summary: 'invalid arguments', error: message };
    }
    try {
      return await tool.execute(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tool execution threw', { name, error: message });
      return { ok: false, summary: 'tool failed', error: message };
    }
  }

  toAISchema(): readonly AISchemaTool[] {
    return [...this.tools.values()].map((tool) => {
      const properties: Record<string, { type: string; description?: string; enum?: readonly string[] }> = {};
      const required: string[] = [];
      for (const [key, spec] of Object.entries(tool.schema.args)) {
        const prop: { type: string; description?: string; enum?: readonly string[] } = {
          type: spec.type,
        };
        if (spec.description !== undefined) prop.description = spec.description;
        if (spec.enum !== undefined) prop.enum = spec.enum;
        properties[key] = prop;
        if (spec.required === true) required.push(key);
      }
      return {
        name: tool.schema.name,
        description: tool.schema.description,
        parameters: {
          type: 'object' as const,
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
      };
    });
  }
}
