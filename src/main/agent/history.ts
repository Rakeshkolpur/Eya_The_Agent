import type { AIChatMessage } from '@main/providers/ai/AIProvider';
import type { ToolResult } from '@main/tools/types';

/**
 * Two things that keep a request that takes several steps cheap and quick.
 *
 * 1. Every step the whole conversation of the request is sent again, and a page that was read can be 12,000 characters. A page that was read two
 *    steps ago is no longer the one in front of Eya (a click or a new address replaced it), so its text is cut down to what is still of use: where it
 *    was, what it was called, and how it ended. The latest results stay whole.
 * 2. Tools that only read, and do not depend on each other or on a page, can be run together when the model asks for several in one turn (reading five
 *    attached files took five times as long as reading one).
 */

/** Tools whose results are a page or its text: the bulk of what is sent again at every step. Other results (a list of files, a path) are never cut down. */
const PAGE_TOOLS: ReadonlySet<string> = new Set([
  'open_website',
  'find_and_open_website',
  'read_page',
  'inspect_page',
  'click_on_page',
  'fill_on_page',
  'find_on_page',
  'scroll_page',
  'download_from_site',
]);

/** The small facts of a page result that stay when its text is cut. */
const KEEP_KEYS = ['url', 'target', 'title', 'path', 'name', 'download', 'needsUser', 'userAction', 'reason', 'status'] as const;

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** A page result cut down to what is still of use, or the text itself when it is already small or is not one of ours. */
export function shortenPageResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return `${content.slice(0, maxChars)} …[an earlier result, cut from ${content.length} characters to save time]`;
  }
  const result = asRecord(parsed);
  if (result === undefined) return content.slice(0, maxChars);
  const data = asRecord(result['data']);
  const kept: Record<string, unknown> = {};
  if (data !== undefined) {
    for (const key of KEEP_KEYS) if (data[key] !== undefined && JSON.stringify(data[key]).length <= 300) kept[key] = data[key];
    const page = asRecord(data['currentPage']);
    if (page !== undefined) kept['currentPage'] = { url: page['url'], title: page['title'] };
  }
  return JSON.stringify({
    ok: result['ok'],
    summary: result['summary'],
    ...(typeof result['error'] === 'string' ? { error: result['error'].slice(0, 400) } : {}),
    ...(Object.keys(kept).length > 0 ? { data: kept } : {}),
    shortened: `An earlier page result, cut from ${content.length} characters to save time. If you need what the page said, read it again.`,
  });
}

/**
 * The messages as they are sent to the model: every result except the latest `keepFull` ones that came from a page tool is cut down. The conversation
 * itself (what was asked, what Eya said, what was called) is never touched, and neither is any result of another tool.
 */
export function shortenOlderResults(messages: readonly AIChatMessage[], options: { readonly keepFull?: number; readonly maxChars?: number } = {}): readonly AIChatMessage[] {
  const keepFull = options.keepFull ?? 2;
  const maxChars = options.maxChars ?? 1800;
  const toolAt: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'tool') toolAt.push(i);
  });
  const old = new Set(toolAt.slice(0, Math.max(0, toolAt.length - keepFull)));
  if (old.size === 0) return messages;
  let changed = false;
  const out = messages.map((m, i) => {
    if (!old.has(i) || m.name === undefined || !PAGE_TOOLS.has(m.name) || m.content.length <= maxChars) return m;
    changed = true;
    return { ...m, content: shortenPageResult(m.content, maxChars) };
  });
  return changed ? out : messages;
}

/** Tools that only read, need no page and do not depend on one another: when the model asks for several in one turn they are run together. */
export const PARALLEL_SAFE: ReadonlySet<string> = new Set([
  'analyze_document',
  'read_file',
  'find_file',
  'find_folder',
  'list_windows',
  'clipboard_read',
  'get_volume',
  'get_brightness',
  'list_memories',
  'list_routines',
  'get_recycle_bin_count',
  'get_recycle_bin_items',
  'communication_access_status',
  'word_status',
  'browser_status',
]);

/** At most this many at once: a few AI-backed reads together are quick, but a burst of them would trip the provider's own per-minute limit. */
export const MAX_PARALLEL_TOOLS = 4;

/**
 * Whether a turn's calls can be run together: more than one, and every one of them a read that does not depend on a page or another call.
 */
export function canRunTogether(calls: ReadonlyArray<{ readonly name: string }>): boolean {
  return calls.length > 1 && calls.every((c) => PARALLEL_SAFE.has(c.name));
}

/**
 * Starts the calls now (at most `limit` running at a time, in the order given) and returns one promise per call, in the same order, so the results
 * can be taken one by one exactly as if they had run one after another. A call that fails gives its failure as a result; it never stops the others.
 */
export function startTogether(runs: ReadonlyArray<() => Promise<ToolResult>>, limit: number = MAX_PARALLEL_TOOLS): Array<Promise<ToolResult>> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    const go = waiting.shift();
    if (go !== undefined) go();
  };
  return runs.map(
    (run) =>
      new Promise<ToolResult>((resolve) => {
        const start = (): void => {
          running += 1;
          run()
            .catch((err: unknown): ToolResult => ({ ok: false, summary: 'tool failed', error: err instanceof Error ? err.message : String(err) }))
            .then((result) => {
              running -= 1;
              resolve(result);
              next();
            });
        };
        if (running < limit) start();
        else waiting.push(start);
      }),
  );
}
