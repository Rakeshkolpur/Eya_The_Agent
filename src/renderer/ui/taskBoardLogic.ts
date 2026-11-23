import type { TaskRow } from '../../shared/taskBoard';
import type { AppPage } from '../control';

/**
 * Whether the window goes where a request says. A page that opened by itself (the browser beside a task that has begun to work) does not take the person off the Tasks page: they
 * start several tasks there and watch them side by side, and each task starting would otherwise throw them onto the browser. Anything they asked for (the tray, "Show its browser") always goes.
 */
export function followsRequest(request: { readonly page: AppPage; readonly auto?: boolean }, current: AppPage): boolean {
  return !(request.auto === true && current === 'recent');
}

/** What the Tasks page says for where a task is. */
const STATE_WORD: Readonly<Record<TaskRow['state'], string>> = {
  running: 'Working on it',
  waiting: 'Waiting to try again',
  needs_you: 'Needs you',
  done: 'Done',
  failed: "Couldn't finish",
  cancelled: 'Stopped',
  paused: 'Paused',
};

/** A task is open until it is done, failed or stopped (a paused live chat is still open: it can be resumed). */
export const isOpenRow = (r: TaskRow): boolean => r.state === 'running' || r.state === 'waiting' || r.state === 'needs_you' || r.state === 'paused';

/** The word for where a task is: a task done through a plugin says its phase, a live chat says what it is doing. */
export function rowStateWord(r: TaskRow): string {
  if (r.phase !== null) return r.phase;
  return STATE_WORD[r.state];
}

/** What a card offers the person: each is shown only when it can really be done. */
export interface RowControls {
  /** A question is waiting on the card: a box for the answer (and Yes / No when it reads as a yes-or-no question). */
  readonly answer: boolean;
  readonly yesNo: boolean;
  /** Stop it (a task or a live chat that is still going). */
  readonly stop: boolean;
  /** Carry on a task that was stopped, failed or left for the person; resume a paused live chat. */
  readonly resume: 'Try again' | 'Continue' | 'Resume' | null;
  /** Show the Eya Browser tab this task works in. */
  readonly showBrowser: boolean;
  /** A live chat: its own page has the replies and the controls for them. */
  readonly openLiveChat: boolean;
  /** A task done through a plugin that waits for the person (a choice, a yes, or a look in the chat): it is answered in the chat, where it asked. */
  readonly answerInChat: boolean;
}

const isLive = (r: TaskRow): boolean => r.id.startsWith('live:');

/** What the card of one task offers. Never "Try again" for a task done through a plugin (what it sent, or may have sent, is looked at first). */
export function rowControls(r: TaskRow): RowControls {
  const open = isOpenRow(r);
  const live = isLive(r);
  let resume: RowControls['resume'] = null;
  if (live) {
    if (r.state === 'paused') resume = 'Resume';
  } else if (r.resumable) {
    if (r.state === 'failed' || r.state === 'cancelled') resume = 'Try again';
    else if (r.state === 'needs_you' && !r.asks) resume = 'Continue';
  }
  return {
    answer: r.asks && r.state === 'needs_you',
    yesNo: r.asks && r.state === 'needs_you' && /\?\s*$/.test(r.note),
    stop: open,
    resume,
    showBrowser: r.where === 'eya',
    openLiveChat: live,
    answerInChat: r.state === 'needs_you' && !r.asks && r.phase !== null,
  };
}

/** The line under the board's title: how many are going and how many wait for the person. */
export function boardSummary(rows: readonly TaskRow[]): string {
  const open = rows.filter(isOpenRow);
  if (open.length === 0) return rows.length === 0 ? 'Nothing yet.' : 'Nothing is running.';
  const needs = open.filter((r) => r.state === 'needs_you').length;
  const parts = [`${open.length} running`];
  if (needs > 0) parts.push(`${needs} ${needs === 1 ? 'needs' : 'need'} you`);
  return parts.join(' · ');
}

/** Examples the person can tap to fill the box: a live chat, an order, looking something up. */
export const TASK_EXAMPLES: readonly string[] = [
  'Live chat with Anna on WhatsApp',
  'Order a pair of running shoes on Flipkart',
  "Find out today's cause list for the High Court",
];
