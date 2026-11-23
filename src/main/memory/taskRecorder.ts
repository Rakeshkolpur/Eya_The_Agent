import { createHash } from 'node:crypto';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import type { CandidateStore } from './CandidateStore';
import { looksSensitive, normalizeUtterance } from './normalize';
import { templatizeDates } from './placeholders';
import type { NewStep } from './types';

/**
 * Watches what Eya does for a request, and notices when the same thing has been done successfully several times — so she can ask
 * "You've done this several times. Would you like me to save it as a routine?". It records a step only for the small set of actions
 * a routine can repeat (opening a site or an app, clicking by text, typing into a field, downloading). Anything else in a task — a
 * file deleted, a message sent, a screenshot, a power action — means the task is NOT learned from, and nothing about a chat app,
 * a sign-in, a sensitive field or a link carrying a token is ever recorded. What is kept is a signature and the steps, never a conversation.
 */

/** Tools that only look or help (they change nothing), so they neither make a task learnable nor spoil it. */
const NEUTRAL_TOOLS = new Set([
  'inspect_page', 'find_on_page', 'read_page', 'scroll_page', 'web_search', 'list_browser_tabs', 'browser_status', 'communication_access_status',
  'remember', 'forget_memory', 'list_memories', 'list_routines', 'save_routine', 'delete_routine', 'update_routine', 'answer_routine_suggestion',
]);

const SECRET_QUERY = /token|key|auth|sess|sid|code|secret|sig|pass|jwt|otp|credential|bearer|ticket|nonce|csrf|xsrf/i;
const SENSITIVE_LABEL = /pass(word|code)?|pin\b|otp|cvv|cvc|card|secret|verification|security code/i;

export type SuggestionKind = 'save' | 'update';

export interface TaskSuggestion {
  readonly kind: SuggestionKind;
  readonly signature: string;
  readonly steps: readonly NewStep[];
  readonly phrases: ReadonlyArray<{ readonly norm: string; readonly text: string }>;
  /** How many successful runs of exactly these steps have been seen. */
  readonly count: number;
  /** For an update: the routine this would improve. */
  readonly replacing?: { readonly skillId: number; readonly name: string };
}

export interface RecordedTask {
  readonly request: string;
  readonly steps: readonly NewStep[];
  readonly signature: string;
}

export interface BeginOptions {
  /** This request was answered by running a saved routine: it is not something new to learn. */
  readonly viaRoutine?: boolean;
  /** A routine just failed and the normal agent is doing the job: if it succeeds, the better workflow can replace the old one. */
  readonly replacing?: { readonly skillId: number; readonly name: string; readonly signature: string };
  /** For a replacement: the steps of the routine that DID work before it stopped, so the agent's finish makes a whole workflow, not half of one. */
  readonly prefix?: readonly NewStep[];
}

export interface RecorderDeps {
  readonly candidates: CandidateStore;
  /** True if a saved routine already does exactly these steps. */
  readonly isSaved: (signature: string) => boolean;
  /** True for a step that involves something private (a chat app), which is never learned from. */
  readonly isPrivate?: (step: NewStep) => boolean;
  readonly now?: () => Date;
}

/** Offer to save after this many identical successful runs (and again at every multiple of it, unless declined). */
export const SUGGEST_EVERY = 3;

const GENERIC_WORDS = new Set(['home', 'page', 'welcome', 'search', 'login', 'sign', 'menu', 'contact', 'about', 'official', 'website', 'portal', 'india', 'main', 'content', 'skip', 'next', 'previous', 'close', 'open', 'click', 'here', 'more', 'view', 'back', 'cookies', 'accept', 'privacy', 'terms', 'with', 'from', 'this', 'that', 'your', 'have', 'will', 'also']);

export function signatureOf(steps: readonly NewStep[]): string {
  const lines = steps.map((s) => `${s.action}|${normalizeUtterance(s.target)}|${normalizeUtterance(s.value)}|${s.submit ? 1 : 0}`);
  return createHash('sha1').update(lines.join('\n')).digest('hex').slice(0, 20);
}

/** The words of a page's title and headings worth resting a "the page says…" check on. */
export function significantWords(page: Record<string, unknown> | undefined): string[] {
  if (page === undefined) return [];
  const parts: string[] = [];
  if (typeof page['title'] === 'string') parts.push(page['title']);
  if (Array.isArray(page['headings'])) for (const h of page['headings'].slice(0, 6)) if (typeof h === 'string') parts.push(h);
  const seen = new Set<string>();
  for (const w of normalizeUtterance(parts.join(' ')).split(' ')) {
    if (w.length >= 5 && !/\d/.test(w) && !GENERIC_WORDS.has(w)) seen.add(w);
  }
  return [...seen].slice(0, 12);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function cleanUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  for (const [k, v] of u.searchParams) if (SECRET_QUERY.test(k) || v.length > 40) return null;
  u.hash = '';
  return u.toString();
}

interface Current {
  request: string;
  steps: NewStep[];
  unrecordable: boolean;
  viaRoutine: boolean;
  replacing: BeginOptions['replacing'];
  lastPage: Record<string, unknown> | undefined;
}

export class TaskRecorder {
  private current: Current | null = null;
  private last: RecordedTask | null = null;

  constructor(private readonly deps: RecorderDeps) {}

  begin(request: string, options: BeginOptions = {}): void {
    this.current = { request, steps: [...(options.prefix ?? [])], unrecordable: false, viaRoutine: options.viaRoutine === true, replacing: options.replacing, lastPage: undefined };
  }

  /**
   * A saved routine, run by the model through run_routine, failed partway in this task, and the model is finishing the job itself:
   * treat what it does from here as a candidate replacement for that routine (the steps that worked first, then the model's own).
   */
  adoptFailure(replacing: NonNullable<BeginOptions['replacing']>, prefix: readonly NewStep[]): void {
    const cur = this.current;
    if (cur === null) return;
    cur.replacing = replacing;
    cur.steps = [...prefix, ...cur.steps];
    cur.viaRoutine = false;
  }

  /** Notes one tool call and what came of it. A failed call is not a step (the task may have tried again another way). */
  observe(toolName: string, args: ToolArgs, result: ToolResult): void {
    const cur = this.current;
    if (cur === null) return;
    if (toolName === 'run_routine') {
      cur.viaRoutine = true;
      return;
    }
    const page = result.data?.['currentPage'];
    if (typeof page === 'object' && page !== null && !Array.isArray(page)) cur.lastPage = page as Record<string, unknown>;
    if (NEUTRAL_TOOLS.has(toolName)) return;
    if (!result.ok) return;

    const step = this.stepFrom(toolName, args, result);
    if (step === null) {
      cur.unrecordable = true; // something a routine cannot repeat, or must never learn
      return;
    }
    if (step === 'skip') return;
    if (this.deps.isPrivate?.(step) === true) {
      cur.unrecordable = true;
      return;
    }
    const prev = cur.steps[cur.steps.length - 1];
    if (prev !== undefined && prev.action === step.action && prev.target === step.target && prev.value === step.value && prev.submit === step.submit) return; // the same step twice in a row
    cur.steps.push(step);
  }

  /**
   * The task is over. If it worked, and it is something a routine could repeat, count it — and say whether it is time to offer to
   * save it (or, if it replaced a routine that just failed, to offer to update that one).
   */
  finish(ok: boolean): TaskSuggestion | null {
    const cur = this.current;
    this.current = null;
    if (cur === null || !ok || cur.unrecordable || cur.viaRoutine) return null;
    if (cur.steps.length === 0) return null;
    // "open notepad" alone is already instant; a lone application is not worth a routine.
    if (cur.steps.length === 1 && cur.steps[0]?.action === 'open_app') return null;
    const request = cur.request.trim();
    if (request === '' || request.length > 200 || looksSensitive(request) || /\d{6,}|@/.test(request)) return null;

    const now = this.deps.now?.() ?? new Date();
    const steps = cur.steps.map((s) => ({ ...s, target: templatizeDates(s.target, now), value: templatizeDates(s.value, now) }));
    const signature = signatureOf(steps);
    const norm = normalizeUtterance(request);
    const words = significantWords(cur.lastPage);
    const candidate = this.deps.candidates.observe(signature, steps, norm === '' ? null : { norm, text: request.slice(0, 120) }, words, now.toISOString());
    const finalSteps = withChecks(steps, candidate.count >= 2 ? candidate.commonWords : []);
    this.last = { request, steps: finalSteps, signature };
    this.deps.candidates.prune(now);

    if (candidate.declined) return null;
    const phrases = candidate.phrases.map((p) => ({ norm: p.norm, text: p.text }));
    if (cur.replacing !== undefined) {
      if (cur.replacing.signature === signature) return null; // it was the same workflow after all (a passing hiccup)
      return { kind: 'update', signature, steps: finalSteps, phrases, count: candidate.count, replacing: { skillId: cur.replacing.skillId, name: cur.replacing.name } };
    }
    if (this.deps.isSaved(signature)) return null;
    if (candidate.count >= SUGGEST_EVERY && candidate.count % SUGGEST_EVERY === 0) return { kind: 'save', signature, steps: finalSteps, phrases, count: candidate.count };
    return null;
  }

  /** The most recent successful, learnable task — what "save this as a routine" saves. */
  lastTask(): RecordedTask | null {
    return this.last;
  }

  forgetLast(): void {
    this.last = null;
  }

  /** "No thanks" / "don't remember this": never offer this one again. */
  decline(signature: string): void {
    this.deps.candidates.decline(signature);
    if (this.last?.signature === signature) this.last = null;
  }

  private stepFrom(toolName: string, args: ToolArgs, result: ToolResult): NewStep | 'skip' | null {
    const text = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '');
    switch (toolName) {
      case 'open_website': {
        if (args['isolated'] === true) return null;
        const url = cleanUrl(text('url'));
        if (url === null) return null;
        const browser = args['browser'] === 'chrome' || args['browser'] === 'edge' ? (args['browser'] as string) : '';
        return { action: 'open_url', target: url, value: browser, submit: false, verifyKind: 'url_contains', verifyText: hostOf(url), };
      }
      case 'open_application': {
        const name = text('name');
        return name === '' ? null : { action: 'open_app', target: name, value: '', submit: false, verifyKind: 'none', verifyText: '' };
      }
      case 'click_on_page': {
        const target = text('text');
        if (target === '') return null;
        const download = result.data?.['download'] as { verified?: boolean } | undefined;
        return { action: download?.verified === true ? 'download_file' : 'click_text', target, value: '', submit: false, verifyKind: 'none', verifyText: '' };
      }
      case 'fill_on_page': {
        const label = text('label');
        const value = text('value');
        if (label === '' || value === '' || SENSITIVE_LABEL.test(label) || looksSensitive(value)) return null;
        return { action: 'type_text', target: label, value, submit: args['submit'] === true, verifyKind: 'none', verifyText: '' };
      }
      default:
        return null;
    }
  }
}

/**
 * Gives a learned workflow its checks: opening a site checks the address is that site (already set), and the last step checks the
 * page says a word every run's final page said. Words only from runs that all agreed — so a check can't be pinned on something that
 * changes each time (a date, a headline).
 */
export function withChecks(steps: readonly NewStep[], commonWords: readonly string[]): NewStep[] {
  const out = steps.map((s) => ({ ...s }));
  const last = out[out.length - 1];
  if (last !== undefined && last.verifyKind === 'none' && commonWords.length > 0) {
    const best = [...commonWords].sort((a, b) => b.length - a.length)[0] as string;
    out[out.length - 1] = { ...last, verifyKind: 'page_contains', verifyText: best };
  }
  return out;
}
