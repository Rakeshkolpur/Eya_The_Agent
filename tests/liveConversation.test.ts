import { describe, it, expect } from 'vitest';
import { LiveConversation, describeOpenFailure } from '../src/renderer/liveConversation';
import type { ConversationDeps, ConversationEnd, ConversationPhase } from '../src/renderer/liveConversation';
import { LiveOpenError } from '../src/renderer/liveSession';
import type { LiveCloseInfo, LiveSessionLike } from '../src/renderer/liveSession';
import type { LiveEvent, LiveSetupOptions, LiveToolResult } from '../src/renderer/liveProtocol';
import type { PcmPlayback } from '../src/renderer/pcmPlayer';
import type { LiveConfig } from '../src/shared/ipcContract';

class FakeSession implements LiveSessionLike {
  isOpen = false;
  readonly opened: Array<{ url: string; setup: LiveSetupOptions }> = [];
  readonly audio: Uint8Array[] = [];
  readonly toolResults: Array<readonly LiveToolResult[]> = [];
  closed = false;
  private readonly events = new Set<(e: LiveEvent) => void>();
  private readonly closes = new Set<(c: LiveCloseInfo) => void>();
  private gate: Promise<void> = Promise.resolve();
  /** Lets a 'slow' session finish opening. */
  release: () => void = () => undefined;

  constructor(private readonly outcome: 'ok' | 'slow' | Error = 'ok') {
    if (outcome === 'slow') {
      this.gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
  }

  async open(url: string, setup: LiveSetupOptions): Promise<void> {
    this.opened.push({ url, setup });
    if (this.outcome instanceof Error) throw this.outcome;
    await this.gate;
    this.isOpen = true;
  }
  onEvent(l: (e: LiveEvent) => void): () => void {
    this.events.add(l);
    return () => this.events.delete(l);
  }
  onClose(l: (c: LiveCloseInfo) => void): () => void {
    this.closes.add(l);
    return () => this.closes.delete(l);
  }
  sendAudio(pcm: Uint8Array): void {
    this.audio.push(pcm);
  }
  sendToolResults(r: readonly LiveToolResult[]): void {
    this.toolResults.push(r);
  }
  close(): void {
    this.closed = true;
    this.isOpen = false;
    for (const l of this.closes) l({ code: 1000, reason: '', byUs: true });
  }
  emit(e: LiveEvent): void {
    for (const l of this.events) l(e);
  }
  serverHangsUp(code: number, reason: string): void {
    this.isOpen = false;
    for (const l of this.closes) l({ code, reason, byUs: false });
  }
}

class FakePlayback implements PcmPlayback {
  readonly pushed: Uint8Array[] = [];
  ended = false;
  stopped = false;
  finished: Promise<void>;
  finish: () => void = () => undefined;
  constructor() {
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }
  push(pcm: Uint8Array): void {
    this.pushed.push(pcm);
  }
  end(): void {
    this.ended = true;
  }
  stop(): void {
    this.stopped = true;
    this.finish();
  }
}

const CONFIG: LiveConfig = {
  url: 'wss://example/live?key=SECRET',
  models: ['fast', 'backup'],
  voice: 'Aoede',
  systemInstruction: 'Be brief.',
  tools: [{ name: 'open_application', description: 'open', parameters: { type: 'object' } }],
};

interface Rig {
  conv: LiveConversation;
  sessions: FakeSession[];
  playbacks: FakePlayback[];
  phases: ConversationPhase[];
  heard: string[];
  said: string[];
  ended: Array<[ConversationEnd, string | undefined]>;
  slow: string[];
  reconnects: Array<[string, string]>;
  tools: Array<{ name: string; args: unknown }>;
  sink: () => ((chunk: Float32Array, rate: number) => void) | null;
  clock: { t: number };
}

function rig(
  opts: {
    sessions?: Array<'ok' | 'slow' | Error>;
    config?: LiveConfig | null;
    idleMs?: number;
    slowToolMs?: number;
    runTool?: ConversationDeps['runTool'];
    maxReconnects?: number;
    modelHealth?: ConversationDeps['modelHealth'];
    badModelMs?: number;
  } = {},
): Rig {
  const outcomes = opts.sessions ?? ['ok'];
  const sessions: FakeSession[] = [];
  const playbacks: FakePlayback[] = [];
  const phases: ConversationPhase[] = [];
  const heard: string[] = [];
  const said: string[] = [];
  const ended: Array<[ConversationEnd, string | undefined]> = [];
  const tools: Array<{ name: string; args: unknown }> = [];
  const slow: string[] = [];
  const reconnects: Array<[string, string]> = [];
  let sink: ((chunk: Float32Array, rate: number) => void) | null = null;
  const clock = { t: 1_000_000 };
  let n = 0;
  const conv = new LiveConversation(
    {
      getConfig: async () => (opts.config === undefined ? CONFIG : opts.config),
      runTool:
        opts.runTool ??
        (async (name, args) => {
          tools.push({ name, args });
          return JSON.stringify({ ok: true, summary: `${name} done` });
        }),
      makeSession: () => {
        const s = new FakeSession(outcomes[Math.min(n, outcomes.length - 1)]);
        n += 1;
        sessions.push(s);
        return s;
      },
      createPlayback: () => {
        const p = new FakePlayback();
        playbacks.push(p);
        return p;
      },
      setFrameSink: (s) => {
        sink = s;
      },
      idleMs: opts.idleMs ?? 60_000,
      ...(opts.slowToolMs !== undefined ? { slowToolMs: opts.slowToolMs } : {}),
      echoTailMs: 250,
      now: () => clock.t,
      ...(opts.maxReconnects !== undefined ? { maxReconnects: opts.maxReconnects } : {}),
      ...(opts.modelHealth !== undefined ? { modelHealth: opts.modelHealth } : {}),
      ...(opts.badModelMs !== undefined ? { badModelMs: opts.badModelMs } : {}),
    },
    {
      onPhase: (p) => phases.push(p),
      onHeard: (t) => heard.push(t),
      onSaid: (t) => said.push(t),
      onEnded: (r, d) => ended.push([r, d]),
      onSlowTool: (name) => slow.push(name),
      onReconnecting: (model, reason) => reconnects.push([model, reason]),
    },
  );
  return { conv, sessions, playbacks, phases, heard, said, ended, slow, reconnects, tools, sink: () => sink, clock };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const audioEvent = (n = 4): LiveEvent => ({ type: 'audio', pcm: new Uint8Array(n).fill(1) });

async function started(opts: Parameters<typeof rig>[0] = {}) {
  const r = rig(opts);
  expect((await r.conv.start()).ok).toBe(true);
  const session = r.sessions[r.sessions.length - 1];
  if (session === undefined) throw new Error('no session');
  return { ...r, session };
}

/** Feed roughly `ms` of quiet microphone audio at 48kHz through the frame sink. */
function feed(r: { sink: () => ((c: Float32Array, rate: number) => void) | null }, ms: number): void {
  const sink = r.sink();
  for (let i = 0; i < Math.ceil((ms * 48) / 128); i += 1) sink?.(new Float32Array(128).fill(0.1), 48_000);
}

describe('starting a conversation', () => {
  it('opens a session with the configured model, voice, prompt and tools, then listens', async () => {
    const { conv, session, phases, sink } = await started();
    expect(session.opened).toHaveLength(1);
    expect(session.opened[0]?.url).toBe(CONFIG.url);
    expect(session.opened[0]?.setup).toEqual({
      model: 'fast',
      voice: 'Aoede',
      systemInstruction: 'Be brief.',
      tools: CONFIG.tools,
    });
    expect(phases).toEqual(['connecting', 'listening']);
    expect(conv.active).toBe(true);
    expect(sink()).not.toBeNull(); // the microphone is now routed to the conversation
  });

  it('falls back to the next model if the first will not open', async () => {
    const { sessions, conv } = await started({ sessions: [new LiveOpenError('closed', 'closed', 1011, 'boom'), 'ok'] });
    expect(sessions.map((s) => s.opened[0]?.setup.model)).toEqual(['fast', 'backup']);
    expect(conv.active).toBe(true);
  });

  it('explains honestly when no model will open, and leaves the microphone alone', async () => {
    const r = rig({ sessions: [new LiveOpenError('closed', 'closed', 1011, 'Resource has been exhausted (quota)')] });
    const result = await r.conv.start();
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toMatch(/Live voice has hit its usage limit right now/);
    expect(reason).toMatch(/daily limit should come back around .+ (today|tomorrow)/); // and says when, in the user's own time
    expect(r.conv.active).toBe(false);
    expect(r.sink()).toBeNull();
    expect(r.sessions).toHaveLength(2); // tried both models
  });

  it('says a Gemini key is needed when there is no config', async () => {
    const r = rig({ config: null });
    expect(await r.conv.start()).toEqual({ ok: false, reason: 'Live voice needs a Gemini key.' });
  });

  it('starting twice does not open a second session', async () => {
    const r = await started();
    await r.conv.start();
    expect(r.sessions).toHaveLength(1);
  });
});

describe('sending the microphone', () => {
  it('streams about 100ms at a time, as 16kHz 16-bit audio', async () => {
    const r = await started();
    feed(r, 250);
    expect(r.session.audio.length).toBeGreaterThanOrEqual(2);
    for (const block of r.session.audio) {
      // ~100ms at 16kHz is 3200 bytes (1600 samples x 2); the 128-sample mic blocks
      // make each batch land a hair over, never under, and always whole samples.
      expect(block.length).toBeGreaterThanOrEqual(3200);
      expect(block.length).toBeLessThan(3400);
      expect(block.length % 2).toBe(0);
    }
  });

  it('is muted while Eya speaks, so she cannot interrupt herself, and resumes just after', async () => {
    const r = await started();
    r.session.emit(audioEvent());
    await tick();
    const during = r.session.audio.length;
    feed(r, 500);
    expect(r.session.audio).toHaveLength(during); // nothing sent while she is talking

    r.session.emit({ type: 'turnComplete' });
    r.playbacks[0]?.finish();
    await tick();
    feed(r, 200);
    expect(r.session.audio).toHaveLength(during); // still inside the echo tail

    r.clock.t += 300; // past the tail
    feed(r, 250);
    expect(r.session.audio.length).toBeGreaterThan(during);
  });

  it('can be muted for a moment, so a cue Eya plays herself is not heard as the user', async () => {
    const r = await started();
    r.conv.muteMicFor(2000);
    feed(r, 500);
    expect(r.session.audio).toHaveLength(0);

    r.clock.t += 2100;
    feed(r, 250);
    expect(r.session.audio.length).toBeGreaterThan(0);
  });

  it('lets the mic be unmuted early once the cue has finished playing', async () => {
    const r = await started();
    r.conv.muteMicFor(30_000);
    feed(r, 300);
    expect(r.session.audio).toHaveLength(0);

    r.conv.muteMicFor(0);
    feed(r, 250);
    expect(r.session.audio.length).toBeGreaterThan(0);
  });

  describe('barge-in (interrupting her)', () => {
    it('is off by default, so the microphone is muted while she speaks', async () => {
      const r = await started();
      expect(r.conv.bargeInEnabled).toBe(false);
      r.session.emit(audioEvent());
      await tick();
      feed(r, 300);
      expect(r.session.audio).toHaveLength(0);
    });

    it('keeps the microphone open while she speaks, so the user can talk over her', async () => {
      const r = await started();
      r.conv.setBargeIn(true);
      r.session.emit(audioEvent());
      await tick();
      feed(r, 300);
      expect(r.session.audio.length).toBeGreaterThan(0);
    });

    it('stops her and keeps listening when the server reports she was interrupted', async () => {
      const r = await started();
      r.conv.setBargeIn(true);
      r.session.emit(audioEvent());
      await tick();
      r.session.emit({ type: 'interrupted' });
      expect(r.playbacks[0]?.stopped).toBe(true);
      expect(r.phases.at(-1)).toBe('listening');
      feed(r, 250);
      expect(r.session.audio.length).toBeGreaterThan(0);
    });

    it('has no muted tail after she finishes, since nothing was muted', async () => {
      const r = await started();
      r.conv.setBargeIn(true);
      r.session.emit(audioEvent());
      r.session.emit({ type: 'turnComplete' });
      r.playbacks[0]?.finish();
      await tick();
      feed(r, 250);
      expect(r.session.audio.length).toBeGreaterThan(0);
    });

    it('can be switched off again mid-conversation', async () => {
      const r = await started();
      r.conv.setBargeIn(true);
      r.conv.setBargeIn(false);
      r.session.emit(audioEvent());
      await tick();
      feed(r, 300);
      expect(r.session.audio).toHaveLength(0);
    });
  });

  it('sends nothing once the conversation has ended', async () => {
    const r = await started();
    const sink = r.sink();
    r.conv.stop();
    sink?.(new Float32Array(9600).fill(0.1), 48_000);
    expect(r.session.audio).toHaveLength(0);
  });
});

describe('Eya speaking', () => {
  it('plays each spoken turn as one stream and finishes it at the end of the turn', async () => {
    const r = await started();
    r.session.emit(audioEvent(4));
    r.session.emit(audioEvent(6));
    expect(r.playbacks).toHaveLength(1);
    expect(r.playbacks[0]?.pushed.map((p) => p.length)).toEqual([4, 6]);
    expect(r.phases.at(-1)).toBe('speaking');

    r.session.emit({ type: 'turnComplete' });
    expect(r.playbacks[0]?.ended).toBe(true);
    r.playbacks[0]?.finish();
    await tick();
    expect(r.phases.at(-1)).toBe('listening');

    r.session.emit(audioEvent(2)); // the next turn gets a fresh stream
    expect(r.playbacks).toHaveLength(2);
  });

  it('stops talking the moment the user interrupts', async () => {
    const r = await started();
    r.session.emit(audioEvent());
    r.session.emit({ type: 'interrupted' });
    expect(r.playbacks[0]?.stopped).toBe(true);
    expect(r.phases.at(-1)).toBe('listening');
    feed(r, 250); // and the user can be heard straight away
    expect(r.session.audio.length).toBeGreaterThan(0);
  });

  it('shows what was heard and said, and starts fresh when the user speaks again', async () => {
    const r = await started();
    r.session.emit({ type: 'heard', text: 'Open ' });
    r.session.emit({ type: 'heard', text: 'Notepad.' });
    r.session.emit({ type: 'said', text: "I've opened " });
    r.session.emit({ type: 'said', text: 'Notepad.' });
    r.session.emit({ type: 'heard', text: 'Thanks.' });
    expect(r.heard).toEqual(['Open', 'Open Notepad.', 'Thanks.']);
    expect(r.said).toEqual(["I've opened", "I've opened Notepad.", '']); // cleared when the user speaks again
  });
});

describe('tools', () => {
  it('runs a requested tool and gives the model its result by id and name', async () => {
    const r = await started();
    r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'open_application', args: { name: 'notepad' } }] });
    expect(r.phases.at(-1)).toBe('working');
    await tick();
    expect(r.tools).toEqual([{ name: 'open_application', args: { name: 'notepad' } }]);
    expect(r.session.toolResults).toEqual([[{ id: 'c1', name: 'open_application', response: { ok: true, summary: 'open_application done' } }]]);
    expect(r.phases.at(-1)).toBe('thinking');
  });

  it('runs several calls in order and answers them together', async () => {
    const r = await started();
    r.session.emit({
      type: 'toolCall',
      calls: [
        { id: 'a', name: 'find_file', args: {} },
        { id: 'b', name: 'web_search', args: { query: 'x' } },
      ],
    });
    await tick();
    expect(r.tools.map((t) => t.name)).toEqual(['find_file', 'web_search']);
    expect(r.session.toolResults[0]?.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('answers with an error, not silence, if a tool blows up', async () => {
    const r = await started({
      runTool: async () => {
        throw new Error('ipc broke');
      },
    });
    r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'find_file', args: {} }] });
    await tick();
    expect(r.session.toolResults[0]?.[0]?.response).toMatchObject({ ok: false });
  });

  it('does not answer a call the model has since cancelled', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const r = await started({
      runTool: async () => {
        await gate;
        return JSON.stringify({ ok: true });
      },
    });
    r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'find_file', args: {} }] });
    r.session.emit({ type: 'toolCancel', ids: ['c1'] });
    release();
    await tick();
    expect(r.session.toolResults.flat()).toEqual([]);
  });

  describe('a tool that takes a while', () => {
    const gated = () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release: () => release(),
        runTool: async () => {
          await gate;
          return JSON.stringify({ ok: true });
        },
      };
    };
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('tells the user once, by name, so they are not left in silence', async () => {
      const g = gated();
      const r = await started({ slowToolMs: 20, runTool: g.runTool });
      r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'analyze_document', args: {} }] });
      await wait(60);
      expect(r.slow).toEqual(['analyze_document']);
      g.release();
      await tick();
      await wait(60);
      expect(r.slow).toEqual(['analyze_document']); // once, not repeatedly
    });

    it('stays quiet for a tool that answers quickly', async () => {
      const r = await started({ slowToolMs: 50 });
      r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'open_application', args: { name: 'notepad' } }] });
      await tick();
      await wait(90);
      expect(r.slow).toEqual([]);
    });

    it('stays quiet if the conversation ended while the tool was running', async () => {
      const g = gated();
      const r = await started({ slowToolMs: 20, runTool: g.runTool });
      r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'analyze_document', args: {} }] });
      r.conv.stop();
      await wait(60);
      g.release();
      expect(r.slow).toEqual([]);
    });
  });

  it('wraps a non-object result so the model always gets an object', async () => {
    const r = await started({ runTool: async () => 'plain text result' });
    r.session.emit({ type: 'toolCall', calls: [{ id: 'c1', name: 'x', args: {} }] });
    await tick();
    expect(r.session.toolResults[0]?.[0]?.response).toEqual({ result: 'plain text result' });
  });
});

describe('ending a conversation', () => {
  it('stops when the user says so: closes the session, frees the microphone, reports once', async () => {
    const r = await started();
    r.session.emit(audioEvent());
    r.conv.stop();
    r.conv.stop(); // a second stop is harmless
    expect(r.session.closed).toBe(true);
    expect(r.sink()).toBeNull();
    expect(r.playbacks[0]?.stopped).toBe(true);
    expect(r.ended).toEqual([['user', undefined]]);
    expect(r.conv.active).toBe(false);
  });

  it('ends itself after a quiet spell', async () => {
    const r = await started({ idleMs: 30 });
    await new Promise((res) => setTimeout(res, 80));
    expect(r.ended).toEqual([['idle', undefined]]);
    expect(r.session.closed).toBe(true);
    expect(r.sink()).toBeNull();
  });

  it('does not count time spent speaking as quiet', async () => {
    const r = await started({ idleMs: 30 });
    r.session.emit(audioEvent()); // she starts talking and keeps going
    await new Promise((res) => setTimeout(res, 100));
    expect(r.conv.active).toBe(true);
    r.session.emit({ type: 'turnComplete' });
    r.playbacks[0]?.finish();
    await new Promise((res) => setTimeout(res, 100));
    expect(r.ended.map(([why]) => why)).toEqual(['idle']);
  });

  it('reports the reason if the server or network drops it (once it will not reconnect)', async () => {
    const r = await started({ maxReconnects: 0 });
    r.session.serverHangsUp(1006, 'network dropped');
    expect(r.ended).toEqual([['closed', 'network dropped']]);
    expect(r.sink()).toBeNull();
    expect(r.conv.active).toBe(false);
  });

  it('can start a new conversation after one ended', async () => {
    const r = await started();
    r.conv.stop();
    expect((await r.conv.start()).ok).toBe(true);
    expect(r.sessions).toHaveLength(2);
    expect(r.conv.active).toBe(true);
  });
});

describe('describeOpenFailure', () => {
  it('names a usage limit, a slow connection, or just unavailable', () => {
    expect(describeOpenFailure(new LiveOpenError('x', 'closed', 1011, 'Quota exceeded'))).toMatch(/usage limit/);
    expect(describeOpenFailure(new LiveOpenError('x', 'closed', 1011, 'resource exhausted'))).toMatch(/usage limit/);
    expect(describeOpenFailure(new LiveOpenError('x', 'timeout'))).toMatch(/too long/);
    expect(describeOpenFailure(new LiveOpenError('x', 'error'))).toMatch(/not available/);
    expect(describeOpenFailure(undefined)).toMatch(/not available/);
  });
});

describe('when the server cuts the session off (measured: the 3.1 preview model opens, then dies about 9 s into every audio session)', () => {
  const INTERNAL = 'Internal error encountered.';
  const modelsOf = (r: { sessions: FakeSession[] }) => r.sessions.map((s) => s.opened[0]?.setup.model);

  /** A shared, in-memory stand-in for the store that survives restarts. */
  function memory(initial: Record<string, number> = {}) {
    const store = { data: { ...initial }, saved: 0 };
    return {
      store,
      health: {
        load: () => store.data,
        save: (m: Readonly<Record<string, number>>) => {
          store.data = { ...m };
          store.saved += 1;
        },
      },
    };
  }

  it('reopens on the next model and the conversation goes on, instead of ending with "disconnected"', async () => {
    const r = await started({ sessions: ['ok', 'ok'] });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(modelsOf(r)).toEqual(['fast', 'backup']); // the failed one is not tried again first
    expect(r.conv.active).toBe(true);
    expect(r.ended).toEqual([]);
    expect(r.reconnects).toEqual([['fast', INTERNAL]]);
    expect(r.phases.slice(-2)).toEqual(['connecting', 'listening']);
    expect(r.sink()).not.toBeNull(); // the microphone stays routed to the conversation
    feed(r, 300);
    expect(r.sessions[1]?.audio.length).toBeGreaterThan(0); // and now flows to the new session
    expect(r.session.audio.length).toBe(0);
  });

  it('events from the new session are heard, and a later hang-up is handled by the new session too', async () => {
    const r = await started({ sessions: ['ok', 'ok', 'ok'] });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.sessions[1]?.emit({ type: 'heard', text: 'open notepad' });
    expect(r.heard.at(-1)).toBe('open notepad');
    r.session.emit({ type: 'heard', text: 'ghost from the dead session' }); // the old one is no longer listened to
    expect(r.heard.at(-1)).toBe('open notepad');
    r.sessions[1]?.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.sessions).toHaveLength(3);
    expect(r.conv.active).toBe(true);
  });

  it('a model that had finished a reply before it was cut off is not blamed: the same model is tried first again', async () => {
    const r = await started({ sessions: ['ok', 'ok'] });
    r.session.emit({ type: 'turnComplete' });
    r.session.serverHangsUp(1006, 'network dropped');
    await tick();
    expect(modelsOf(r)).toEqual(['fast', 'fast']);
    expect(r.conv.active).toBe(true);
  });

  it('remembers the failed model for the NEXT conversation too, so it does not begin with the broken one again', async () => {
    const r = await started({ sessions: ['ok', 'ok', 'ok'] });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.conv.stop();
    expect((await r.conv.start()).ok).toBe(true);
    expect(modelsOf(r)).toEqual(['fast', 'backup', 'backup']);
  });

  it('writes that down where it survives a restart, and a new app run reads it', async () => {
    const mem = memory();
    const first = await started({ sessions: ['ok', 'ok'], modelHealth: mem.health });
    first.session.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(Object.keys(mem.store.data)).toEqual(['fast']);
    expect(mem.store.data['fast']).toBeGreaterThan(first.clock.t); // for a while
    // "restart": a brand-new conversation object, same store
    const second = await started({ sessions: ['ok'], modelHealth: mem.health });
    expect(modelsOf(second)).toEqual(['backup']);
  });

  it('forgets after a while (the model may have recovered), and the memory only ever reorders — nothing is dropped', async () => {
    const mem = memory();
    const r = await started({ sessions: ['ok', 'ok', 'ok'], modelHealth: mem.health, badModelMs: 1000 });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.conv.stop();
    r.clock.t += 5000; // longer than it is held against the model
    await r.conv.start();
    expect(modelsOf(r)).toEqual(['fast', 'backup', 'fast']);
  });

  it('if every model has a mark against it, they are all still tried, in the configured order', async () => {
    const far = 9_999_999_999_999;
    const r = await started({ sessions: [new LiveOpenError('closed', 'closed', 1008, 'x'), 'ok'], modelHealth: memory({ fast: far, backup: far }).health });
    expect(modelsOf(r)).toEqual(['fast', 'backup']);
    expect(r.conv.active).toBe(true);
  });

  it('a held-against model that then finishes a reply is cleared, so it goes back to being tried first', async () => {
    const far = 9_999_999_999_999;
    const mem = memory({ fast: far });
    const r = await started({ sessions: [new LiveOpenError('closed', 'closed', 1008, 'x'), 'ok'], modelHealth: mem.health });
    expect(modelsOf(r)).toEqual(['backup', 'fast']); // fast was held against, so tried second, and it worked
    r.session.emit({ type: 'turnComplete' });
    expect(mem.store.data['fast']).toBeUndefined();
  });

  it('gives up after a couple of cut-offs in a row and says what happened, instead of looping forever', async () => {
    const r = await started({ sessions: ['ok'], maxReconnects: 2 });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.sessions[1]?.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.conv.active).toBe(true);
    r.sessions[2]?.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.sessions).toHaveLength(3); // the original and two reopenings, no more
    expect(r.ended).toEqual([['closed', INTERNAL]]);
    expect(r.conv.active).toBe(false);
    expect(r.sink()).toBeNull();
  });

  it('the allowance renews after a quiet spell, so a long conversation can recover again later', async () => {
    const r = await started({ sessions: ['ok'], maxReconnects: 1 });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.clock.t += 5 * 60_000;
    r.sessions[1]?.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.conv.active).toBe(true);
    expect(r.sessions).toHaveLength(3);
  });

  it('does not reopen for a usage limit: that cannot be fixed by trying again, and is reported', async () => {
    const r = await started({ sessions: ['ok', 'ok'] });
    r.session.serverHangsUp(1011, 'Resource has been exhausted (quota)');
    await tick();
    expect(r.sessions).toHaveLength(1);
    expect(r.ended).toEqual([['closed', 'Resource has been exhausted (quota)']]);
  });

  it('ends honestly if nothing will open when it tries to reconnect', async () => {
    const r = await started({ sessions: ['ok', new LiveOpenError('closed', 'closed', 1011, 'boom')] });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.ended).toEqual([['closed', INTERNAL]]);
    expect(r.conv.active).toBe(false);
    expect(r.sink()).toBeNull();
  });

  it('if the user stops while it is reconnecting, the new session is closed and the conversation ends once, as the user asked', async () => {
    const r = await started({ sessions: ['ok', 'slow'] });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    r.conv.stop();
    r.sessions[1]?.release();
    await tick();
    expect(r.sessions[1]?.closed).toBe(true);
    expect(r.ended).toEqual([['user', undefined]]);
    expect(r.conv.active).toBe(false);
  });

  it('a model the server refuses outright is remembered, so the next conversation does not try it first; a limit is not held against a model', async () => {
    const refused = await started({ sessions: [new LiveOpenError('closed', 'closed', 1008, 'model not found'), 'ok', 'ok'] });
    refused.conv.stop();
    await refused.conv.start();
    expect(modelsOf(refused)).toEqual(['fast', 'backup', 'backup']);

    const limited = rig({ sessions: [new LiveOpenError('closed', 'closed', 1011, 'quota exceeded'), 'ok', 'ok'] });
    await limited.conv.start();
    limited.conv.stop();
    await limited.conv.start();
    expect(modelsOf(limited)).toEqual(['fast', 'backup', 'fast']); // the limit says nothing about which model is broken
  });

  it('a memory that cannot be read or written never breaks a conversation', async () => {
    const broken = {
      load: () => {
        throw new Error('storage unavailable');
      },
      save: () => {
        throw new Error('storage full');
      },
    };
    const r = await started({ sessions: ['ok', 'ok'], modelHealth: broken });
    r.session.serverHangsUp(1011, INTERNAL);
    await tick();
    expect(r.conv.active).toBe(true);
    expect(modelsOf(r)).toEqual(['fast', 'backup']);
  });
});
