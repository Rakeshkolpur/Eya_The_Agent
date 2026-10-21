import { describe, it, expect } from 'vitest';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import { TaskStore } from '../src/main/tasks/TaskStore';
import type { TaskNotice } from '../src/main/tasks/TaskCompleter';
import { trackRequest } from '../src/main/tasks/trackRequest';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { AgentRequest, AgentResult } from '../src/shared/types';

function setup() {
  const files = new Map<string, string>();
  const io: StoreIo = { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
  const clock = { t: 5_000_000 };
  const notices: TaskNotice[] = [];
  const completer = new TaskCompleter({ store: new TaskStore('t.json', io), now: () => clock.t, run: async () => ({ requestId: 'x', ok: true, spoken: 'ok' }), notify: (n) => void notices.push(n) });
  // A timer that fires only when the test says time has passed.
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  const fake = {
    set: (fn: () => void, ms: number) => {
      const t = { at: clock.t + ms, fn, live: true };
      timers.push(t);
      return t;
    },
    clear: (h: unknown) => void ((h as { live: boolean }).live = false),
  };
  const pass = (ms: number): void => {
    clock.t += ms;
    for (const t of timers) if (t.live && t.at <= clock.t) {
      t.live = false;
      t.fn();
    }
  };
  return { completer, notices, clock, fake, pass };
}

const req = (text: string, extra: Partial<AgentRequest> = {}): AgentRequest => ({ requestId: 'r', text, source: 'text', ...extra });
const ok = (spoken: string, extra: Partial<AgentResult> = {}): AgentResult => ({ requestId: 'r', ok: true, spoken, ...extra });

describe('trackRequest', () => {
  it('a quick request that finishes is not recorded', async () => {
    const m = setup();
    const r = await trackRequest(m.completer, req('open notepad'), async () => ok('Opened Notepad.'), { timers: m.fake, now: () => m.clock.t });
    expect(r.spoken).toBe('Opened Notepad.');
    expect(m.completer.snapshot().items).toHaveLength(0);
    expect(m.notices).toHaveLength(0);
  });

  it('one still going after a few seconds shows up as working on it, and is finished when it is', async () => {
    const m = setup();
    let finish: (r: AgentResult) => void = () => undefined;
    const pending = trackRequest(m.completer, req('send the file to Akka'), () => new Promise<AgentResult>((r) => (finish = r)), { timers: m.fake, now: () => m.clock.t });
    m.pass(9_000);
    expect(m.completer.snapshot().items[0]).toMatchObject({ request: 'send the file to Akka', state: 'running' });
    m.pass(30_000);
    finish(ok('Sent to Akka.'));
    await pending;
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'done', note: 'Sent to Akka.' });
    expect(m.notices.map((n) => n.kind)).toEqual(['done']);
  });

  it('a request that could not finish is kept, even if it came back fast', async () => {
    const m = setup();
    const r = await trackRequest(
      m.completer,
      req('send the invoice to Akka'),
      async () => ok('The AI is out for now.', { ok: false, pending: { kind: 'retry', why: 'the AI is out of its allowance for now', retryAfterMs: 600_000 } }),
      { timers: m.fake, now: () => m.clock.t },
    );
    expect(r.pending?.kind).toBe('retry');
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'waiting', note: 'the AI is out of its allowance for now' });
    expect(m.completer.snapshot().open).toBe(1);
  });

  it('a long request that did finish is recorded and announced', async () => {
    const m = setup();
    const r = await trackRequest(
      m.completer,
      req('download the form'),
      async () => {
        m.clock.t += 40_000;
        return ok('Downloaded the form.');
      },
      { timers: m.fake, now: () => m.clock.t },
    );
    expect(r.ok).toBe(true);
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'done' });
    expect(m.notices).toHaveLength(1);
  });

  it('whatever is handled, a question that was waiting for a yes or a no is closed', async () => {
    const m = setup();
    await trackRequest(m.completer, req('send the bill to Akka'), async () => ok('Found Akka. Send the file?', { pending: { kind: 'needs_you', why: 'a question', asks: true } }), { timers: m.fake, now: () => m.clock.t });
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'needs_you', asks: true });
    await trackRequest(m.completer, req('yes'), async () => ok('Sent to Akka.'), { timers: m.fake, now: () => m.clock.t });
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'done', note: 'Answered.' });
    expect(m.completer.snapshot().open).toBe(0);
  });

  it('always-on speech that was ignored leaves nothing behind', async () => {
    const m = setup();
    let finish: (r: AgentResult) => void = () => undefined;
    const p = trackRequest(m.completer, req('so anyway', { live: true }), () => new Promise<AgentResult>((r) => (finish = r)), { timers: m.fake, now: () => m.clock.t });
    m.pass(9_000);
    finish({ requestId: 'r', ok: false, spoken: '', error: 'ignored' });
    await p;
    expect(m.completer.snapshot().open).toBe(0);
  });

  it('an error is passed on, and the task that was showing is kept for another go', async () => {
    const m = setup();
    let fail: (e: Error) => void = () => undefined;
    const p = trackRequest(m.completer, req('zip my folder'), () => new Promise<AgentResult>((_, rej) => (fail = rej)), { timers: m.fake, now: () => m.clock.t });
    m.pass(9_000);
    fail(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
    expect(m.completer.snapshot().items[0]).toMatchObject({ state: 'waiting' });
  });
});
