import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ToolRegistry } from '@main/tools/ToolRegistry';
import type { ToolArgs, ToolResult } from '@main/tools/types';

/**
 * Why a chat action failed, written down so that the next failure on a real page can be traced instead of guessed at. Until now the only record of a
 * chat request was "Worked in a chat app: It did not work".
 *
 * PRIVATE BY CONSTRUCTION: an event carries ids, the kind of step, how long it took, whether it worked, how many tries, and a category from a short
 * list. It never carries a message, a contact name, a phone number or a page's words: every text field is cut down to plain tokens, and anything
 * that looks like a number of seven or more digits is removed, so that even a caller's mistake cannot write one.
 */
export interface ChatDiagEvent {
  /** The task this belongs to (a short random id). */
  readonly task: string;
  readonly op: string;
  /** The step's place in its task (1, 2, 3 …). */
  readonly step?: number;
  readonly from?: string;
  readonly to?: string;
  readonly ms?: number;
  readonly ok?: boolean;
  readonly attempts?: number;
  /** What kind of failure (browser_unavailable, chat_not_found, send_uncertain …), or what the page said in one word. */
  readonly category?: string;
  /** Whether the result the step was supposed to produce was actually seen on the page. */
  readonly observed?: boolean;
  /** Counts only (rows understood, rows not understood, how many chats were offered …): numbers under plain names, never anything from the page. */
  readonly counts?: Readonly<Record<string, number>>;
}

export interface ChatDiagnostics {
  record(event: ChatDiagEvent): void;
}

/** A text field as a plain token: letters, digits, and _ . : - only, no run of seven digits or more, at most 40 characters. */
export function plainToken(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_.:-]/g, '')
    .replace(/\d{7,}/g, '')
    .slice(0, 40);
}

/** The event with every text field made plain (what is written, and what the tests look at). */
export function scrub(event: ChatDiagEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { task: plainToken(event.task), op: plainToken(event.op) };
  for (const key of ['from', 'to', 'category'] as const) {
    const v = event[key];
    if (v !== undefined) out[key] = plainToken(v);
  }
  for (const key of ['step', 'ms', 'attempts'] as const) {
    const v = event[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.round(v);
  }
  for (const key of ['ok', 'observed'] as const) {
    const v = event[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  for (const [name, value] of Object.entries(event.counts ?? {}).slice(0, 8)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[`n_${plainToken(name).slice(0, 16)}`] = Math.max(0, Math.min(1_000_000, Math.round(value)));
  }
  return out;
}

/** Keeps the events in memory (for the tests, and for a run without a place to write). */
export class MemoryDiagnostics implements ChatDiagnostics {
  readonly events: Array<Record<string, string | number | boolean>> = [];
  record(event: ChatDiagEvent): void {
    this.events.push(scrub(event));
  }
}

/** Appends one JSON line per event to a file, and keeps the file small (the newest lines stay). A failure to write is never the chat's problem. */
export class FileDiagnostics implements ChatDiagnostics {
  constructor(
    private readonly path: string,
    private readonly maxBytes = 200_000,
    private readonly keepLines = 400,
    private readonly clock: () => number = Date.now,
  ) {}

  record(event: ChatDiagEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify({ at: new Date(this.clock()).toISOString(), ...scrub(event) })}\n`);
      if (statSync(this.path).size > this.maxBytes) {
        const lines = readFileSync(this.path, 'utf8').split('\n').filter((l) => l !== '');
        writeFileSync(this.path, `${lines.slice(-this.keepLines).join('\n')}\n`);
      }
    } catch {
      // diagnostics are a convenience
    }
  }

  /** The recent events, newest last (for a person looking at why something failed). */
  recent(limit = 100): string[] {
    try {
      return existsSync(this.path) ? readFileSync(this.path, 'utf8').split('\n').filter((l) => l !== '').slice(-limit) : [];
    } catch {
      return [];
    }
  }
}

/** The chat tools, whose results say how far a chat step got in one word (never a name). */
export const CHAT_TOOL_NAMES: ReadonlySet<string> = new Set(['find_chat', 'find_chat_files', 'live_chat', 'attach_file', 'share_file_to_chat', 'verify_sent', 'learn_chat_names']);

/** The words of a tool's `data.status` that are safe to write down: a fixed list, so a name can never get in through it. */
const STATUS_WORDS: ReadonlySet<string> = new Set([
  'opened', 'found', 'ambiguous', 'none', 'loading', 'needs_login', 'unverified', 'wrong_chat',
  'attached_not_sent', 'not_attached', 'not_confirmed', 'sent', 'failed', 'pending', 'unconfirmed', 'not_found', 'learned',
  'ready_to_send', 'not_opened', 'no_chat_open', 'picker_not_shown', 'picker_stuck', 'chat_stays_open', 'not_selected', 'stale_selection', 'send_failed', 'send_not_seen', 'not_available', 'cancelled', 'error',
]);

/** The kinds of failure a browser step can have, as words that are safe to write down (a code, never what the page said). */
const REASON_WORDS: ReadonlySet<string> = new Set([
  'timeout', 'not_connected', 'extension_error', 'ambiguous', 'open_website', 'no_file_input', 'type_not_accepted', 'needs_pairing', 'needs_reload', 'lost_connection', 'no_extension', 'no_browser', 'no_conversation_after_click', 'another_conversation_is_open',
]);

/**
 * How a tool call ended, in one word that is safe to write down (a status from the fixed list, else 'error' for a failure, else nothing). A failure says WHAT KIND:
 * a privacy switch that is off, a browser that is not reachable, a step that timed out — so that "it didn't work" is never all that is known afterwards.
 */
export function statusWord(result: ToolResult): string | undefined {
  const data = result.data;
  const status = data?.['status'];
  const reason = typeof data?.['reason'] === 'string' && REASON_WORDS.has(data['reason']) ? data['reason'] : typeof data?.['why'] === 'string' && REASON_WORDS.has(data['why']) ? data['why'] : undefined;
  if (data?.['communicationAccess'] === 'off') return 'communication_access_off';
  if (data?.['browserUnavailable'] === true) return reason !== undefined ? `browser_unavailable:${reason}` : 'browser_unavailable';
  if (typeof status === 'string' && STATUS_WORDS.has(status)) return status === 'error' && reason !== undefined ? `error:${reason}` : status;
  return result.ok ? undefined : reason !== undefined ? `error:${reason}` : 'error';
}

/**
 * Notes every chat tool call (the model's own as well as the fast layer's) as an event: which tool, how long, whether it worked, and its status
 * word. Wraps `invoke` the way the trace does, and passes every option on unchanged.
 */
export function diagnoseChatTools(registry: ToolRegistry, diagnostics: ChatDiagnostics): void {
  const run = registry.invoke.bind(registry);
  let sequence = 0;
  registry.invoke = async (name: string, args: ToolArgs, options?: { readonly lenient?: boolean }): Promise<ToolResult> => {
    if (!CHAT_TOOL_NAMES.has(name)) return run(name, args, options);
    const startedAt = Date.now();
    const result = await run(name, args, options);
    const status = result.data?.['status'];
    sequence += 1;
    diagnostics.record({
      task: 'tool',
      step: sequence,
      op: name,
      ms: Date.now() - startedAt,
      ok: result.ok,
      ...(statusWord(result) !== undefined ? { category: statusWord(result) as string } : {}),
    });
    return result;
  };
}
