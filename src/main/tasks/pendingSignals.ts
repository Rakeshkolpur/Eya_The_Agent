import { failureOf } from '@main/providers/ai/failure';
import type { PendingSignal } from '@shared/tasks';
import type { ToolArgs } from '@main/tools/types';

/**
 * The small judgements that decide whether a request that did not simply finish is kept as a task, and why. Pure, so they can be
 * tested without an engine.
 */

/** A request that asks for something to be done (as opposed to a question to be answered): only these are kept when the AI is out. */
const ACTION_START =
  /^(?:(?:please|can you|could you|will you|would you|kindly)\s+)*(?:send|message|text|tell|forward|share|attach|upload|download|open|go to|visit|find|search|look up|check|fill|log ?in|sign ?in|book|order|buy|pay|create|make|write|copy|move|rename|delete|remove|zip|compress|save|install|schedule|set|turn|change|update|read|show|get|bring|play|call|email|mail|print|scan|rotate|merge|split|convert|translate|summari[sz]e)\b/i;

export function looksLikeAction(text: string): boolean {
  return ACTION_START.test(text.trim());
}

/** Arguments that are what the person typed into a page or a message: never kept in the record of what was done. */
const PRIVATE_ARGS = new Set(['value', 'message', 'content', 'body', 'caption', 'password', 'code']);
const KEY_ARGS = ['url', 'path', 'name', 'query', 'label', 'text', 'app', 'folder', 'file'];

/** One short line for a step that worked, for the record kept with a task ("open_website https://web.whatsapp.com/"). Null when it says nothing. */
export function describeStep(name: string, args: ToolArgs): string | null {
  if (name === 'load_tools') return null;
  for (const key of KEY_ARGS) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '' && !(PRIVATE_ARGS.has(key) || (key === 'text' && /^(?:fill|type)/.test(name)))) {
      return `${name} ${v.trim().replace(/\s+/g, ' ').slice(0, 80)}`;
    }
  }
  return name;
}

/**
 * Whether the AI's failure is one that passes (its allowance is spent, it is busy or overloaded) and so is worth trying again, and when.
 * A failure of another kind (the network, a refused key) is not guessed at: the person is told, as before.
 */
export function retryForAIFailure(err: unknown): { readonly why: string; readonly retryAfterMs: number } | null {
  const info = failureOf(err);
  const MINUTE = 60_000;
  switch (info.kind) {
    case 'daily':
      return { why: "the AI is out of its allowance for now", retryAfterMs: Math.min(30 * MINUTE, Math.max(2 * MINUTE, info.retryAfterMs ?? 15 * MINUTE)) };
    case 'rate':
      return { why: 'the AI is busy for a moment', retryAfterMs: Math.min(5 * MINUTE, Math.max(20_000, info.retryAfterMs ?? MINUTE)) };
    case 'overloaded':
      return { why: 'the AI is overloaded just now', retryAfterMs: Math.max(30_000, info.retryAfterMs ?? MINUTE) };
    default:
      return null;
  }
}

/** A reply from the model that asks the person for a go-ahead (as opposed to "anything else?"). */
const GO_AHEAD = /\b(?:send|which|shall i|should i|want me to|go ahead|okay to|ok to|confirm|delete|remove|overwrite|sure|do you know)\b/i;

export function asksForGoAhead(spoken: string): boolean {
  const t = spoken.trim();
  return t.endsWith('?') && GO_AHEAD.test(t);
}

/** What the model is told when Eya is carrying a task on by herself after it was interrupted. */
export function resumeHint(resume: { readonly steps: readonly string[]; readonly note: string }): string {
  const done = resume.steps.length > 0 ? `Already done: ${resume.steps.join('; ')}.` : 'Nothing is known to be done yet.';
  return (
    'This is a task Eya is carrying on by herself because it was interrupted (' + (resume.note || 'it was slow or cut off') + '). ' +
    done + ' Look at the current state first (the page may already be where it needs to be), do not repeat a step that is already done, ' +
    'and never send, delete or pay anything the user has not said yes to: ask them first, as always.'
  );
}

export function retrySignal(why: string, retryAfterMs: number, steps: readonly string[]): PendingSignal {
  return { kind: 'retry', why, retryAfterMs, steps: [...steps] };
}
