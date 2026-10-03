import { describe, it, expect } from 'vitest';
import { createScreenTools, diffListings, scrubSecrets, whereIn } from '../src/main/tools/impl/screenTools';
import type { VisionBrain } from '../src/main/tools/impl/screenTools';
import { COMMUNICATION_OFF, CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import type { ActionOutcome, UiAutomation, UiElement, UiListing } from '../src/main/screen/uiAutomation';
import type { ScreenCapture, ScreenPicture } from '../src/main/screen/screenCapture';
import { ScreenCaptureError } from '../src/main/screen/screenCapture';
import type { WindowControl, WindowInfo } from '../src/main/windowsApi/windowControl';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';

const win = (over: Partial<WindowInfo> & Pick<WindowInfo, 'handle' | 'process' | 'title'>): WindowInfo => ({ pid: over.handle, state: 'normal', foreground: false, width: 1000, height: 800, ...over });

const CALC = win({ handle: 100, process: 'ApplicationFrameHost', title: 'Calculator', foreground: true });
const NOTEPAD = win({ handle: 200, process: 'notepad', title: 'notes.txt - Notepad' });
const EYA = win({ handle: 300, pid: 9999, process: 'electron', title: 'Eya' });
const WHATSAPP = win({ handle: 400, process: 'chrome', title: '(2) WhatsApp - Google Chrome' });

let nextIndex = 0;
const el = (over: Partial<UiElement> & Pick<UiElement, 'type' | 'name'>): UiElement => ({
  index: nextIndex++,
  automationId: '',
  enabled: true,
  offscreen: false,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  actions: [],
  password: false,
  ...over,
});

function calculator(display = 'Display is 0'): UiElement[] {
  nextIndex = 0;
  return [
    el({ type: 'Window', name: 'Calculator', x: 0, y: 0, width: 1000, height: 800 }),
    el({ type: 'Text', name: display, automationId: 'CalculatorResults', x: 0, y: 100, width: 1000, height: 150 }),
    el({ type: 'Button', name: 'Seven', automationId: 'num7', x: 0, y: 500, width: 300, height: 100, actions: ['invoke'] }),
    el({ type: 'Button', name: 'Plus', automationId: 'plus', x: 700, y: 500, width: 300, height: 100, actions: ['invoke'] }),
    el({ type: 'Button', name: 'Delete', automationId: 'del', x: 700, y: 100, width: 100, height: 50, actions: ['invoke'] }),
    el({ type: 'Button', name: 'Hidden thing', automationId: 'h', offscreen: true, actions: ['invoke'] }),
    el({ type: 'Button', name: 'Memory recall', automationId: 'mr', enabled: false, actions: ['invoke'] }),
    el({ type: 'Edit', name: 'Password', automationId: 'pw', password: true, actions: ['value'] }),
    el({ type: 'Pane', name: '' }),
  ];
}

interface Rig {
  tools: Tool[];
  run(name: string, args?: ToolArgs): Promise<ToolResult>;
  windows: WindowInfo[];
  ui: { elements: UiElement[]; listCalls: number; actCalls: Array<{ handle: number; index: number }>; clicks: Array<[number, number]>; outcome: ActionOutcome | ((e: { index: number }) => ActionOutcome); afterAct?: (() => void) | undefined };
  captured: string[];
  asked: Array<{ mime: string; prompt: string; bytes: number }>;
  focused: number[];
  setPolicy(s: CommunicationSettings): void;
  brain: { answer: string | Error };
}

function rig(opts: { settings?: CommunicationSettings; withBrain?: boolean; windows?: WindowInfo[] } = {}): Rig {
  let settings = opts.settings ?? COMMUNICATION_OFF;
  const windows = opts.windows ?? [EYA, CALC, NOTEPAD];
  const ui = { elements: calculator(), listCalls: 0, actCalls: [] as Array<{ handle: number; index: number }>, clicks: [] as Array<[number, number]>, outcome: { ok: true, how: 'invoke' } as ActionOutcome | ((e: { index: number }) => ActionOutcome), afterAct: undefined as undefined | (() => void) };
  const captured: string[] = [];
  const asked: Array<{ mime: string; prompt: string; bytes: number }> = [];
  const focused: number[] = [];
  const brainState: { answer: string | Error } = { answer: 'A calculator showing 0.' };

  const control: WindowControl = {
    list: async () => windows,
    info: async (h) => windows.find((w) => w.handle === h) ?? null,
    act: async (h, action) => {
      if (action === 'focus') focused.push(h);
      return { after: windows.find((w) => w.handle === h) ?? null, sent: true };
    },
  };
  const automation: UiAutomation = {
    list: async (): Promise<UiListing> => ((ui.listCalls += 1), { elements: ui.elements, truncated: false }),
    act: async (handle, e) => {
      ui.actCalls.push({ handle, index: e.index });
      const out = typeof ui.outcome === 'function' ? ui.outcome(e) : ui.outcome;
      if (out.ok) ui.afterAct?.();
      return out;
    },
    clickAt: async (x, y) => void ui.clicks.push([x, y]),
  };
  const screen: ScreenCapture = {
    screen: async (): Promise<ScreenPicture> => (captured.push('screen'), { bytes: Buffer.from('PNGDATA'), mime: 'image/png', width: 1920, height: 1080, kind: 'screen', label: '' }),
    window: async (title): Promise<ScreenPicture> => (captured.push(`window:${title}`), { bytes: Buffer.from('PNGDATA'), mime: 'image/png', width: 1000, height: 800, kind: 'window', label: title }),
  };
  const brain: VisionBrain = {
    analyzeFile: async (b64, mime, prompt) => {
      asked.push({ mime, prompt, bytes: Buffer.from(b64, 'base64').length });
      if (brainState.answer instanceof Error) throw brainState.answer;
      return brainState.answer;
    },
  };
  const tools = createScreenTools({
    control,
    ui: automation,
    screen,
    ...(opts.withBrain === false ? {} : { brain }),
    policy: new CommunicationPolicy(() => settings),
    ownPids: () => [9999],
    prepareImage: (png) => ({ bytes: Buffer.from(`J${png.toString()}`), mime: 'image/jpeg' }),
    sleep: async () => undefined,
  });
  return {
    tools,
    run: (name, args = {}) => (tools.find((t) => t.schema.name === name) as Tool).execute(args),
    windows,
    ui,
    captured,
    asked,
    focused,
    setPolicy: (s) => void (settings = s),
    brain: brainState,
  };
}

describe('describe_screen: look at the screen, in words — asked first', () => {
  it('asks before looking at anything, naming what it would look at, and sends nothing', async () => {
    const r = rig();
    const out = await r.run('describe_screen', {});
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('needs confirmation');
    expect(out.error).toContain('Can I look at your Calculator window?');
    expect(out.error).toContain("Gemini");
    expect(r.captured).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it('after a yes it looks at the window in front (never Eya\'s own), shrinks the picture, and returns Gemini\'s words', async () => {
    const r = rig({ windows: [EYA, CALC, NOTEPAD] });
    r.brain.answer = 'A calculator. The display shows 12. The Equals button is bottom right.';
    const out = await r.run('describe_screen', { confirm: true, question: 'what number is shown?' });
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ window: 'Calculator', description: 'A calculator. The display shows 12. The Equals button is bottom right.' });
    expect(r.captured).toEqual(['window:Calculator']);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]?.mime).toBe('image/jpeg');
    expect(r.asked[0]?.prompt).toContain('what number is shown?');
    expect(r.asked[0]?.prompt).toMatch(/Never read out passwords/);
  });

  it('a named window, or a different one in front, is the one looked at', async () => {
    const r = rig({ windows: [CALC, NOTEPAD] });
    await r.run('describe_screen', { confirm: true, window: 'notepad' });
    expect(r.captured).toEqual(['window:notes.txt - Notepad']);
  });

  it('says what is open when the named window is not', async () => {
    const r = rig();
    const out = await r.run('describe_screen', { confirm: true, window: 'excel' });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Open applications: .*Notepad/);
    expect(r.captured).toEqual([]);
  });

  it('removes a card number the picture\'s reader copied out, but not a phone number', async () => {
    const r = rig();
    r.brain.answer = 'The card number is 4111 1111 1111 1111 and call 98765 00432.';
    const out = await r.run('describe_screen', { confirm: true });
    expect(String(out.data?.['description'])).toContain('[card number removed]');
    expect(String(out.data?.['description'])).not.toContain('4111');
    expect(String(out.data?.['description'])).toContain('98765 00432');
    expect(scrubSecrets('order 1234567890123456')).toBe('order 1234567890123456'); // fails the card checksum: left alone
  });

  it('refuses a chat app while Communication Access is off — and takes no picture of it', async () => {
    const r = rig({ windows: [WHATSAPP, CALC] });
    const out = await r.run('describe_screen', { confirm: true });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('communication access is off');
    expect(out.data).toMatchObject({ communicationAccess: 'off', app: 'WhatsApp', nothingWasRead: true });
    expect(r.captured).toEqual([]);
    expect(r.asked).toEqual([]);
  });

  it('looks at a chat app the user allowed', async () => {
    const r = rig({ settings: { enabled: true, apps: {} }, windows: [WHATSAPP, CALC] });
    const out = await r.run('describe_screen', { confirm: true });
    expect(out.ok).toBe(true);
    expect(r.captured).toEqual(['window:(2) WhatsApp - Google Chrome']);
  });

  it('the whole screen is refused while a switched-off chat app is showing, but allowed if it is minimised', async () => {
    const showing = rig({ windows: [CALC, WHATSAPP] });
    const out = await showing.run('describe_screen', { target: 'screen', confirm: true });
    expect(out.ok).toBe(false);
    expect(out.data).toMatchObject({ app: 'WhatsApp', nothingWasRead: true });
    expect(showing.captured).toEqual([]);
    const hidden = rig({ windows: [CALC, { ...WHATSAPP, state: 'minimized' }] });
    expect((await hidden.run('describe_screen', { target: 'screen', confirm: true })).ok).toBe(true);
    expect(hidden.captured).toEqual(['screen']);
  });

  it('says so when it cannot look (no Gemini key, no capture, or a failure), instead of inventing', async () => {
    expect((await rig({ withBrain: false }).run('describe_screen', { confirm: true })).summary).toBe('not available');
    const broken = rig();
    broken.brain.answer = new Error('quota');
    const out = await broken.run('describe_screen', { confirm: true });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/quota/);
    const empty = rig();
    empty.brain.answer = '   ';
    expect((await empty.run('describe_screen', { confirm: true })).summary).toBe('could not read it');
  });

  it('a window that cannot be captured is reported plainly', async () => {
    // (the real capturer throws for a minimised window)
    const shaky = createScreenTools({
      control: { list: async () => [CALC], info: async () => CALC, act: async () => ({ after: CALC, sent: true }) },
      ui: { list: async () => ({ elements: [], truncated: false }), act: async () => ({ ok: true, how: 'invoke' }), clickAt: async () => undefined },
      screen: { screen: async () => Promise.reject(new ScreenCaptureError('nope')), window: async () => Promise.reject(new ScreenCaptureError('Windows would not let Eya capture it.')) },
      brain: { analyzeFile: async () => 'x' },
      policy: new CommunicationPolicy(() => COMMUNICATION_OFF),
      ownPids: () => [],
    });
    const out = await (shaky.find((t) => t.schema.name === 'describe_screen') as Tool).execute({ confirm: true });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('Windows would not let Eya capture it.');
  });
});

describe('screen_elements: what the window is made of', () => {
  it('lists the named, showing controls with where they are and what can be done — not unnamed, hidden or password ones', async () => {
    const r = rig();
    const out = await r.run('screen_elements', {});
    expect(out.ok).toBe(true);
    expect(out.data?.['window']).toBe('Calculator');
    const controls = out.data?.['controls'] as Array<{ n: number; type: string; name: string; where: string; canDo?: string[]; disabled?: boolean }>;
    const names = controls.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['Seven', 'Plus', 'Delete', 'Display is 0']));
    expect(names).not.toContain('Hidden thing');
    expect(names).not.toContain('Password');
    expect(controls.find((c) => c.name === 'Seven')).toMatchObject({ type: 'Button', where: 'bottom left', canDo: ['invoke'] });
    expect(controls.find((c) => c.name === 'Plus')?.where).toBe('bottom right');
    expect(controls.find((c) => c.name === 'Memory recall')).toMatchObject({ disabled: true });
    expect(JSON.stringify(out)).not.toMatch(/pw/);
  });

  it('can be narrowed by words in a name', async () => {
    const r = rig();
    const out = await r.run('screen_elements', { find: 'sev' });
    expect((out.data?.['controls'] as Array<{ name: string }>).map((c) => c.name)).toEqual(['Seven']);
    const none = await r.run('screen_elements', { find: 'zebra' });
    expect(none.ok).toBe(true);
    expect(none.data?.['controls']).toEqual([]);
  });

  it('is refused for a chat app that is switched off, and reads nothing', async () => {
    const r = rig({ windows: [WHATSAPP, CALC] });
    const out = await r.run('screen_elements', {});
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('communication access is off');
    expect(r.ui.listCalls).toBe(0);
  });

  it('never looks into Eya\'s own window, and says so when nothing else is open', async () => {
    const r = rig({ windows: [EYA] });
    const out = await r.run('screen_elements', {});
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('nothing open');
    expect(r.ui.listCalls).toBe(0);
  });
});

describe('screen_click: act on one control, then check what changed', () => {
  async function listed(r: Rig) {
    await r.run('screen_elements', {});
    return r;
  }

  it('needs a listing first', async () => {
    const out = await rig().run('screen_click', { name: 'Seven' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('look first');
  });

  it('clicks a control by name with its own button-press, and reports what the window now says', async () => {
    const r = await listed(rig());
    r.ui.afterAct = () => void (r.ui.elements = calculator('Display is 7'));
    const out = await r.run('screen_click', { name: 'Seven' });
    expect(out.ok).toBe(true);
    expect(out.data).toMatchObject({ clicked: 'Seven', how: 'invoke', changed: true, nowReads: [{ was: 'Display is 0', now: 'Display is 7' }] });
    expect(r.ui.actCalls).toEqual([{ handle: 100, index: 2 }]);
    expect(r.ui.clicks).toEqual([]);
  });

  /** The number the listing gave a control (numbers are only good for the look they came from). */
  async function numberOf(r: Rig, name: string): Promise<number> {
    const out = await r.run('screen_elements', {});
    const found = (out.data?.['controls'] as Array<{ n: number; name: string }>).find((c) => c.name === name);
    if (found === undefined) throw new Error(`no control ${name}`);
    return found.n;
  }

  it('by number too', async () => {
    const r = rig();
    const out = await r.run('screen_click', { n: await numberOf(r, 'Plus') });
    expect(out.data).toMatchObject({ clicked: 'Plus' });
  });

  it('a number from before a click is refused after it — it must never land on a different control', async () => {
    const r = rig();
    const plus = await numberOf(r, 'Plus');
    r.ui.afterAct = () => void (r.ui.elements = calculator('Display is 7'));
    expect((await r.run('screen_click', { name: 'Seven' })).ok).toBe(true);
    const stale = await r.run('screen_click', { n: plus });
    expect(stale.ok).toBe(false);
    expect(stale.summary).toBe('old number');
    expect(String(stale.error)).toMatch(/earlier look/);
    expect(r.ui.actCalls).toHaveLength(1); // only the Seven click; nothing was clicked by the old number
    // The same control by its number from a fresh look works.
    const fresh = await numberOf(r, 'Plus');
    expect(fresh).not.toBe(plus);
    expect((await r.run('screen_click', { n: fresh })).data).toMatchObject({ clicked: 'Plus' });
  });

  it('a made-up number is not a control', async () => {
    const r = await listed(rig());
    expect((await r.run('screen_click', { n: 3 })).summary).toBe('old number');
    expect((await r.run('screen_click', { n: -4 })).ok).toBe(false);
    expect(r.ui.actCalls).toEqual([]);
  });

  it('says plainly when nothing visibly changed — never "done" just because it was clicked', async () => {
    const r = await listed(rig());
    const out = await r.run('screen_click', { name: 'Plus' });
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('clicked "Plus", but nothing visibly changed');
    expect(out.data).toMatchObject({ changed: false });
    expect(String(out.data?.['note'])).toMatch(/Look again/);
  });

  it('a control with no button-press is clicked with the mouse at its centre, after bringing the window to the front', async () => {
    const r = await listed(rig());
    r.ui.outcome = { ok: false, reason: 'needs_mouse', x: 850, y: 550 };
    const out = await r.run('screen_click', { name: 'Plus' });
    expect(out.data).toMatchObject({ how: 'mouse' });
    expect(r.focused).toEqual([100]);
    expect(r.ui.clicks).toEqual([[850, 550]]);
  });

  it('something that would send or delete asks first, and clicks nothing', async () => {
    const r = await listed(rig());
    const out = await r.run('screen_click', { name: 'Delete' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('needs confirmation');
    expect(out.error).toMatch(/deleting something/);
    expect(r.ui.actCalls).toEqual([]);
    const yes = await r.run('screen_click', { name: 'Delete', confirm: true });
    expect(yes.ok).toBe(true);
    expect(r.ui.actCalls).toHaveLength(1);
  });

  it('two controls with the same name come back to be chosen between, never picked', async () => {
    const r = rig();
    r.ui.elements = [
      ...calculator(),
      el({ type: 'Button', name: 'Seven', automationId: 'num7b', x: 500, y: 100, width: 100, height: 50, actions: ['invoke'] }),
    ];
    await r.run('screen_elements', {});
    const out = await r.run('screen_click', { name: 'Seven' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('which one?');
    expect((out.data?.['candidates'] as unknown[]).length).toBe(2);
    expect(r.ui.actCalls).toEqual([]);
  });

  it('refuses a password field, a switched-off control, one that is not there, and nothing named', async () => {
    const r = rig();
    const listing = await r.run('screen_elements', {});
    expect(JSON.stringify(listing)).not.toContain('"Password"'); // the password field is not even offered
    const base = (listing.data?.['controls'] as Array<{ n: number; name: string }>).find((c) => c.name === 'Seven')?.n as number;
    const genBase = base - (base % 100_000);
    expect((await r.run('screen_click', { n: genBase + 7 })).summary).toBe('not allowed'); // a password field, asked for by its number
    expect((await r.run('screen_click', { n: genBase + 6 })).summary).toBe('disabled');
    expect((await r.run('screen_click', { n: genBase + 999 })).summary).toBe('no such control');
    expect((await r.run('screen_click', { name: 'zebra' })).summary).toBe('no such control');
    expect((await r.run('screen_click', {})).summary).toBe('which control?');
    expect(r.ui.actCalls).toEqual([]);
  });

  it('when the window changed since the listing, it says to look again instead of clicking something else', async () => {
    const r = await listed(rig());
    r.ui.outcome = { ok: false, reason: 'stale', detail: 'Button Eight' };
    const stale = await r.run('screen_click', { name: 'Seven' });
    expect(stale.ok).toBe(false);
    expect(String(stale.error)).toMatch(/Call screen_elements again/);
    r.windows[1] = { ...CALC, title: 'Calculator - Scientific' };
    const renamed = await r.run('screen_click', { name: 'Seven' });
    expect(renamed.summary).toBe('the window changed');
  });

  it('says when the window is gone', async () => {
    const r = await listed(rig());
    r.windows.length = 0;
    expect((await r.run('screen_click', { name: 'Seven' })).summary).toBe('window gone');
  });

  it('refuses at click time if the chat app was switched off after the listing', async () => {
    const r = rig({ settings: { enabled: true, apps: {} }, windows: [WHATSAPP] });
    r.ui.elements = calculator();
    await r.run('screen_elements', {});
    r.setPolicy(COMMUNICATION_OFF);
    const out = await r.run('screen_click', { name: 'Seven' });
    expect(out.ok).toBe(false);
    expect(out.summary).toBe('communication access is off');
    expect(r.ui.actCalls).toEqual([]);
  });

  it('a listing that is too old is not trusted', async () => {
    const clock = { t: 1_000_000 };
    const control: WindowControl = { list: async () => [CALC], info: async () => CALC, act: async () => ({ after: CALC, sent: true }) };
    const ui: UiAutomation = { list: async () => ({ elements: calculator(), truncated: false }), act: async () => ({ ok: true, how: 'invoke' }), clickAt: async () => undefined };
    const tools = createScreenTools({ control, ui, policy: new CommunicationPolicy(() => COMMUNICATION_OFF), ownPids: () => [], now: () => clock.t, sleep: async () => undefined });
    const run = (n: string, a: ToolArgs = {}) => (tools.find((t) => t.schema.name === n) as Tool).execute(a);
    await run('screen_elements');
    clock.t += 3 * 60_000;
    expect((await run('screen_click', { name: 'Seven' })).summary).toBe('look first');
  });

  it('after a click, the next one is judged against the fresh look, not the old one', async () => {
    const r = await listed(rig());
    r.ui.afterAct = () => void (r.ui.elements = calculator('Display is 7'));
    await r.run('screen_click', { name: 'Seven' });
    r.ui.afterAct = () => void (r.ui.elements = calculator('Display is 77'));
    const second = await r.run('screen_click', { name: 'Seven' });
    expect(second.data).toMatchObject({ changed: true, nowReads: [{ was: 'Display is 7', now: 'Display is 77' }] });
  });
});

describe('the small parts', () => {
  it('says where something is in the window', () => {
    const w = { x: 0, y: 0, width: 900, height: 900 };
    expect(whereIn(w, { x: 10, y: 10, width: 50, height: 50 })).toBe('top left');
    expect(whereIn(w, { x: 840, y: 840, width: 50, height: 50 })).toBe('bottom right');
    expect(whereIn(w, { x: 425, y: 425, width: 50, height: 50 })).toBe('centre');
    expect(whereIn(w, { x: 425, y: 10, width: 50, height: 50 })).toBe('top centre');
    expect(whereIn(w, { x: 10, y: 425, width: 50, height: 50 })).toBe('middle left');
    expect(whereIn({ x: 0, y: 0, width: 0, height: 0 }, { x: 1, y: 1, width: 1, height: 1 })).toBe('somewhere in the window');
  });

  it('finds what changed between two looks: changed in place, appeared, gone', () => {
    const before = [el({ type: 'Text', name: 'Display is 0', automationId: 'r' }), el({ type: 'Button', name: 'Old', automationId: 'old' })];
    const after = [el({ type: 'Text', name: 'Display is 7', automationId: 'r' }), el({ type: 'Button', name: 'New', automationId: 'new' })];
    expect(diffListings(before, after)).toEqual({ changed: [{ was: 'Display is 0', now: 'Display is 7' }], appeared: ['New'], gone: ['Old'] });
    expect(diffListings(before, before)).toEqual({ changed: [], appeared: [], gone: [] });
  });
});
