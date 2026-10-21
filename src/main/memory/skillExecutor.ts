import type { ToolArgs, ToolResult } from '@main/tools/types';
import { expandPlaceholders, PlaceholderError } from './placeholders';
import type { SkillDetail, SkillStep } from './types';

/** What the executor needs from the tools: the ordinary registry — the same tools, the same rules, as when a model asks for them. */
export interface ToolInvoker {
  invoke(name: string, args: ToolArgs): Promise<ToolResult>;
}

/**
 * blocked: the browser tool's loop guard refused a step because the same click or fill, from the same page, has just been done
 * several times in a row. That says nothing is wrong with the routine, and the normal agent would hit the same wall.
 */
export type FailureKind = 'tool' | 'not_found' | 'verification' | 'download' | 'setup' | 'blocked';

export type RoutineOutcome =
  | { readonly status: 'done'; readonly completed: number; readonly total: number; readonly spoken: string }
  /** A step needs the user's say-so (a confirmation, a sign-in, a check only they can pass). The routine stopped; nothing was forced. */
  | { readonly status: 'needs_user'; readonly atStep: number; readonly completed: number; readonly total: number; readonly question: string; readonly step: SkillStep }
  | { readonly status: 'failed'; readonly atStep: number; readonly completed: number; readonly total: number; readonly kind: FailureKind; readonly reason: string; readonly step: SkillStep };

export interface ExecutorOptions {
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Called as each step starts, to show progress. */
  readonly onStep?: (index: number, step: SkillStep) => void;
  /** The most time the whole routine may take. */
  readonly budgetMs?: number;
  /** How long to wait, and how many times to look again, for a page that is still loading when a check is made. */
  readonly checkWaitsMs?: readonly number[];
}

const DEFAULT_BUDGET_MS = 180_000;
const DEFAULT_CHECK_WAITS = [700, 1500];

type Page = Record<string, unknown>;

/** Every piece of text on a page result, joined — what a "page contains" check looks through. */
function pageText(page: Page): string {
  const parts: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const x of v.slice(0, 400)) walk(x, depth + 1);
    else if (typeof v === 'object' && v !== null) for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(page, 0);
  return parts.join('\n').toLowerCase();
}

const contains = (haystack: string, needle: string): boolean => haystack.includes(needle.toLowerCase().replace(/\s+/g, ' ').trim());

function currentPageOf(result: ToolResult): Page | undefined {
  const page = result.data?.['currentPage'];
  return typeof page === 'object' && page !== null && !Array.isArray(page) ? (page as Page) : undefined;
}

/** A tool that stopped to ask the user (a confirmation, a sign-in or check only they can do). The question to put to them, or null. */
export function questionFromTool(result: ToolResult): string | null {
  const d = result.data ?? {};
  if (d['status'] === 'permission_required') {
    const reason = typeof d['reason'] === 'string' ? d['reason'] : '';
    return typeof d['question'] === 'string' ? d['question'] : reason !== '' ? reason : (result.error ?? 'It needs your say-so first.');
  }
  if (result.summary === 'needs confirmation') return typeof d['question'] === 'string' ? d['question'] : (result.error ?? 'It needs your say-so first.');
  if (d['needsUser'] === true) return typeof d['userAction'] === 'string' ? d['userAction'] : (result.error ?? 'It needs you to do something first.');
  return null;
}

/**
 * Carries out a saved routine, one step at a time, through Eya's ordinary tools.
 *
 *  - It never passes `confirm`, so anything the tools would ask the user about (sending, deleting, buying, replacing a file) still
 *    asks: the routine stops at that step and hands the question over. A saved routine can never skip a safety rule.
 *  - After each step it checks what the step promised (the tool succeeded, the text was found, the download is on disk, and the
 *    step's own check — "the page says Cause List" — holds). A failed check stops the routine; it never carries on blindly.
 *  - It uses what is on the page (a link's text, a field's label), never screen positions, and it does no thinking of its own:
 *    anything unexpected is handed back, for the caller to give to the normal reasoning agent.
 */
export class SkillExecutor {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly tools: ToolInvoker,
    private readonly options: ExecutorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  async run(skill: Pick<SkillDetail, 'steps'>): Promise<RoutineOutcome> {
    const steps = skill.steps;
    const total = steps.length;
    const started = Date.now();
    let page: Page | undefined;
    let lastDownload: string | undefined;
    let savedTo: string | undefined;
    let completed = 0;

    const failed = (index: number, kind: FailureKind, reason: string): RoutineOutcome => ({ status: 'failed', atStep: index + 1, completed, total, kind, reason, step: steps[index] as SkillStep });

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i] as SkillStep;
      if (Date.now() - started > (this.options.budgetMs ?? DEFAULT_BUDGET_MS)) return failed(i, 'tool', 'The routine ran out of time.');
      this.options.onStep?.(i, step);

      let target: string;
      let value: string;
      let verifyText: string;
      try {
        const ctx = { now: this.now(), lastDownload };
        target = expandPlaceholders(step.target, ctx);
        value = expandPlaceholders(step.value, ctx);
        verifyText = expandPlaceholders(step.verifyText, ctx);
      } catch (err) {
        return failed(i, 'setup', err instanceof PlaceholderError ? err.message : String(err));
      }

      if (step.action !== 'verify') {
        const call = this.toolFor(step, target, value, lastDownload);
        if ('error' in call) return failed(i, 'setup', call.error);
        const result = await this.tools.invoke(call.name, call.args);

        const question = questionFromTool(result);
        if (question !== null) return { status: 'needs_user', atStep: i + 1, completed, total, question, step };
        if (!result.ok) {
          if (result.data?.['loopDetected'] === true) return failed(i, 'blocked', 'The same step was just done several times in a row.');
          const notFound = result.summary === 'not found' || /isn't visible|No field matching/i.test(result.error ?? '');
          return failed(i, notFound ? 'not_found' : 'tool', result.error ?? result.summary);
        }
        const seen = currentPageOf(result);
        if (seen !== undefined) page = seen;

        if (step.action === 'find_text') {
          const matches = result.data?.['matches'];
          const mentions = result.data?.['pageTextMentions'];
          if (!(Array.isArray(matches) && matches.length > 0) && !(Array.isArray(mentions) && mentions.length > 0)) return failed(i, 'not_found', `"${target}" is not on the page.`);
        }
        if (step.action === 'download_file') {
          const download = result.data?.['download'] as { verified?: boolean; name?: string } | undefined;
          const path = result.data?.['path'];
          if (download?.verified !== true || typeof path !== 'string') return failed(i, 'download', `Clicking "${target}" did not produce a downloaded file.`);
          lastDownload = path;
        }
        if (step.action === 'save_file') savedTo = target;
      }

      // The step's own check, with a short wait or two for a page still loading.
      if (step.verifyKind !== 'none') {
        let ok = this.checks(step.verifyKind, verifyText, page);
        const waits = this.options.checkWaitsMs ?? DEFAULT_CHECK_WAITS;
        for (let w = 0; !ok && w < waits.length; w += 1) {
          await this.sleep(waits[w] as number);
          const look = await this.tools.invoke('inspect_page', {});
          if (look.ok) page = currentPageOf(look) ?? page;
          ok = this.checks(step.verifyKind, verifyText, page);
        }
        if (!ok) return failed(i, 'verification', `After step ${i + 1} I expected ${describeCheck(step.verifyKind, verifyText)}, and it was not there.`);
      }
      completed += 1;
    }

    const downloadName = lastDownload?.split(/[\\/]/).pop();
    const spoken = savedTo !== undefined && downloadName !== undefined ? `Done. ${downloadName} is in your ${savedTo} folder.` : downloadName !== undefined ? `Done. I downloaded ${downloadName}.` : 'Done.';
    return { status: 'done', completed, total, spoken };
  }

  private checks(kind: SkillStep['verifyKind'], text: string, page: Page | undefined): boolean {
    if (page === undefined) return false;
    switch (kind) {
      case 'page_contains':
        return contains(pageText(page), text);
      case 'url_contains':
        return typeof page['url'] === 'string' && contains(page['url'].toLowerCase(), text);
      case 'title_contains':
        return typeof page['title'] === 'string' && contains(page['title'].toLowerCase(), text);
      default:
        return true;
    }
  }

  /** Which of Eya's tools does this step use, and with what? (Never with `confirm` or `mode`.) */
  private toolFor(step: SkillStep, target: string, value: string, lastDownload: string | undefined): { name: string; args: ToolArgs } | { error: string } {
    switch (step.action) {
      case 'open_url':
        return { name: 'open_website', args: { url: target, ...(value === 'chrome' || value === 'edge' ? { browser: value } : {}) } };
      case 'open_app':
        return { name: 'open_application', args: { name: target } };
      case 'find_text':
        return { name: 'find_on_page', args: { query: target } };
      case 'click_text':
      case 'download_file':
        return { name: 'click_on_page', args: { text: target } };
      case 'type_text':
      case 'select_option':
        return { name: 'fill_on_page', args: { label: target, value, ...(step.submit ? { submit: true } : {}) } };
      case 'save_file': {
        const source = value !== '' ? value : lastDownload;
        if (source === undefined) return { error: 'There is no downloaded file to save: a "save file" step needs a download step before it.' };
        return { name: 'move_file', args: { sourcePath: source, destinationFolder: target } };
      }
      default:
        return { error: `"${step.action}" is not something a routine can do.` };
    }
  }
}

export function describeCheck(kind: SkillStep['verifyKind'], text: string): string {
  switch (kind) {
    case 'page_contains':
      return `the page to contain "${text}"`;
    case 'url_contains':
      return `the address to contain "${text}"`;
    case 'title_contains':
      return `the page title to contain "${text}"`;
    default:
      return 'the step to work';
  }
}
