import { describe, it, expect } from 'vitest';
import { TaskCompleter, backoffMs } from '../src/main/tasks/TaskCompleter';
import type { CompleterDeps, TaskNotice } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import type { StoredTask } from '../src/main/tasks/TaskStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { AgentResult } from '../src/shared/types';

function memoryIo(): StoreIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
}

const ok = (spoken: string): AgentResult => ({ requestId: 'r', ok: true, spoken });
const retry = (why: string, over: Partial<NonNullable<AgentResult['pending']>> = {}): AgentResult => ({
  requestId: 'r',
  ok: false,
  spoken: 'later',
  pending: { kind: 'retry', why, ...over },
});

function make(over: Partial<CompleterDeps> = {}, io = memoryIo()) {
  let t = 1_000_000;
  const notices: TaskNotice[] = [];
  const said: Array<[string, string]> = [];
  const ran: StoredTask[] = [];
  let next: Array<AgentResult | Error> = [ok('done')];
  const deps: CompleterDeps = {
    store: new TaskStore('tasks.json', io),
    now: () => t,
    run: async (task) => {
      ran.push(task);
      const r = next.length > 1 ? next.shift() : next[0];
      if (r instanceof Error) throw r;
      return r ?? ok('done');
    },
    notify: (n) => void notices.push(n),
    say: (text, kind) => void said.push([text, kind]),
    ...over,
  };
  const c = new TaskCompleter(deps);
  return {
    c,
    io,
    notices,
    said,
    ran,
    advance: (ms: number) => void (t += ms),
    now: () => t,
    script: (...r: Array<AgentResult | Error>) => void (next = r),
  };
}

describe('TaskCompleter: a request that finishes', () => {
  it('a quick one is simply done, with no notification', () => {
    const m = make();
    const id = m.c.begin('open notepad', 'text');
    m.advance(2000);
    m.c.settle(id, ok('Opened Notepad.'));
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done', note: 'Opened Notepad.' });
    expect(m.notices).toHaveLength(0);
    expect(m.c.snapshot().open).toBe(0);
  });

  it('one that took a while is announced when it is done', () => {
    const m = make();
    const id = m.c.begin('send the invoice to Akka', 'text');
    m.advance(45_000);
    m.c.settle(id, ok('Sent the invoice to Akka.'));
    expect(m.notices).toEqual([expect.objectContaining({ kind: 'done', title: 'Eya finished', taskId: id })]);
    expect(m.notices[0]?.body).toContain('send the invoice to Akka');
    expect(m.notices[0]?.body).toContain('Sent the invoice to Akka.');
  });

  it('a request that failed is recorded as failed (and announced if it took a while)', () => {
    const m = make();
    const id = m.c.begin('download the form', 'text');
    m.advance(30_000);
    m.c.settle(id, { requestId: 'r', ok: false, spoken: "I couldn't download it." });
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'failed' });
    expect(m.notices[0]).toMatchObject({ kind: 'failed' });
  });
});

describe('TaskCompleter: keeping a task until it is done', () => {
  it('a task that could not finish is kept, announced once, and tried again when it is due', async () => {
    const m = make();
    const id = m.c.begin('send this image to Akka on WhatsApp', 'live');
    m.c.settle(id, retry('WhatsApp is still loading', { retryAfterMs: 15_000, steps: ['open_website web.whatsapp.com'] }));
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'waiting', note: 'WhatsApp is still loading' });
    expect(m.c.snapshot().open).toBe(1);
    expect(m.notices.map((n) => n.kind)).toEqual(['waiting']);

    await m.c.tick(); // not due yet
    expect(m.ran).toHaveLength(0);

    m.advance(16_000);
    m.script(ok('Found Akka. Send the image?'));
    await m.c.tick();
    expect(m.ran).toHaveLength(1);
    expect(m.ran[0]).toMatchObject({ request: 'send this image to Akka on WhatsApp', attempts: 2, steps: ['open_website web.whatsapp.com'] });
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done' });
    // told it was waiting once, and now that it is finished (it was carried on in the background)
    expect(m.notices.map((n) => n.kind)).toEqual(['waiting', 'done']);
  });

  it('keeps going through several failures with growing waits, and gives up after the most tries', async () => {
    const m = make({ maxAttempts: 3 });
    const id = m.c.begin('book the ticket', 'text');
    m.script(retry('the site is slow'));
    m.c.settle(id, retry('the site is slow'));
    for (let i = 0; i < 3; i += 1) {
      m.advance(10 * 60_000);
      await m.c.tick();
    }
    expect(m.ran).toHaveLength(2); // attempts 2 and 3
    const task = m.c.snapshot().items[0];
    expect(task).toMatchObject({ state: 'failed' });
    expect(task?.note).toContain('tried 3 times');
    expect(m.notices.at(-1)).toMatchObject({ kind: 'failed' });
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
    expect(backoffMs(2)).toBeLessThan(backoffMs(9));
  });

  it('a task that throws when carried on is tried again, not lost', async () => {
    const m = make();
    const id = m.c.begin('zip my Downloads', 'text');
    m.c.settle(id, retry('slow', { retryAfterMs: 1000 }));
    m.advance(2000);
    m.script(new Error('boom'), ok('Zipped.'));
    await m.c.tick();
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'waiting' });
    m.advance(60_000);
    await m.c.tick();
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done' });
  });

  it('works on one task at a time', async () => {
    let release: (r: AgentResult) => void = () => undefined;
    const m = make({
      run: () => new Promise<AgentResult>((resolve) => (release = resolve)),
    });
    const a = m.c.begin('first', 'text');
    const b = m.c.begin('second', 'text');
    m.c.settle(a, retry('x', { retryAfterMs: 0 }));
    m.c.settle(b, retry('x', { retryAfterMs: 0 }));
    const first = m.c.tick();
    await Promise.resolve();
    await m.c.tick(); // a second look while one is running starts nothing
    expect(m.c.snapshot().items.filter((i) => i.state === 'running')).toHaveLength(1);
    release(ok('done'));
    await first;
    expect(m.c.snapshot().items.filter((i) => i.state === 'done')).toHaveLength(1);
  });

  it('gives up quietly on a task that has been open for far too long', async () => {
    const m = make({ keepMs: 60 * 60_000 });
    const id = m.c.begin('old task', 'text');
    m.c.settle(id, retry('slow', { retryAfterMs: 999_999_999 }));
    m.advance(2 * 60 * 60_000);
    await m.c.tick();
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'failed' });
    expect(m.notices.map((n) => n.kind)).toEqual(['waiting']); // no new alarm
  });
});

describe('TaskCompleter: when it needs the person', () => {
  it('a question is kept with its words, announced, and closed when it is answered', () => {
    const m = make();
    const id = m.c.begin('send the file to Uber', 'text');
    m.c.settle(id, { requestId: 'r', ok: true, spoken: 'Found Uber. Send the file "bill.pdf"?', pending: { kind: 'needs_you', why: 'a question', asks: true } });
    const view = m.c.snapshot().items[0];
    expect(view).toMatchObject({ state: 'needs_you', asks: true, note: 'Found Uber. Send the file "bill.pdf"?' });
    expect(m.notices[0]).toMatchObject({ kind: 'needs_you', title: 'Eya has a question' });
    m.c.answered();
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done', note: 'Answered.' });
  });

  it('a check in the browser is watched, and the task carries on by itself when the person has finished', async () => {
    let watchCalls = 0;
    const m = make({
      watchPauseMs: 0,
      watchBrowser: async () => {
        watchCalls += 1;
        return watchCalls >= 2; // not yet, then done
      },
    });
    const id = m.c.begin('check the case status on the court site', 'text');
    m.c.settle(id, { requestId: 'r', ok: false, spoken: 'There is a CAPTCHA. Please complete it.', pending: { kind: 'needs_you', why: 'a CAPTCHA to complete', watch: 'browser' } });
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'needs_you', note: 'a CAPTCHA to complete' });
    m.script(ok('The case is listed for the 12th.'));
    await m.c.tick(); // starts watching
    for (let i = 0; i < 20 && m.ran.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(watchCalls).toBeGreaterThanOrEqual(2);
    await m.c.tick();
    expect(m.ran).toHaveLength(1);
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done', note: 'The case is listed for the 12th.' });
  });
});

describe('TaskCompleter: the person stops it', () => {
  it('cancel stops one task by id, the latest with no id, or all of them; a stopped task ignores a late answer', () => {
    const m = make();
    const a = m.c.begin('one', 'text');
    const b = m.c.begin('two', 'text');
    const c = m.c.begin('three', 'text');
    expect(m.c.cancel(a)).toBe(1);
    expect(m.c.cancel()).toBe(1); // the latest open one: three
    expect(m.c.snapshot().items.find((i) => i.id === c)?.state).toBe('cancelled');
    expect(m.c.snapshot().items.find((i) => i.id === b)?.state).toBe('running');
    m.c.settle(c, ok('done anyway')); // it finished after being stopped: ignored
    expect(m.c.snapshot().items.find((i) => i.id === c)?.state).toBe('cancelled');
    expect(m.c.cancelAll()).toBe(1);
    expect(m.c.snapshot().open).toBe(0);
    expect(m.c.cancel()).toBe(0);
  });

  it('resume tries a task again right away; clear removes the finished ones', async () => {
    const m = make();
    const id = m.c.begin('upload the form', 'text');
    m.c.cancel(id);
    expect(m.c.resume(id)).toBe(true);
    m.script(ok('Uploaded.'));
    await m.c.tick();
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done' });
    m.c.act({ kind: 'clear_finished' });
    expect(m.c.snapshot().items).toHaveLength(0);
    expect(m.c.resume('nope')).toBe(false);
  });
});

describe('TaskCompleter: work that outlasts the one who asked', () => {
  it('is adopted, and the person is told when it finishes — aloud and by notification', async () => {
    const m = make();
    let finish: (r: AgentResult) => void = () => undefined;
    const id = m.c.adopt('send the photo to Akka', 'live', new Promise<AgentResult>((r) => (finish = r)));
    expect(m.c.snapshot().items[0]).toMatchObject({ id, state: 'running' });
    finish({ requestId: 'r', ok: true, spoken: 'Found Akka. Send the photo?', pending: { kind: 'needs_you', why: 'a question', asks: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.said).toEqual([['Found Akka. Send the photo?', 'ask']]);
    expect(m.notices[0]).toMatchObject({ kind: 'needs_you' });
  });

  it('a result that is simply done is said as done, and a failure to finish is kept for another go', async () => {
    const m = make();
    let finish: (r: AgentResult) => void = () => undefined;
    m.c.adopt('open the cause list', 'live', new Promise<AgentResult>((r) => (finish = r)));
    finish(ok('Opened the cause list.'));
    await new Promise((r) => setTimeout(r, 0));
    expect(m.said).toEqual([['Opened the cause list.', 'done']]);
    expect(m.c.snapshot().items[0]).toMatchObject({ state: 'done' });

    const m2 = make();
    m2.c.adopt('open the cause list', 'live', Promise.reject(new Error('lost')));
    await new Promise((r) => setTimeout(r, 0));
    expect(m2.c.snapshot().items[0]).toMatchObject({ state: 'waiting' });
  });
});

describe('TaskCompleter: it survives Eya closing', () => {
  it('writes the tasks to disk and reads them back', () => {
    const io = memoryIo();
    const a = make({}, io);
    const id = a.c.begin('send this image to Akka', 'live');
    a.c.settle(id, retry('WhatsApp is still loading', { steps: ['open_website whatsapp'] }));
    const b = new TaskCompleter({ store: new TaskStore('tasks.json', io), now: a.now, run: async () => ok('x'), notify: () => undefined });
    expect(b.snapshot().items[0]).toMatchObject({ request: 'send this image to Akka', state: 'waiting' });
    expect(b.openTasks()[0]?.steps).toEqual(['open_website whatsapp']);
  });

  it('a task cut off while running is carried on if it is recent, and left for the person if it is old', async () => {
    const io = memoryIo();
    const a = make({}, io);
    a.c.begin('recent job', 'text');
    a.advance(10 * 60_000);
    const fresh = new TaskCompleter({ store: new TaskStore('tasks.json', io), now: a.now, run: async () => ok('done'), notify: () => undefined });
    expect(fresh.snapshot().items[0]).toMatchObject({ state: 'waiting' });

    const io2 = memoryIo();
    const b = make({}, io2);
    b.c.begin('old job', 'text');
    b.advance(3 * 60 * 60_000);
    const stale = new TaskCompleter({ store: new TaskStore('tasks.json', io2), now: b.now, run: async () => ok('done'), notify: () => undefined, keepMs: 24 * 60 * 60_000 });
    expect(stale.snapshot().items[0]).toMatchObject({ state: 'needs_you' });
    expect(stale.snapshot().items[0]?.note).toContain('Resume it?');
  });

  it('a damaged tasks file means no tasks, not a crash', () => {
    const io = memoryIo();
    io.files.set('tasks.json', '{not json');
    const c = new TaskCompleter({ store: new TaskStore('tasks.json', io), run: async () => ok('x'), notify: () => undefined });
    expect(c.snapshot().items).toEqual([]);
  });
});

describe('TaskCompleter: the list', () => {
  it('lists open tasks first and keeps only the latest finished ones', () => {
    const m = make();
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = m.c.begin(`job ${i}`, 'text');
      m.advance(1000);
      m.c.settle(id, ok(`done ${i}`));
      ids.push(id);
    }
    const open = m.c.begin('still going', 'text');
    const snap = m.c.snapshot();
    expect(snap.open).toBe(1);
    expect(snap.items[0]?.id).toBe(open);
    expect(snap.items).toHaveLength(13); // one open + the 12 latest finished
  });
});

describe('TaskCompleter: asking for the same thing again', () => {
  it('replaces the earlier task for the same request instead of keeping two', () => {
    const m = make();
    const first = m.c.begin('send this image to Akka on WhatsApp', 'live');
    m.c.settle(first, retry('WhatsApp is still loading'));
    const second = m.c.begin('Send this image to Akka on WhatsApp', 'text');
    const items = m.c.snapshot().items;
    expect(items.find((i) => i.id === first)).toMatchObject({ state: 'cancelled', note: 'Replaced by the same request again.' });
    expect(items.find((i) => i.id === second)?.state).toBe('running');
    expect(m.c.snapshot().open).toBe(1);
  });
});
