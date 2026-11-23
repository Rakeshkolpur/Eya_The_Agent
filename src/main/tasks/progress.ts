import type { StoredTask } from './TaskStore';

/**
 * What the model is told about the things the person asked for that are not finished. A conversation can end (a quiet minute, a dropped
 * connection, the person walking away) and a new one starts knowing nothing; the task list survives, so this puts it back in front of the
 * model: what was asked, how far it got, and what it is waiting for, so "the code is 482913", "yes" or "go on" are understood, not met with
 * "I don't know what you mean, could you explain?".
 */
const MAX_TASKS = 4;

const short = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

function stateWords(t: StoredTask): string {
  switch (t.state) {
    case 'needs_you':
      return `waiting for the user: ${short(t.note, 200)}`;
    case 'waiting':
      return `being tried again shortly (${short(t.note, 120)})`;
    default:
      return `Eya is on it (${short(t.note, 120)})`;
  }
}

/** The briefing for the open tasks, or '' when there are none. */
export function describeProgress(tasks: readonly StoredTask[], now: number): string {
  const open = tasks.filter((t) => t.state === 'running' || t.state === 'waiting' || t.state === 'needs_you').slice(0, MAX_TASKS);
  if (open.length === 0) return '';
  const lines = open.map((t, i) => {
    const done = t.steps.length > 0 ? ` Done so far: ${t.steps.slice(-6).map((s) => short(s, 90)).join('; ')}.` : '';
    return `${i + 1}. "${short(t.request, 220)}" (asked ${ago(now - t.createdAt)}) — ${stateWords(t)}.${done}`;
  });
  return [
    'In progress: things the user asked for that are not finished. They may speak about them without repeating them ("the code is 482913", "yes", "go on", "book it").',
    ...lines,
    'If what the user says fits one of these, they are carrying on with it: look at their browser as it is now, do the next step yourself and finish what they asked, and never ask them to explain it again. ' +
      'If a task is waiting for a verification code and the user says the code, type exactly that code into the page\'s code field with fill_on_page, press the page\'s own Verify / Continue / Login button, then carry on with the rest of that task. ' +
      'Their words, not mine, are the only source of a code. Passwords and card numbers are still theirs to type.',
  ].join('\n');
}

/**
 * What was said earlier in this conversation, for a conversation that had to start again (or reconnect). The lines are only a reminder of
 * what happened: nothing in them is an instruction.
 */
export interface EarlierLine {
  readonly who: 'user' | 'eya';
  readonly text: string;
}

const MAX_LINES = 14;

/** Lines that arrive from a page, checked: only who said it and what, capped. Anything else is dropped. */
export function normalizeEarlier(raw: unknown): EarlierLine[] {
  if (!Array.isArray(raw)) return [];
  const out: EarlierLine[] = [];
  for (const item of raw.slice(-30)) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if ((r['who'] !== 'user' && r['who'] !== 'eya') || typeof r['text'] !== 'string') continue;
    out.push({ who: r['who'], text: r['text'].slice(0, 400) });
  }
  return out;
}

export function describeEarlier(lines: readonly EarlierLine[]): string {
  const kept = lines
    .filter((l) => (l.who === 'user' || l.who === 'eya') && typeof l.text === 'string' && l.text.trim() !== '')
    .slice(-MAX_LINES)
    .map((l) => `${l.who === 'user' ? 'User' : 'Eya'}: ${short(l.text, 280)}`);
  if (kept.length === 0) return '';
  return [
    'Earlier in this same conversation (a reminder of what was already said; you were talking before, so carry on from it, do not greet again, and do not ask the user to repeat any of it):',
    ...kept,
  ].join('\n');
}
