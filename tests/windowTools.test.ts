import { describe, it, expect } from 'vitest';
import type { BrowserTabInfo } from '../src/main/browser/pageEffects';
import { createWindowTools, reachedState } from '../src/main/tools/impl/windowTools';
import type { WindowToolDeps } from '../src/main/tools/impl/windowTools';
import type { WindowAction, WindowControl, WindowInfo } from '../src/main/windowsApi/windowControl';

function win(over: Partial<WindowInfo> & Pick<WindowInfo, 'handle'>): WindowInfo {
  return { pid: over.handle * 10, process: 'notepad', state: 'normal', foreground: false, width: 800, height: 600, title: 'Untitled - Notepad', ...over };
}

/** A pretend desktop whose windows really change state when acted on, so the tools are checked against behaviour, not against a script. */
class FakeDesktop implements WindowControl {
  acts: Array<[number, WindowAction]> = [];
  /** Actions Windows quietly ignores (a window of an elevated program, an app waiting to save). */
  ignore = new Set<WindowAction>();
  constructor(public windows: WindowInfo[]) {}
  async list(): Promise<readonly WindowInfo[]> {
    return this.windows;
  }
  async info(handle: number): Promise<WindowInfo | null> {
    return this.windows.find((w) => w.handle === handle) ?? null;
  }
  async act(handle: number, action: WindowAction): Promise<{ after: WindowInfo | null; sent: boolean }> {
    this.acts.push([handle, action]);
    const w = this.windows.find((x) => x.handle === handle);
    if (w === undefined) return { after: null, sent: false };
    if (!this.ignore.has(action)) {
      if (action === 'minimize') this.set(handle, { state: 'minimized', foreground: false });
      else if (action === 'maximize') this.set(handle, { state: 'maximized' });
      else if (action === 'restore') this.set(handle, { state: w.state === 'minimized' ? 'normal' : 'normal' });
      else if (action === 'focus') {
        this.windows = this.windows.map((x) => ({ ...x, foreground: x.handle === handle }));
        this.set(handle, { state: w.state === 'minimized' ? 'normal' : w.state });
      } else if (action === 'close') this.windows = this.windows.filter((x) => x.handle !== handle);
    }
    const after = this.windows.find((x) => x.handle === handle) ?? null;
    return { after, sent: true };
  }
  private set(handle: number, patch: Partial<WindowInfo>): void {
    this.windows = this.windows.map((w) => (w.handle === handle ? { ...w, ...patch } : w));
  }
}

function tools(desktop: FakeDesktop, extra: Partial<WindowToolDeps> = {}) {
  const [list, control] = createWindowTools({ control: desktop, ownPids: () => [], ...extra });
  return { list: list as NonNullable<typeof list>, control: control as NonNullable<typeof control> };
}

const chrome = (over: Partial<WindowInfo> = {}) => win({ handle: 1, process: 'chrome', title: 'Inbox - Google Chrome', foreground: true, ...over });
const word = (over: Partial<WindowInfo> = {}) => win({ handle: 2, process: 'WINWORD', title: 'report.docx - Word', ...over });

describe('list_windows', () => {
  it('lists what is open with each application, state and which is in front — and never Eya herself', async () => {
    const d = new FakeDesktop([chrome(), word({ state: 'minimized' }), win({ handle: 3, process: 'electron', title: 'Eya', pid: 999 })]);
    const r = await tools(d, { ownPids: () => [999] }).list.execute({});
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('2 windows open');
    expect(r.data?.['windows']).toEqual([
      { app: 'Chrome', title: 'Inbox - Google Chrome', state: 'normal', inFront: true },
      { app: 'Word', title: 'report.docx - Word', state: 'minimized', inFront: false },
    ]);
    expect(r.data?.['inFront']).toEqual({ app: 'Chrome', title: 'Inbox - Google Chrome' });
  });

  it('shows titles the way the privacy layer says to', async () => {
    const d = new FakeDesktop([chrome({ title: 'Rahul Sharma - Telegram' })]);
    const r = await tools(d, { describeTitle: () => '(private app)' }).list.execute({});
    expect(JSON.stringify(r)).not.toContain('Rahul');
    expect((r.data?.['windows'] as Array<{ title: string }>)[0]?.title).toBe('(private app)');
  });

  it('caps a very long list and says how many more', async () => {
    const d = new FakeDesktop(Array.from({ length: 45 }, (_, i) => win({ handle: i + 1, title: `W${i}`, process: 'p' })));
    const r = await tools(d).list.execute({});
    expect((r.data?.['windows'] as unknown[]).length).toBe(30);
    expect(r.data?.['more']).toBe(15);
  });

  it('says honestly when Windows could not be asked', async () => {
    const d = new FakeDesktop([]);
    d.list = async () => {
      throw new Error('powershell blocked');
    };
    expect(await tools(d).list.execute({})).toMatchObject({ ok: false, summary: 'could not check windows' });
  });
});

describe('window_control: each action really happens and is checked from the window\'s own state', () => {
  it('minimizes the window the user names', async () => {
    const d = new FakeDesktop([chrome(), word()]);
    const r = await tools(d).control.execute({ action: 'minimize', window: 'Chrome' });
    expect(r).toMatchObject({ ok: true, summary: 'Minimized Chrome', data: { stateBefore: 'normal', stateAfter: 'minimized', verified: true } });
    expect(d.acts).toEqual([[1, 'minimize']]);
    expect(d.windows.find((w) => w.handle === 1)?.state).toBe('minimized');
  });

  it('maximizes Word, restores it, and brings it to the front', async () => {
    const d = new FakeDesktop([chrome(), word()]);
    const t = tools(d);
    expect(await t.control.execute({ action: 'maximize', window: 'Word' })).toMatchObject({ ok: true, summary: 'Maximized Word', data: { stateAfter: 'maximized' } });
    expect(await t.control.execute({ action: 'restore', window: 'Word' })).toMatchObject({ ok: true, summary: 'Restored Word', data: { stateAfter: 'normal' } });
    expect(await t.control.execute({ action: 'focus', window: 'Word' })).toMatchObject({ ok: true, summary: 'Switched to Word', data: { verified: true } });
    expect(d.windows.find((w) => w.handle === 2)?.foreground).toBe(true);
    expect(d.windows.find((w) => w.handle === 1)?.foreground).toBe(false);
  });

  it('switching to a minimised window brings it back as well as to the front', async () => {
    const d = new FakeDesktop([chrome(), word({ state: 'minimized' })]);
    const r = await tools(d).control.execute({ action: 'focus', window: 'word' });
    expect(r.ok).toBe(true);
    expect(d.windows.find((w) => w.handle === 2)).toMatchObject({ state: 'normal', foreground: true });
  });

  it('closes politely and confirms it is really gone', async () => {
    const d = new FakeDesktop([chrome(), word()]);
    const r = await tools(d).control.execute({ action: 'close', window: 'report.docx' });
    expect(r).toMatchObject({ ok: true, summary: 'Closed Word', data: { stateAfter: 'closed', verified: true } });
    expect(d.windows.map((w) => w.handle)).toEqual([1]);
  });

  it('does NOT say it worked when Windows ignored the request — and says why it might have', async () => {
    const d = new FakeDesktop([chrome(), word()]);
    d.ignore = new Set(['minimize', 'maximize', 'focus']);
    const t = tools(d);
    for (const action of ['minimize', 'maximize'] as const) {
      const r = await t.control.execute({ action, window: 'Word' });
      expect(r.ok, action).toBe(false);
      expect(r.summary, action).toBe(`${action} did not take effect`);
      expect(r.data?.['verified']).toBe(false);
    }
    const focus = await t.control.execute({ action: 'focus', window: 'Word' });
    expect(focus).toMatchObject({ ok: false });
    expect(focus.error).toMatch(/could not be brought to the front/);
  });

  it('a close the app refuses (unsaved work) is reported as still open, not as done', async () => {
    const d = new FakeDesktop([word()]);
    d.ignore = new Set(['close']);
    const r = await tools(d).control.execute({ action: 'close', window: 'Word' });
    expect(r).toMatchObject({ ok: false, summary: 'still open', data: { reason: 'still_open', verified: false } });
    expect(r.error).toMatch(/save/);
  });

  it('does nothing, truthfully, when it is already so', async () => {
    const d = new FakeDesktop([chrome({ state: 'minimized', foreground: false }), word({ state: 'maximized' })]);
    const t = tools(d);
    expect(await t.control.execute({ action: 'minimize', window: 'Chrome' })).toMatchObject({ ok: true, summary: 'Chrome was already minimized', data: { alreadyThere: true } });
    expect(await t.control.execute({ action: 'maximize', window: 'Word' })).toMatchObject({ ok: true, summary: 'Word was already maximized' });
    expect(d.acts).toEqual([]); // and no pointless request was sent
  });

  it('with several windows of one app, acts on the one in front and says there are others; but never guesses which to CLOSE', async () => {
    const d = new FakeDesktop([chrome(), chrome({ handle: 3, title: 'Docs - Google Chrome', foreground: false })]);
    const t = tools(d);
    const minimize = await t.control.execute({ action: 'minimize', window: 'Chrome' });
    expect(minimize).toMatchObject({ ok: true, data: { title: 'Inbox - Google Chrome', otherWindowsOfThisApp: 1 } });
    const close = await t.control.execute({ action: 'close', window: 'Chrome' });
    expect(close).toMatchObject({ ok: false, summary: 'which one?' });
    expect((close.data?.['candidates'] as unknown[]).length).toBe(2);
    expect(d.windows.length).toBe(2); // nothing was closed
  });

  it('says what is open (by application, not by private titles) when it cannot find the window', async () => {
    const d = new FakeDesktop([chrome({ title: 'Salary slip - Google Chrome' }), word()]);
    const r = await tools(d).control.execute({ action: 'minimize', window: 'Photoshop' });
    expect(r).toMatchObject({ ok: false, summary: 'not open' });
    expect(r.data?.['openApps']).toEqual(['Chrome', 'Word']);
    expect(JSON.stringify(r)).not.toContain('Salary');
    expect(d.acts).toEqual([]);
  });

  it('never touches Eya\'s own window', async () => {
    const d = new FakeDesktop([win({ handle: 3, process: 'electron', title: 'Eya', pid: 999 })]);
    const r = await tools(d, { ownPids: () => [999] }).control.execute({ action: 'close', window: 'Eya' });
    expect(r.ok).toBe(false);
    expect(d.acts).toEqual([]);
  });

  it('refuses an unknown action or a missing window name, without touching anything', async () => {
    const d = new FakeDesktop([chrome()]);
    const t = tools(d);
    expect(await t.control.execute({ action: 'delete', window: 'Chrome' })).toMatchObject({ ok: false, summary: 'unknown action' });
    expect(await t.control.execute({ action: 'minimize' })).toMatchObject({ ok: false, summary: 'which window?' });
    expect(await t.control.execute({ action: 'minimize', window: '  ' })).toMatchObject({ ok: false, summary: 'which window?' });
    expect(d.acts).toEqual([]);
  });

  it('reports a failure to act honestly', async () => {
    const d = new FakeDesktop([chrome()]);
    d.act = async () => {
      throw new Error('boom');
    };
    expect(await tools(d).control.execute({ action: 'minimize', window: 'Chrome' })).toMatchObject({ ok: false, summary: 'minimize failed' });
  });
});

describe('"switch to WhatsApp" when it is a tab, not a window', () => {
  type Tab = { -readonly [K in keyof BrowserTabInfo]: BrowserTabInfo[K] }; // the pretend browser changes which tab is active
  const tab = (over: Partial<Tab> & Pick<Tab, 'tabId'>): Tab => ({
    browser: 'chrome',
    title: 'Some page',
    url: 'https://example.com/',
    active: false,
    openedByEya: false,
    workingHere: false,
    ...over,
  });

  function tabbed(desktop: FakeDesktop, tabs: Tab[], switchedTo: number[]) {
    return {
      listTabs: async () => tabs,
      switchToTab: async (id: number) => {
        switchedTo.push(id);
        tabs.forEach((t) => (t.active = t.tabId === id)); // the tab becomes the active one…
        desktop.windows = desktop.windows.map((w) => ({ ...w, foreground: w.process === 'chrome' })); // …and Chrome comes to the front
        return { secret: 'the page content, which must never be passed on' };
      },
    };
  }

  it('finds the tab by its address, switches to it, and checks both the tab and the browser are in front', async () => {
    const d = new FakeDesktop([chrome({ foreground: false }), word({ foreground: true })]);
    const tabs = [tab({ tabId: 7, title: 'Inbox', url: 'https://mail.example/', active: true }), tab({ tabId: 8, title: '(2) WhatsApp', url: 'https://web.whatsapp.com/' })];
    const switched: number[] = [];
    const r = await tools(d, { tabs: tabbed(d, tabs, switched) }).control.execute({ action: 'focus', window: 'WhatsApp' });
    expect(switched).toEqual([8]);
    expect(r).toMatchObject({ ok: true, summary: 'switched to the WhatsApp tab in Chrome', data: { via: 'browser tab', verified: true } });
    expect(JSON.stringify(r)).not.toContain('page content');
  });

  it('says so if the tab was switched but the browser did not come to the front', async () => {
    const d = new FakeDesktop([chrome({ foreground: false }), word({ foreground: true })]);
    const tabs = [tab({ tabId: 8, title: 'WhatsApp', url: 'https://web.whatsapp.com/' })];
    const t = { listTabs: async () => tabs, switchToTab: async (id: number) => void tabs.forEach((x) => (x.active = x.tabId === id)) };
    const r = await tools(d, { tabs: t }).control.execute({ action: 'focus', window: 'whatsapp' });
    expect(r).toMatchObject({ ok: false, summary: 'could not bring it to the front', data: { verified: false } });
  });

  it('only for switching, and only when no real window matched; with no such tab it is simply "not open"', async () => {
    const d = new FakeDesktop([word()]);
    const tabs = [tab({ tabId: 8, title: 'WhatsApp', url: 'https://web.whatsapp.com/' })];
    const switched: number[] = [];
    const t = tools(d, { tabs: tabbed(d, tabs, switched) });
    expect((await t.control.execute({ action: 'minimize', window: 'WhatsApp' })).summary).toBe('not open'); // a tab cannot be minimised
    expect(switched).toEqual([]);
    expect((await t.control.execute({ action: 'focus', window: 'Telegram' })).summary).toBe('not open');
    // a real window of that name wins over a tab
    const withApp = new FakeDesktop([win({ handle: 9, process: 'WhatsApp', title: 'WhatsApp' })]);
    const r = await tools(withApp, { tabs: tabbed(withApp, tabs, switched) }).control.execute({ action: 'focus', window: 'WhatsApp' });
    expect(r.data?.['via']).toBeUndefined();
    expect(switched).toEqual([]);
  });

  it('copes with no browser being connected', async () => {
    const d = new FakeDesktop([word()]);
    const t = {
      listTabs: async () => {
        throw new Error('not connected');
      },
      switchToTab: async () => undefined,
    };
    expect((await tools(d, { tabs: t }).control.execute({ action: 'focus', window: 'WhatsApp' })).summary).toBe('not open');
  });
});

describe('judging whether it worked', () => {
  const before = (state: WindowInfo['state']) => win({ handle: 1, state });
  it('looks only at the window after the action', () => {
    expect(reachedState('minimize', before('normal'), win({ handle: 1, state: 'minimized' }))).toBe(true);
    expect(reachedState('minimize', before('normal'), win({ handle: 1, state: 'normal' }))).toBe(false);
    expect(reachedState('maximize', before('normal'), win({ handle: 1, state: 'maximized' }))).toBe(true);
    expect(reachedState('restore', before('minimized'), win({ handle: 1, state: 'maximized' }))).toBe(true); // it was maximised before it was minimised
    expect(reachedState('restore', before('maximized'), win({ handle: 1, state: 'maximized' }))).toBe(false);
    expect(reachedState('restore', before('maximized'), win({ handle: 1, state: 'normal' }))).toBe(true);
    expect(reachedState('focus', before('normal'), win({ handle: 1, foreground: true }))).toBe(true);
    expect(reachedState('focus', before('normal'), win({ handle: 1, foreground: true, state: 'minimized' }))).toBe(false);
    expect(reachedState('focus', before('normal'), win({ handle: 1, foreground: false }))).toBe(false);
    expect(reachedState('close', before('normal'), null)).toBe(true);
    expect(reachedState('close', before('normal'), win({ handle: 1 }))).toBe(false);
    expect(reachedState('minimize', before('normal'), null)).toBe(false);
  });
});
