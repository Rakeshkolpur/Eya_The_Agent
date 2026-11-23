/**
 * The Tasks page: ONE place where the person types any task — a live chat, an order on Flipkart, looking something up — and sees them all, side by side, each with its own state,
 * its own steps, its own question when it has one, and its own controls. A task is what Eya was asked to do; it runs on its own (its own browser tab, its own questions) while the
 * others go on. Live chats are in the same list.
 */
import type { TaskState } from './tasks';

/** What a task is about, read from the words (only a label: every task runs the same way). */
export type TaskKind = 'live_chat' | 'order' | 'research' | 'other';

const LIVE = /\b(?:live\s*chat|chat\s+with\s+\S+\s+(?:for\s+me|on\s+(?:my\s+)?whats?\s*app)|reply\s+(?:to\s+\S+\s+)?for\s+me\s+on\s+whats?\s*app)\b/i;
const ORDER = /\b(?:order|buy|purchase|book(?:ing)?|add\s+to\s+(?:the\s+)?cart|check\s*out|pay\s+for|flipkart|amazon|swiggy|zomato|myntra|meesho|bigbasket|blinkit|zepto|irctc|redbus|makemytrip|ola|uber)\b/i;
const RESEARCH = /\b(?:find|find\s+out|gather|collect|research|search|look\s*(?:up|for)|compare|summari[sz]e|information|info\s+(?:about|on)|news|details\s+(?:of|about)|list\s+(?:of|the)|who\s+is|what\s+is|tell\s+me\s+about|cause\s*list|price\s+of|reviews?)\b/i;

/** What a task is about, from the words the person used. */
export function classifyTask(text: string): TaskKind {
  const t = text.trim();
  if (LIVE.test(t)) return 'live_chat';
  if (ORDER.test(t)) return 'order';
  if (RESEARCH.test(t)) return 'research';
  return 'other';
}

export const KIND_WORD: Readonly<Record<TaskKind, string>> = {
  live_chat: 'Live chat',
  order: 'Order',
  research: 'Look up',
  other: 'Task',
};

/** One task as the page shows it. */
export interface TaskRow {
  /** `task:<id>` for a task Eya is keeping, `live:<id>` for a live chat. */
  readonly id: string;
  readonly kind: TaskKind;
  /** What the person asked for (a live chat: who it is with). */
  readonly title: string;
  readonly state: TaskState | 'paused';
  /** What is happening, what is waited for, or how it ended (the answer, for a task that found something out). */
  readonly note: string;
  /** What has been done so far, newest last (a few). */
  readonly steps: readonly string[];
  /** The note is a question the person can answer on the card. */
  readonly asks: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Where its browser work is: Eya Browser, the person's own browser, or nowhere (yet / not a browser task). */
  readonly where: 'eya' | 'mine' | null;
  /** Carrying it on from the page is allowed (never for a task done through a plugin: what it sent, or may have sent, is looked at first). */
  readonly resumable: boolean;
  /** A task done through a plugin: where it is, in words, and what was seen (never what was said in a chat). */
  readonly phase: string | null;
  readonly evidence: readonly string[];
  /** A live chat: how it is going. */
  readonly live?: { readonly replies: number; readonly mode: string; readonly relation: string | null };
}

export interface TaskBoardSnapshot {
  /** Open first (newest first), then the few that ended lately. */
  readonly rows: readonly TaskRow[];
  /** How many are not over. */
  readonly open: number;
}

export type TaskBoardAction =
  /** A new task, in the person's words. */
  | { readonly kind: 'start'; readonly text: string }
  /** The person's answer to what one task asked. */
  | { readonly kind: 'answer'; readonly id: string; readonly text: string }
  | { readonly kind: 'stop'; readonly id: string }
  /** Carry on a task that was stopped, failed or is waiting for the person. */
  | { readonly kind: 'resume'; readonly id: string }
  | { readonly kind: 'stop_all' }
  | { readonly kind: 'clear_finished' }
  /** Show the browser tab this task works in (Eya Browser). */
  | { readonly kind: 'show_browser'; readonly id: string };

export const MAX_TASK_TEXT = 600;

const idOf = (raw: unknown): string | null => (typeof raw === 'string' && /^(?:task|live):[A-Za-z0-9_.-]{1,80}$/.test(raw) ? raw : null);

/** An action sent by the page, checked: anything that is not exactly one of the known actions is nothing. */
export function parseTaskBoardAction(raw: unknown): TaskBoardAction | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r['kind']) {
    case 'start': {
      const text = typeof r['text'] === 'string' ? r['text'].replace(/\s+/g, ' ').trim() : '';
      return text !== '' && text.length <= MAX_TASK_TEXT ? { kind: 'start', text } : null;
    }
    case 'answer': {
      const id = idOf(r['id']);
      const text = typeof r['text'] === 'string' ? r['text'].replace(/\s+/g, ' ').trim() : '';
      return id !== null && text !== '' && text.length <= MAX_TASK_TEXT ? { kind: 'answer', id, text } : null;
    }
    case 'stop':
    case 'resume':
    case 'show_browser': {
      const id = idOf(r['id']);
      return id === null ? null : { kind: r['kind'], id };
    }
    case 'stop_all':
    case 'clear_finished':
      return { kind: r['kind'] };
    default:
      return null;
  }
}

export const EMPTY_TASK_BOARD: TaskBoardSnapshot = { rows: [], open: 0 };
