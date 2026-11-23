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

/**
 * Whether a tool may be offered and run right now. A plugin supplies one: the tools of a plugin that is not installed, switched on, connected and allowed
 * are not shown to the AI and are refused if called, with the reason in words the person can act on. Every other tool is untouched.
 */
export interface ToolGuard {
  /** Null when the tool may be used (or is nobody's); otherwise why not. */
  blocked(name: string): { readonly plugin: string; readonly reason: string } | null;
  /** Told how every tool run ended (for the plugin card's "what went wrong lately"). */
  observe?(name: string, result: ToolResult): void;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private guard: ToolGuard | null = null;

  /** Sets the one guard (the plugin manager). Without it every registered tool is available, as before. */
  setGuard(guard: ToolGuard | null): void {
    this.guard = guard;
  }

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

  /**
   * `lenient`: an argument the tool does not have is set aside (and said so in the result) instead of the call being refused. Only the step loop of the
   * agent asks for it: a refusal there costs the model a whole step (about 12,000 tokens and several seconds) to send the same call again without the
   * argument (one step in sixteen of a traced court-site task). Anything else (the live voice bridge, the quick commands) keeps the strict rule.
   */
  async invoke(name: string, args: ToolArgs, options: { readonly lenient?: boolean } = {}): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      return { ok: false, summary: 'unknown tool', error: `No such tool: ${name}` };
    }
    const block = this.guard?.blocked(name) ?? null;
    if (block !== null) {
      log.info('a plugin tool was refused', { name, plugin: block.plugin });
      // (the reason is in words for the person; the AI is also told it is theirs to change and that there is no other way round)
      return { ok: false, summary: 'plugin not available', error: `${block.reason} This is the person's choice to change; tell them, and do not try another way.`, data: { pluginBlocked: true, plugin: block.plugin, forPerson: block.reason } };
    }
    // (a tool that asks for a yes (confirm, mode) stays strict: for those a misnamed argument is worth stopping on, and what is set aside can never make
    // anything happen that the tool's own rules do not allow)
    const strict = options.lenient !== true || tool.schema.requiresConfirmation === true || 'confirm' in tool.schema.args || 'mode' in tool.schema.args;
    const ignored = strict ? [] : Object.keys(args).filter((key) => !(key in tool.schema.args));
    const given = ignored.length === 0 ? args : Object.fromEntries(Object.entries(args).filter(([key]) => !ignored.includes(key)));
    try {
      validateArgs(tool.schema, given);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('tool arg validation failed', { name, error: message });
      return { ok: false, summary: 'invalid arguments', error: message };
    }
    if (ignored.length > 0) log.info('tool arguments it does not have were set aside', { name, ignored });
    try {
      const result = await tool.execute(given);
      try {
        this.guard?.observe?.(name, result);
      } catch {
        // (what is said about a tool's run is never a reason for the run to fail)
      }
      return ignored.length === 0 ? result : { ...result, data: { ...(result.data ?? {}), ignoredArgs: ignored } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tool execution threw', { name, error: message });
      return { ok: false, summary: 'tool failed', error: message };
    }
  }

  toAISchema(): readonly AISchemaTool[] {
    return [...this.tools.values()]
      .filter((tool) => this.guard?.blocked(tool.schema.name) == null)
      .map((tool) => {
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
