import { describe, it, expect } from 'vitest';
import { TaskBoard, TaskPlaces } from '../src/main/tasks/TaskBoard';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import { EMPTY_LIVE_CHAT_VIEW } from '../src/shared/liveChat';
import type { LiveChatRequest, LiveChatView } from '../src/shared/liveChat';
import { classifyTask, parseTaskBoardAction } from '../src/shared/taskBoard';
import type { AgentRequest, AgentResult } from '../src/shared/types';

/**
 * The Tasks page: ONE list where the person starts any task and sees them all — each with its own state, steps and question — and the live chats among them. These run the real
 * task completer over a memory store, with a scripted engine, so what is shown here is what the page would show.
 */

const memoryIo = (): StoreIo => {
  const files = new Map<string, string>();
  return { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
};
const ok = (spoken: string): AgentResult => ({ requestId: 'r', ok: true, spoken });
const asks = (question: string): AgentResult => ({ requestId: 'r', ok: true, spoken: question, pending: { kind: 'needs_you', why: question, asks: true } });
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

interface Gate {
  resolve: (r: AgentResult) => void;
}

function make(options: { live?: () => LiveChatView; hasQuestion?: () => boolean } = {}) {
  let t = 1_000_000;
  const requests: AgentRequest[] = [];
  const gates = new Map<string, Gate>();
  const retries: Array<{ id: string; reply: string | undefined }> = [];
  const liveCalls: LiveChatRequest[] = [];
  const shown: number[] = [];
  const completer = new TaskCompleter({
    store: new TaskStore('tasks.json', memoryIo()),
    now: () => t,
    // (a task carried on by the completer: it is told the answer once)
    run: async (task) => {
      retries.push({ id: task.id, reply: task.reply });
      return ok('Carried on.');
    },
    notify: () => undefined,
  });
  // (a task's place being fixed tells the page: the card says where the task works)
  let board!: TaskBoard;
  const places = new TaskPlaces(() => board.changed());
  let changes = 0;
  board = new TaskBoard({
    completer,
    places,
    // (the engine: each request waits until the test lets it finish, so several are in flight at once)
    run: (req) =>
      new Promise<AgentResult>((resolve) => {
        requests.push(req);
        gates.set(req.requestId, { resolve });
      }),
    ...(options.live !== undefined ? { live: { view: options.live, handle: async (r: LiveChatRequest) => (liveCalls.push(r), { ok: true, message: 'ok', view: options.live!() }) } } : {}),
    ...(options.hasQuestion !== undefined ? { hasQuestion: options.hasQuestion } : {}),
    showTab: (tab) => void shown.push(tab),
    now: () => t,
    onChange: () => void (changes += 1),
  });
  return {
    board,
    completer,
    places,
    requests,
    retries,
    liveCalls,
    shown,
    changes: () => changes,
    advance: (ms: number) => void (t += ms),
    finish: (index: number, result: AgentResult) => gates.get(requests[index]!.requestId)!.resolve(result),
  };
}

describe('what a task is about', () => {
  it.each([
    ['do live chat with +91 98765 08501, she is my friend', 'live_chat'],
    ['start a live chat with Rahul', 'live_chat'],
    ['order a POCO M6 on flipkart', 'order'],
    ['buy a ticket to Vijayawada on irctc', 'order'],
    ['order biryani on swiggy', 'order'],
    ['find out the latest news about the new labour codes', 'research'],
    ['gather information about GST registration for a small shop', 'research'],
    ['compare the prices of a 55 inch tv', 'research'],
    ['summarise this page', 'research'],
    ['clean up my downloads folder', 'other'],
    ['hello', 'other'],
  ])('%s → %s', (said, kind) => {
    expect(classifyTask(said)).toBe(kind);
  });
});

describe('the page asks are checked', () => {
  it('a task, an answer, stopping, resuming, and nothing else', () => {
    expect(parseTaskBoardAction({ kind: 'start', text: '  order   a phone ' })).toEqual({ kind: 'start', text: 'order a phone' });
    expect(parseTaskBoardAction({ kind: 'start', text: '' })).toBeNull();
    expect(parseTaskBoardAction({ kind: 'start', text: 'x'.repeat(700) })).toBeNull();
    expect(parseTaskBoardAction({ kind: 'answer', id: 'task:t1', text: 'UPI' })).toEqual({ kind: 'answer', id: 'task:t1', text: 'UPI' });
    expect(parseTaskBoardAction({ kind: 'answer', id: 'task:t1', text: '' })).toBeNull();
    expect(parseTaskBoardAction({ kind: 'stop', id: 'live:abc-1' })).toEqual({ kind: 'stop', id: 'live:abc-1' });
    expect(parseTaskBoardAction({ kind: 'stop', id: 'something else' })).toBeNull();
    expect(parseTaskBoardAction({ kind: 'resume', id: 'task:t1' })).toEqual({ kind: 'resume', id: 'task:t1' });
    expect(parseTaskBoardAction({ kind: 'stop_all' })).toEqual({ kind: 'stop_all' });
    expect(parseTaskBoardAction({ kind: 'delete_everything' })).toBeNull();
    expect(parseTaskBoardAction(null)).toBeNull();
  });
});

describe('starting tasks', () => {
  it('a task is on the list at once, as its own task, and runs as one (its own place), in agent mode', () => {
    const m = make();
    const id = m.board.start('  order a   POCO M6 on flipkart ');
    const rows = m.board.snapshot().rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `task:${id}`, kind: 'order', title: 'order a POCO M6 on flipkart', state: 'running' });
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]).toMatchObject({ text: 'order a POCO M6 on flipkart', mode: 'agent', task: { id } });
    expect(m.board.snapshot().open).toBe(1);
  });

  it('SEVERAL AT ONCE: a live chat, an order and a look-up are all running together, each on its own, and all in the list', async () => {
    const m = make();
    const a = m.board.start('order a POCO M6 on flipkart');
    const b = m.board.start('gather information about GST registration');
    const c = m.board.start('start a live chat with Rahul');
    expect(m.requests.map((r) => r.task?.id)).toEqual([a, b, c]);
    expect(new Set(m.requests.map((r) => r.requestId)).size).toBe(3);
    const snap = m.board.snapshot();
    expect(snap.open).toBe(3);
    expect(snap.rows.map((r) => r.kind).sort()).toEqual(['live_chat', 'order', 'research']);
    // the second one finishes first: the other two are untouched
    m.finish(1, ok('GST registration needs PAN, Aadhaar and a shop address.'));
    await tick();
    const after = m.board.snapshot();
    expect(after.open).toBe(2);
    const done = after.rows.find((r) => r.id === `task:${b}`);
    expect(done).toMatchObject({ state: 'done', note: 'GST registration needs PAN, Aadhaar and a shop address.' });
    expect(after.rows.find((r) => r.id === `task:${a}`)?.state).toBe('running');
    expect(after.rows.find((r) => r.id === `task:${c}`)?.state).toBe('running');
  });

  it('open tasks first, newest first; the ones that ended after them', async () => {
    const m = make();
    const first = m.board.start('find the price of gold');
    m.advance(1000);
    const second = m.board.start('order a charger on amazon');
    m.advance(1000);
    const third = m.board.start('look up the weather');
    m.finish(0, ok('Gold is 70,000.'));
    await tick();
    expect(m.board.snapshot().rows.map((r) => r.id)).toEqual([`task:${third}`, `task:${second}`, `task:${first}`]);
  });

  it('a request that could not be done is on its card, as that', async () => {
    const m = make();
    const id = m.board.start('open the court site');
    m.finish(0, { requestId: 'r', ok: false, spoken: 'The site did not open.' });
    await tick();
    expect(m.board.snapshot().rows.find((r) => r.id === `task:${id}`)).toMatchObject({ state: 'failed', note: 'The site did not open.' });
  });
});

describe('a question of its own', () => {
  it('a task that needs the person shows its question on ITS card (and another task is not asked)', async () => {
    const m = make();
    const order = m.board.start('order a POCO M6 on flipkart');
    const look = m.board.start('find out the news about elections');
    m.finish(0, asks('Which address should it go to?'));
    await tick();
    const rows = m.board.snapshot().rows;
    expect(rows.find((r) => r.id === `task:${order}`)).toMatchObject({ state: 'needs_you', note: 'Which address should it go to?', asks: true });
    expect(rows.find((r) => r.id === `task:${look}`)).toMatchObject({ state: 'running', asks: false });
  });

  it('the answer goes to THAT task, which carries on told what was answered (once); the others are not told', async () => {
    const m = make();
    const order = m.board.start('order a POCO M6 on flipkart');
    const other = m.board.start('order a charger on amazon');
    m.finish(0, asks('Which address should it go to?'));
    m.finish(1, asks('Which colour?'));
    await tick();
    expect(m.board.answer(`task:${order}`, 'the Hyderabad one')).toBe(true);
    await tick();
    expect(m.retries).toEqual([{ id: order, reply: 'the Hyderabad one' }]);
    expect(m.board.snapshot().rows.find((r) => r.id === `task:${other}`)).toMatchObject({ state: 'needs_you', note: 'Which colour?' });
    expect(m.completer.taskOf(order)?.reply).toBeUndefined(); // (told once)
  });

  it('an answer to a task that is not asking, or an empty one, is nothing', async () => {
    const m = make();
    const id = m.board.start('find out the news');
    expect(m.board.answer(`task:${id}`, 'hello')).toBe(false);
    m.finish(0, asks('Which paper?'));
    await tick();
    expect(m.board.answer(`task:${id}`, '   ')).toBe(false);
    expect(m.board.answer('task:nope', 'x')).toBe(false);
    expect(m.board.answer('live:abc', 'x')).toBe(false);
  });

  it('another request being handled does not answer a task\'s question (each task has its own)', async () => {
    const m = make();
    const id = m.board.start('order a POCO M6 on flipkart');
    m.finish(0, asks('Place the order?'));
    await tick();
    m.completer.answered(); // what any other finished request does
    expect(m.board.snapshot().rows.find((r) => r.id === `task:${id}`)?.state).toBe('needs_you');
  });
});

describe('a live chat that asks who they are', () => {
  it('the question is on the live chat task\'s card; the answer goes to the one that asked, and the task is done when the live chat has started', async () => {
    let question: string | null = 'Who is +91 ••••••8501 to you? Say friend, family…';
    const m = make({ hasQuestion: () => question !== null });
    const id = m.board.start('do live chat with +91 98765 08501');
    m.finish(0, ok(question!));
    await tick();
    expect(m.board.snapshot().rows[0]).toMatchObject({ kind: 'live_chat', state: 'needs_you', asks: true, note: question });
    expect(m.board.answer(`task:${id}`, 'friend')).toBe(true);
    // the answer is an ordinary request (no task scope): the quick command that asked reads it
    expect(m.requests[1]).toMatchObject({ text: 'friend' });
    expect(m.requests[1]?.task).toBeUndefined();
    question = null;
    m.finish(1, ok('Okay, a friend. Live chat is on with +91 ••••••8501.'));
    await tick();
    expect(m.board.snapshot().rows[0]).toMatchObject({ state: 'done', note: 'Okay, a friend. Live chat is on with +91 ••••••8501.' });
  });

  it('a live chat task that is not asking takes no answer, even while some quick command is waiting for one', async () => {
    const m = make({ hasQuestion: () => true });
    const id = m.board.start('do live chat with Anna');
    expect(m.board.snapshot().rows[0]).toMatchObject({ state: 'running', asks: false });
    expect(m.board.answer(`task:${id}`, 'friend')).toBe(false);
    expect(m.requests).toHaveLength(1);
  });
});

describe('stopping, trying again, clearing', () => {
  it('Stop ends that task on the spot, and only that one', async () => {
    const m = make();
    const a = m.board.start('order a phone on flipkart');
    const b = m.board.start('look up the weather');
    m.board.act({ kind: 'stop', id: `task:${a}` });
    const rows = m.board.snapshot().rows;
    expect(rows.find((r) => r.id === `task:${a}`)?.state).toBe('cancelled');
    expect(rows.find((r) => r.id === `task:${b}`)?.state).toBe('running');
  });

  it('a request that ends because it was stopped does not come back as a failure', async () => {
    const m = make();
    const id = m.board.start('order a phone on flipkart');
    m.finish(0, { requestId: 'r', ok: false, spoken: 'Okay, I stopped.', error: 'stopped' });
    await tick();
    expect(m.board.snapshot().rows.find((r) => r.id === `task:${id}`)?.state).toBe('cancelled');
  });

  it('Stop all, and Clear finished', async () => {
    const m = make();
    m.board.start('order a phone on flipkart');
    m.board.start('look up the weather');
    m.board.act({ kind: 'stop_all' });
    expect(m.board.snapshot().open).toBe(0);
    m.board.act({ kind: 'clear_finished' });
    expect(m.board.snapshot().rows).toEqual([]);
  });
});

describe('where a task works', () => {
  it('each task has its own place; the card says where, and Show browser shows THAT task\'s tab', async () => {
    const m = make();
    const a = m.board.start('order a phone on flipkart');
    const b = m.board.start('look up the weather');
    m.places.set(a, 11, 'eya');
    m.places.set(b, 12, 'eya');
    const rows = m.board.snapshot().rows;
    expect(rows.find((r) => r.id === `task:${a}`)?.where).toBe('eya');
    m.board.act({ kind: 'show_browser', id: `task:${a}` });
    m.board.act({ kind: 'show_browser', id: `task:${b}` });
    expect(m.shown).toEqual([11, 12]);
  });

  it('the page is told the moment a task\'s place is fixed (not at its next step), and not again when nothing changed', () => {
    const m = make();
    const a = m.board.start('order a phone on flipkart');
    const before = m.changes();
    m.places.set(a, 11, 'eya');
    expect(m.changes()).toBe(before + 1);
    m.places.set(a, 11, 'eya');
    expect(m.changes()).toBe(before + 1);
    m.places.set(a, 12, 'eya');
    expect(m.changes()).toBe(before + 2);
  });

  it('a task in the user\'s own browser says so, and has no tab to show here', () => {
    const m = make();
    const a = m.board.start('order a phone on flipkart');
    m.places.set(a, 31, 'chrome');
    expect(m.board.snapshot().rows[0]?.where).toBe('mine');
    m.board.act({ kind: 'show_browser', id: `task:${a}` });
    expect(m.shown).toEqual([]);
  });

  it('a task with no page yet says nothing about where', () => {
    const m = make();
    m.board.start('look up the weather');
    expect(m.board.snapshot().rows[0]?.where).toBeNull();
  });
});

describe('live chats are on the same list', () => {
  const live = (over: Partial<LiveChatView> = {}): LiveChatView => ({ ...EMPTY_LIVE_CHAT_VIEW, active: true, sessionId: 's1', chat: 'Priya Rao', state: 'ACTIVE', mode: 'auto', replies: 4, startedAt: 900_000, ...over });

  it('a live chat is a row with who it is with, how it is going, and Stop / Resume that go to it', async () => {
    const view = live();
    const m = make({ live: () => view });
    const task = m.board.start('order a phone on flipkart');
    const rows = m.board.snapshot().rows;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === 'live:s1')).toMatchObject({ kind: 'live_chat', title: 'Live chat with Priya Rao', state: 'running', live: { replies: 4, mode: 'auto' } });
    m.board.act({ kind: 'stop', id: 'live:s1' });
    m.board.act({ kind: 'resume', id: 'live:s1' });
    await tick();
    expect(m.liveCalls).toEqual([{ kind: 'stop', chat: 's1' }, { kind: 'resume' }]);
    expect(rows.some((r) => r.id === `task:${task}`)).toBe(true);
  });

  it('a paused one is paused, one that needs the person needs them, a number is masked', () => {
    let view = live({ state: 'PAUSED', chat: '+91 98765 08501' });
    const m = make({ live: () => view });
    expect(m.board.snapshot().rows[0]).toMatchObject({ state: 'paused' });
    expect(m.board.snapshot().rows[0]?.title).not.toMatch(/98765/);
    view = live({ state: 'WAITING_FOR_APPROVAL' });
    expect(m.board.snapshot().rows[0]).toMatchObject({ state: 'needs_you', note: 'A reply waits for you' });
  });

  it('several live chats are several rows; the ones waiting for their turn say so', () => {
    const view = live({
      chats: [
        { id: 's1', chat: 'Priya Rao', state: 'ACTIVE', pause: null, relation: 'friend', replies: 4, noteAt: null, front: true },
        { id: 's2', chat: 'Rahul', state: 'PAUSED', pause: 'standby', relation: null, replies: 1, noteAt: null, front: false },
      ],
    });
    const m = make({ live: () => view });
    const rows = m.board.snapshot().rows;
    expect(rows.map((r) => r.id).sort()).toEqual(['live:s1', 'live:s2']);
    expect(rows.find((r) => r.id === 'live:s2')).toMatchObject({ state: 'paused', note: 'Waiting for its turn' });
  });

  it('a live chat that has ended is not a row; Stop all stops them too', async () => {
    let view = live();
    const m = make({ live: () => view });
    m.board.act({ kind: 'stop_all' });
    await tick();
    expect(m.liveCalls).toEqual([{ kind: 'stop', all: true }]);
    view = { ...EMPTY_LIVE_CHAT_VIEW };
    expect(m.board.snapshot().rows).toEqual([]);
  });
});

describe('a task done through a plugin on the same list', () => {
  it('says where it is in words, shows what was seen, and is NEVER carried on from the page', () => {
    const m = make();
    m.completer.beginPlugin({ key: 'k1', plugin: 'whatsapp', action: 'send_message', title: 'Send a message to Anna' });
    m.completer.pluginUpdate('k1', { phase: 'executing', evidence: 'Chat opened' });
    let row = m.board.snapshot().rows.find((r) => r.title === 'Send a message to Anna');
    expect(row).toMatchObject({ phase: 'Doing it', resumable: false, evidence: ['Chat opened'], asks: false });
    m.completer.pluginFinish('k1', 'uncertain', 'Eya is not sure it went.');
    row = m.board.snapshot().rows.find((r) => r.title === 'Send a message to Anna');
    expect(row).toMatchObject({ state: 'needs_you', phase: 'Not sure it went: look in the chat', resumable: false, asks: false });
    // (resume from the page does nothing: running it again is how a message would go twice)
    m.board.act({ kind: 'resume', id: row!.id });
    expect(m.requests).toEqual([]);
    expect(m.completer.taskOf(row!.id.slice('task:'.length))?.state).toBe('needs_you');
  });

  it('an ordinary task has no phase and may be tried again', () => {
    const m = make();
    m.board.start('find the cause list');
    expect(m.board.snapshot().rows[0]).toMatchObject({ phase: null, resumable: true, evidence: [] });
  });
});
