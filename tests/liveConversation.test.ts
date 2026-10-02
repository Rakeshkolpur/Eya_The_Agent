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

  constructor(private readonly outcome: 'ok' | Error = 'ok') {}

  async open(url: string, setup: LiveSetupOptions): Promise<void> {
    this.opened.push({ url, setup });
    if (this.outcome !== 'ok') throw this.outcome;
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
  tools: Array<{ name: string; args: unknown }>;
  sink: () => ((chunk: Float32Array, rate: number) => void) | null;
  clock: { t: number };
}

function rig(opts: { sessions?: Array<'ok' | Error>; config?: LiveConfig | null; idleMs?: number; slowToolMs?: number; runTool?: ConversationDeps['runTool'] } = {}): Rig {
  const outcomes = opts.sessions ?? ['ok'];
  const sessions: FakeSession[] = [];
  const playbacks: FakePlayback[] = [];
  const phases: ConversationPhase[] = [];
  const heard: string[] = [];
  const said: string[] = [];
  const ended: Array<[ConversationEnd, string | undefined]> = [];
  const tools: Array<{ name: string; args: unknown }> = [];
  const slow: string[] = [];
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
    },
    {
      onPhase: (p) => phases.push(p),
      onHeard: (t) => heard.push(t),
      onSaid: (t) => said.push(t),
      onEnded: (r, d) => ended.push([r, d]),
      onSlowTool: (name) => slow.push(name),
    },
  );
  return { conv, sessions, playbacks, phases, heard, said, ended, slow, tools, sink: () => sink, clock };
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

  it('reports the reason if the server or network drops it', async () => {
    const r = await started();
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
