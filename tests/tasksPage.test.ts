import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecentPage } from '../src/renderer/pages/RecentPage';
import type { EyaControl } from '../src/renderer/control';
import { boardSummary, followsRequest, isOpenRow, rowControls, rowStateWord } from '../src/renderer/ui/taskBoardLogic';
import type { TaskBoardSnapshot, TaskRow } from '../src/shared/taskBoard';

/**
 * The Tasks page as it is drawn: a box to start any task, a card for each task that is going (a live chat, an order, a look-up), each with only the controls that can really be used.
 * (What the buttons DO is the task board's — tested in taskBoard.test.ts and in the real browser; this is that the page offers the right ones.)
 */

const row = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: 'task:t1',
  kind: 'other',
  title: 'Do the thing',
  state: 'running',
  note: '',
  steps: [],
  asks: false,
  createdAt: 1_000,
  updatedAt: 2_000,
  where: null,
  resumable: true,
  phase: null,
  evidence: [],
  ...over,
});

const html = (rows: readonly TaskRow[] | null): string => {
  const board: TaskBoardSnapshot | null = rows === null ? null : { rows, open: rows.filter(isOpenRow).length };
  const c = { taskBoard: board, actOnTaskBoard: () => undefined, activity: null, actOnActivity: () => undefined, submit: async () => undefined } as unknown as EyaControl;
  return renderToStaticMarkup(React.createElement(RecentPage, { c, go: () => undefined }));
};

describe('the Tasks page: the box and the board', () => {
  it('always offers the box for a new task, with the three examples, even before the board has loaded', () => {
    for (const rows of [null, []]) {
      const out = html(rows);
      expect(out).toContain('What should Eya do?');
      expect(out).toContain('Start task');
      expect(out).toContain('Live chat with Anna on WhatsApp');
      expect(out).toContain('Flipkart');
    }
  });

  it('says plainly that nothing is running when the board is empty', () => {
    expect(html([])).toContain('Nothing is running');
  });

  it('draws one card for each task, with its kind, its state and its words', () => {
    const out = html([
      row({ id: 'live:a', kind: 'live_chat', title: 'Live chat with Rahul', note: 'Watching the chat', live: { replies: 2, mode: 'assisted', relation: 'friend' } }),
      row({ id: 'task:o', kind: 'order', title: 'Order shoes on Flipkart', note: 'Opening the site', where: 'eya' }),
      row({ id: 'task:r', kind: 'research', title: 'Find the cause list', note: 'Reading the page', steps: ['Opened the court site', 'Found the list'] }),
    ]);
    expect(out.match(/class="tb-card /g)?.length).toBe(3);
    expect(out).toContain('Live chat with Rahul');
    expect(out).toContain('Order shoes on Flipkart');
    expect(out).toContain('Find the cause list');
    expect(out).toContain('2 replies');
    expect(out).toContain('Works in its own tab of Eya Browser');
    expect(out).toContain('Found the list');
    expect(out).toContain('3 running');
  });

  it('offers a box for the answer only on a task that asks, and Yes / No only for a question', () => {
    const asks = html([row({ state: 'needs_you', asks: true, note: 'Shall I place the order for ₹9,999?' })]);
    expect(asks).toContain('Your answer');
    expect(asks).toContain('>Yes<');
    expect(asks).toContain('>No<');
    const free = html([row({ state: 'needs_you', asks: true, note: 'Which colour do you want' })]);
    expect(free).toContain('Your answer');
    expect(free).not.toContain('>Yes<');
    const running = html([row({ state: 'running', note: 'Working' })]);
    expect(running).not.toContain('Your answer');
  });

  it('shows what finished lately under its own heading, with a Clear link, and the tasks that go on above', () => {
    const out = html([row({ id: 'task:a', title: 'Still going' }), row({ id: 'task:b', title: 'Already done', state: 'done', note: 'The cause list has 41 cases.' })]);
    expect(out).toContain('Running now');
    expect(out).toContain('Finished lately');
    expect(out).toContain('The cause list has 41 cases.');
    expect(out.indexOf('Still going')).toBeLessThan(out.indexOf('Already done'));
  });

  it('shows Stop all only when more than one task is going', () => {
    expect(html([row({ id: 'task:a' })])).not.toContain('Stop all');
    expect(html([row({ id: 'task:a' }), row({ id: 'task:b' })])).toContain('Stop all');
  });

  it('keeps the history of what Eya did below the board', () => {
    expect(html([])).toContain('History');
  });
});

describe('what each card offers', () => {
  it('Stop on anything still going, nothing on a finished task', () => {
    expect(rowControls(row({ state: 'running' })).stop).toBe(true);
    expect(rowControls(row({ state: 'waiting' })).stop).toBe(true);
    expect(rowControls(row({ state: 'paused', id: 'live:x' })).stop).toBe(true);
    expect(rowControls(row({ state: 'done' })).stop).toBe(false);
    expect(rowControls(row({ state: 'failed' })).stop).toBe(false);
  });

  it('Try again after a task failed or was stopped, Continue when it was left for the person', () => {
    expect(rowControls(row({ state: 'failed' })).resume).toBe('Try again');
    expect(rowControls(row({ state: 'cancelled' })).resume).toBe('Try again');
    expect(rowControls(row({ state: 'needs_you', asks: false })).resume).toBe('Continue');
    expect(rowControls(row({ state: 'needs_you', asks: true })).resume).toBeNull();
    expect(rowControls(row({ state: 'running' })).resume).toBeNull();
  });

  it('never carries on a task done through a plugin: what it sent, or may have sent, is looked at first', () => {
    for (const state of ['failed', 'cancelled', 'needs_you'] as const) {
      expect(rowControls(row({ state, resumable: false, phase: 'Not sure it went: look in the chat' })).resume).toBeNull();
    }
    expect(rowStateWord(row({ state: 'needs_you', resumable: false, phase: 'Not sure it went: look in the chat' }))).toBe('Not sure it went: look in the chat');
  });

  it('a plugin task that waits for the person is answered in the chat, where it asked', () => {
    const waiting = row({ state: 'needs_you', asks: false, resumable: false, phase: 'Waiting for your answer' });
    expect(rowControls(waiting).answerInChat).toBe(true);
    expect(rowControls(waiting).answer).toBe(false);
    expect(rowControls(row({ state: 'needs_you', asks: true })).answerInChat).toBe(false);
    expect(rowControls(row({ state: 'running', phase: 'Doing it', resumable: false })).answerInChat).toBe(false);
    expect(html([waiting])).toContain('Open the chat');
  });

  it('a live chat can be resumed when paused and opened on its own page; a task cannot', () => {
    const live = row({ id: 'live:s1', kind: 'live_chat', state: 'paused' });
    expect(rowControls(live).resume).toBe('Resume');
    expect(rowControls(live).openLiveChat).toBe(true);
    expect(rowControls(row({ id: 'live:s1', kind: 'live_chat', state: 'running' })).resume).toBeNull();
    expect(rowControls(row({ state: 'failed' })).openLiveChat).toBe(false);
  });

  it('shows the browser tab only for a task that works in Eya Browser', () => {
    expect(rowControls(row({ where: 'eya' })).showBrowser).toBe(true);
    expect(rowControls(row({ where: 'mine' })).showBrowser).toBe(false);
    expect(rowControls(row({ where: null })).showBrowser).toBe(false);
  });

  it('counts how many are going and how many need the person', () => {
    expect(boardSummary([])).toBe('Nothing yet.');
    expect(boardSummary([row({ state: 'done' })])).toBe('Nothing is running.');
    expect(boardSummary([row({ id: 'a' }), row({ id: 'b', state: 'needs_you' })])).toBe('2 running · 1 needs you');
    expect(boardSummary([row({ id: 'a', state: 'needs_you' }), row({ id: 'b', state: 'needs_you' })])).toBe('2 running · 2 need you');
  });
});

describe('starting tasks on the Tasks page does not throw the person onto the browser', () => {
  // (found in the real app: each task that began to work opened the browser workspace by itself, so the person never stayed on the page where all their tasks are)
  it('a page that opened by itself does not move the person off the Tasks page; anything else goes where it was asked', () => {
    expect(followsRequest({ page: 'browser', auto: true }, 'recent')).toBe(false);
    expect(followsRequest({ page: 'browser', auto: true }, 'home')).toBe(true);
    expect(followsRequest({ page: 'browser', auto: true }, 'chat')).toBe(true);
    // (asked for: "Show its browser", the tray, a link in Settings)
    expect(followsRequest({ page: 'browser' }, 'recent')).toBe(true);
    expect(followsRequest({ page: 'settings' }, 'recent')).toBe(true);
  });
});
