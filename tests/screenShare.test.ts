import { describe, it, expect } from 'vitest';
import { buildAskPrompt, IDLE_STOP_MS, MAX_CONSECUTIVE_FAILURES, ScreenShare } from '../src/main/screen/screenShare';
import type { ShareDeps } from '../src/main/screen/screenShare';
import type { ScreenFrame, ScreenShareStatus } from '../src/shared/ipcContract';

/** A screen that can change, windows that can open and close, and a clock and timer the test controls. */
class Rig {
  clock = 1_000_000;
  /** What the screen looks like right now; a different string is a different picture. */
  screen = 'desktop';
  titles: string[] = ['Notepad'];
  captureFails = false;
  frames: ScreenFrame[] = [];
  statuses: ScreenShareStatus[] = [];
  protect: boolean[] = [];
  analyzed: Array<{ prompt: string; mime: string; bytes: string }> = [];
  captures = 0;
  answer = 'You are looking at Notepad.';
  scheduled: Array<{ fn: () => void; ms: number }> = [];
  cancelled = 0;

  share: ScreenShare;

  constructor(over: Partial<ShareDeps> = {}) {
    this.share = new ScreenShare({
      capture: async () => {
        this.captures += 1;
        if (this.captureFails) throw new Error('Windows would not capture');
        return { bytes: Buffer.from(`png:${this.screen}`) };
      },
      toFrame: (png) => ({ bytes: Buffer.from(`jpeg-small:${png.toString()}`), width: 1280, height: 720 }),
      toAnswerImage: (png) => ({ bytes: Buffer.from(`jpeg-big:${png.toString()}`), mime: 'image/jpeg' }),
      windowTitles: async () => this.titles,
      blockedBy: (title) => (/whatsapp/i.test(title) ? 'WhatsApp' : null),
      analyze: async (bytes, mime, prompt) => {
        this.analyzed.push({ prompt, mime, bytes: bytes.toString() });
        return this.answer;
      },
      scrub: (t) => t.replace(/\b\d{6}\b/g, '[a code]'),
      protectOwnWindows: (on) => void this.protect.push(on),
      emitFrame: (f) => void this.frames.push(f),
      emitStatus: (s) => void this.statuses.push(s),
      now: () => this.clock,
      schedule: (fn, ms) => {
        this.scheduled.push({ fn, ms });
        return this.scheduled.length;
      },
      cancel: () => void (this.cancelled += 1),
      ...over,
    });
  }

  /** One round of the stream, as the timer would run it. */
  tick = (): Promise<void> => this.share.tick();
  get last(): ScreenShareStatus {
    return this.statuses[this.statuses.length - 1] as ScreenShareStatus;
  }
}

describe('turning sharing on and off', () => {
  it('is off until it is started, and starting hides Eya\'s own windows from the picture', () => {
    const r = new Rig();
    expect(r.share.status()).toMatchObject({ active: false, paused: null, frames: 0, startedAt: null });
    const s = r.share.start();
    expect(s).toMatchObject({ active: true, paused: null, startedAt: 1_000_000 });
    expect(r.protect).toEqual([true]);
    expect(r.last.active).toBe(true);
  });

  it('starting twice changes nothing; stopping puts Eya\'s windows back, cancels the timer, and says it was the user', () => {
    const r = new Rig();
    r.share.start();
    r.share.start();
    expect(r.protect).toEqual([true]);
    const s = r.share.stop();
    expect(s).toMatchObject({ active: false, stopped: 'user' });
    expect(r.protect).toEqual([true, false]);
    expect(r.cancelled).toBeGreaterThan(0);
    expect(r.share.stop().active).toBe(false); // stopping again is harmless
    expect(r.protect).toEqual([true, false]);
  });

  it('starting again forgets the last stop', () => {
    const r = new Rig();
    r.share.start();
    r.share.stop('idle', 'quiet');
    expect(r.share.status()).toMatchObject({ stopped: 'idle', message: 'quiet' });
    r.share.start();
    expect(r.share.status().stopped).toBeUndefined();
  });

  it('quitting stops it too', () => {
    const r = new Rig();
    r.share.start();
    r.share.dispose();
    expect(r.share.status()).toMatchObject({ active: false, stopped: 'quit' });
    expect(r.protect.at(-1)).toBe(false);
  });
});

describe('the stream of pictures', () => {
  it('passes on a picture, and only when the screen has CHANGED', async () => {
    const r = new Rig();
    r.share.start();
    await r.tick();
    await r.tick();
    await r.tick();
    expect(r.frames).toHaveLength(1); // three rounds, one unchanged screen, one picture
    expect(r.captures).toBe(3);
    r.screen = 'a different page';
    await r.tick();
    expect(r.frames).toHaveLength(2);
    expect(Buffer.from(r.frames[1]?.jpeg ?? '', 'base64').toString()).toBe('jpeg-small:png:a different page');
    expect(r.frames[1]).toMatchObject({ width: 1280, height: 720, at: 1_000_000 });
    expect(r.share.status().frames).toBe(2);
  });

  it('keeps going: every round plans the next, about a second later', async () => {
    const r = new Rig();
    r.share.start();
    expect(r.scheduled.map((s) => s.ms)).toEqual([0]);
    await r.tick();
    await r.tick();
    expect(r.scheduled.map((s) => s.ms)).toEqual([0, 1000, 1000]);
  });

  it('never takes two pictures at once', async () => {
    let release: () => void = () => undefined;
    const r = new Rig({
      capture: () => new Promise((res) => (release = () => res({ bytes: Buffer.from('png:x') }))),
    });
    r.share.start();
    const first = r.tick();
    await new Promise((res) => setTimeout(res, 0)); // let the first round reach the picture
    await r.tick(); // a second round while the first is still waiting does nothing
    release();
    await first;
    expect(r.frames).toHaveLength(1);
  });

  it('after it is stopped, nothing more is taken or passed on', async () => {
    const r = new Rig();
    r.share.start();
    await r.tick();
    r.share.stop();
    r.screen = 'changed after stop';
    await r.tick();
    expect(r.frames).toHaveLength(1);
    expect(r.captures).toBe(1);
  });

  it('a stop that arrives while a picture is being taken throws that picture away', async () => {
    let release: () => void = () => undefined;
    const r = new Rig({ capture: () => new Promise((res) => (release = () => res({ bytes: Buffer.from('png:late') }))) });
    r.share.start();
    const round = r.tick();
    await Promise.resolve();
    await Promise.resolve();
    r.share.stop();
    release();
    await round;
    expect(r.frames).toEqual([]);
  });
});

describe('chat apps', () => {
  it('while a chat app is showing and Chats are off for it, NO picture is taken at all, and the status says why', async () => {
    const r = new Rig();
    r.share.start();
    await r.tick();
    expect(r.captures).toBe(1);
    r.titles = ['Notepad', 'WhatsApp - Google Chrome'];
    await r.tick();
    await r.tick();
    expect(r.captures).toBe(1); // not one more picture
    expect(r.frames).toHaveLength(1);
    expect(r.share.status().paused).toEqual({ reason: 'chat_app', app: 'WhatsApp' });
    expect(r.statuses.filter((s) => s.paused !== null)).toHaveLength(1); // said once, not every second
  });

  it('when it goes away the stream resumes, and the first picture afterwards is always passed on', async () => {
    const r = new Rig();
    r.share.start();
    await r.tick();
    r.titles = ['WhatsApp'];
    await r.tick();
    r.titles = ['Notepad'];
    await r.tick();
    expect(r.share.status().paused).toBeNull();
    expect(r.frames).toHaveLength(2); // the same screen as before, but passed on again after the pause
  });

  it('a chat app that opens WHILE the picture is being taken is caught, and that picture is discarded', async () => {
    let calls = 0;
    const r = new Rig({
      windowTitles: async () => {
        calls += 1;
        return calls === 1 ? ['Notepad'] : ['Notepad', 'WhatsApp']; // clear before the picture, there after it
      },
    });
    r.share.start();
    await r.tick();
    expect(r.frames).toEqual([]);
    expect(r.share.status().paused).toEqual({ reason: 'chat_app', app: 'WhatsApp' });
  });

  it('an app whose Chats switch is ON is not blocked (the policy decides, not this code)', async () => {
    const r = new Rig({ blockedBy: () => null });
    r.titles = ['WhatsApp'];
    r.share.start();
    await r.tick();
    expect(r.frames).toHaveLength(1);
    expect(r.share.status().paused).toBeNull();
  });
});

describe('failing and idling', () => {
  it('a picture that fails now and then is tolerated; three in a row end the sharing, with a reason', async () => {
    const r = new Rig();
    r.share.start();
    r.captureFails = true;
    await r.tick();
    await r.tick();
    expect(r.share.status().active).toBe(true);
    r.captureFails = false;
    await r.tick(); // a good one resets the count
    r.captureFails = true;
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) await r.tick();
    expect(r.share.status()).toMatchObject({ active: false, stopped: 'error' });
    expect(r.share.status().message).toContain('would not let Eya capture the screen');
    expect(r.protect.at(-1)).toBe(false);
  });

  it('switches itself off after a quiet spell, but not while the user is still asking or talking', async () => {
    const r = new Rig();
    r.share.start();
    r.clock += IDLE_STOP_MS - 1000;
    await r.tick();
    expect(r.share.status().active).toBe(true);
    r.share.touch();
    r.clock += IDLE_STOP_MS - 1000;
    await r.tick();
    expect(r.share.status().active).toBe(true);
    r.clock += 2000;
    await r.tick();
    expect(r.share.status()).toMatchObject({ active: false, stopped: 'idle' });
  });
});

describe('asking about the screen', () => {
  it('needs sharing to be on', async () => {
    const r = new Rig();
    const out = await r.share.ask({ mode: 'analyze' });
    expect(out).toEqual({ ok: false, error: expect.stringContaining('Screen sharing is off') });
    expect(r.captures).toBe(0);
    expect(r.analyzed).toEqual([]);
  });

  it('takes a FRESH, sharper picture (not the last frame) and returns the answer', async () => {
    const r = new Rig();
    r.share.start();
    await r.tick();
    r.screen = 'the page changed a moment ago';
    const out = await r.share.ask({ mode: 'ask', question: 'What do I do here?' });
    expect(out).toEqual({ ok: true, answer: 'You are looking at Notepad.' });
    expect(r.analyzed).toHaveLength(1);
    expect(r.analyzed[0]?.bytes).toBe('jpeg-big:png:the page changed a moment ago');
    expect(r.analyzed[0]?.mime).toBe('image/jpeg');
    expect(r.analyzed[0]?.prompt).toContain('The user asks: What do I do here?');
  });

  it('scrubs secrets out of what comes back', async () => {
    const r = new Rig();
    r.answer = 'The code on screen is 482913.';
    r.share.start();
    expect(await r.share.ask({ mode: 'analyze' })).toEqual({ ok: true, answer: 'The code on screen is [a code].' });
  });

  it('refuses while a chat app that is switched off is showing, and takes no picture', async () => {
    const r = new Rig();
    r.share.start();
    r.titles = ['WhatsApp'];
    const out = await r.share.ask({ mode: 'analyze' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('WhatsApp is open on the screen and Chats are off for it');
    expect(r.captures).toBe(0);
    expect(r.analyzed).toEqual([]);
  });

  it('also refuses if the chat app opens during the picture, and sends nothing to be read', async () => {
    let calls = 0;
    const r = new Rig({ windowTitles: async () => (++calls === 1 ? ['Notepad'] : ['WhatsApp']) });
    r.share.start();
    const out = await r.share.ask({ mode: 'analyze' });
    expect(out.ok).toBe(false);
    expect(r.analyzed).toEqual([]);
  });

  it('says so when the reading fails or comes back empty, using the explanation it is given', async () => {
    const r = new Rig({ analyze: async () => { throw new Error('429 quota'); }, explainError: () => "I've hit Gemini's limit." });
    r.share.start();
    expect(await r.share.ask({ mode: 'analyze' })).toEqual({ ok: false, error: "I've hit Gemini's limit." });
    const empty = new Rig({ analyze: async () => '   ' });
    empty.share.start();
    expect((await empty.share.ask({ mode: 'analyze' })).error).toContain('could not make anything of the screen');
  });

  it('gives up with a plain message when the reading takes too long, instead of hanging', async () => {
    const r = new Rig({ analyze: () => new Promise<string>(() => undefined), askTimeoutMs: 20 });
    r.share.start();
    const out = await r.share.ask({ mode: 'analyze' });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('taking too long');
  });

  it('counts as the user being here, so asking keeps sharing alive', async () => {
    const r = new Rig();
    r.share.start();
    r.clock += IDLE_STOP_MS - 500;
    await r.share.ask({ mode: 'analyze' });
    r.clock += IDLE_STOP_MS - 500;
    await r.tick();
    expect(r.share.status().active).toBe(true);
  });
});

describe('what Gemini is asked', () => {
  it('always reads like speech and never reads out a secret', () => {
    for (const mode of ['analyze', 'explain', 'next', 'ask'] as const) {
      const p = buildAskPrompt({ mode, question: 'x' });
      expect(p, mode).toContain('will be read aloud');
      expect(p, mode).toContain('Never read out passwords');
      expect(p, mode).toContain('do not guess or invent');
    }
  });

  it('is different for each kind of question, and a blank question is just "what is here"', () => {
    expect(buildAskPrompt({ mode: 'explain' })).toContain('as if to someone new');
    expect(buildAskPrompt({ mode: 'next' })).toContain('what to do next, step by step');
    expect(buildAskPrompt({ mode: 'ask', question: 'How do I download the PDF?' })).toContain('The user asks: How do I download the PDF?');
    expect(buildAskPrompt({ mode: 'ask', question: '   ' })).toContain('Say what is on the screen');
    expect(buildAskPrompt({ mode: 'analyze' })).toContain('Say what is on the screen');
  });
});
