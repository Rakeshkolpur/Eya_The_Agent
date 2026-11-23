import { describe, it, expect } from 'vitest';
import {
  WINDOW_ACTIONS,
  createWindowControl,
  parseActResult,
  parseWindowList,
  parseWindowRow,
  windowActScript,
  windowInfoScript,
  windowListScript,
} from '../src/main/windowsApi/windowControl';
import { appLabel, isActable, matchWindows } from '../src/main/windowsApi/windowMatch';
import type { WindowInfo } from '../src/main/windowsApi/windowControl';

const row = (h: number, pid: number, proc: string, state: string, fg: 0 | 1, w: number, ht: number, title: string) => [h, pid, proc, state, fg, w, ht, title].join('\t');

function win(over: Partial<WindowInfo> & Pick<WindowInfo, 'handle'>): WindowInfo {
  return { pid: over.handle, process: 'notepad', state: 'normal', foreground: false, width: 800, height: 600, title: 'Untitled - Notepad', ...over };
}

describe('reading what Windows reports', () => {
  it('parses a window row into a window', () => {
    expect(parseWindowRow(row(132532, 4100, 'chrome', 'maximized', 1, 1920, 1040, 'Inbox - Google Chrome'))).toEqual({
      handle: 132532,
      pid: 4100,
      process: 'chrome',
      state: 'maximized',
      foreground: true,
      width: 1920,
      height: 1040,
      title: 'Inbox - Google Chrome',
    });
  });

  it('keeps a title that itself contained tabs, and refuses rows that are not windows', () => {
    expect(parseWindowRow(`${row(5, 6, 'x', 'normal', 0, 1, 1, 'a')}\tb`)?.title).toBe('a b');
    for (const bad of ['', 'garbage', row(0, 6, 'x', 'normal', 0, 1, 1, 't'), row(5, 6, 'x', 'sideways', 0, 1, 1, 't'), 'a\tb\tc']) expect(parseWindowRow(bad), bad).toBeNull();
  });

  it('parses a list, skipping blank and broken rows', () => {
    const list = parseWindowList([row(1, 10, 'a', 'normal', 1, 1, 1, 'One'), '', 'junk', row(2, 11, 'b', 'minimized', 0, 1, 1, 'Two')].join('\r\n'));
    expect(list.map((w) => [w.handle, w.state, w.foreground])).toEqual([
      [1, 'normal', true],
      [2, 'minimized', false],
    ]);
  });

  it('reads the result of an action: sent and where the window is now, or gone, or not sent at all', () => {
    expect(parseActResult(`sent\n${row(7, 8, 'notepad', 'minimized', 0, 100, 50, 'T')}`)).toMatchObject({ sent: true, after: { handle: 7, state: 'minimized' } });
    expect(parseActResult('sent\ngone')).toEqual({ sent: true, after: null });
    expect(parseActResult('sent')).toEqual({ sent: true, after: null });
    expect(parseActResult('gone')).toEqual({ sent: false, after: null });
    expect(parseActResult('')).toEqual({ sent: false, after: null });
    expect(parseActResult('unknown')).toEqual({ sent: false, after: null });
  });
});

describe('the scripts that ask Windows', () => {
  it('list: a compiled helper, run, with the here-string closed at the start of a line', () => {
    const s = windowListScript();
    expect(s.startsWith("Add-Type -TypeDefinition @'")).toBe(true);
    expect(s).toContain("\n'@\n");
    expect(s.endsWith('[EyaWin]::List()')).toBe(true);
    expect(s).toContain('EnumWindows');
    expect(s).toContain('SetProcessDPIAware'); // real pixels at 125% scaling
  });

  it('acts politely: close is WM_CLOSE (the X button), never a kill', () => {
    const s = windowActScript(777, 'close', 2000);
    expect(s).toContain("[EyaWin]::Act(777, 'close', 2000)");
    expect(s).toContain('0x10'); // WM_CLOSE
    expect(s).not.toMatch(/TerminateProcess|Stop-Process|taskkill|\.Kill\(/i);
  });

  it('lets only a handle number, a known action and a bounded wait reach the script', () => {
    for (const h of [0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() => windowInfoScript(h)).toThrow();
      expect(() => windowActScript(h, 'focus', 100)).toThrow();
    }
    expect(() => windowActScript(5, "focus'; calc; '" as never, 100)).toThrow();
    expect(() => windowActScript(5, 'delete' as never, 100)).toThrow();
    expect(windowActScript(5, 'focus', 999_999)).toContain(', 10000)'); // clamped
    expect(windowActScript(5, 'focus', -5)).toContain(', 0)');
    expect([...WINDOW_ACTIONS].sort()).toEqual(['close', 'focus', 'maximize', 'minimize', 'restore']);
  });

  it('runs the right script for each call and reads the answer', async () => {
    const seen: string[] = [];
    const control = createWindowControl(async (script) => {
      seen.push(script);
      if (script.includes('::List()')) return `${row(1, 2, 'chrome', 'normal', 1, 10, 10, 'A')}\n`;
      if (script.includes('::Info(')) return script.includes('Info(9)') ? 'gone' : row(3, 4, 'notepad', 'normal', 0, 5, 5, 'B');
      return `sent\n${row(3, 4, 'notepad', 'minimized', 0, 5, 5, 'B')}`;
    });
    expect((await control.list()).map((w) => w.process)).toEqual(['chrome']);
    expect((await control.info(3))?.title).toBe('B');
    expect(await control.info(9)).toBeNull();
    expect((await control.act(3, 'minimize')).after?.state).toBe('minimized');
    expect(seen).toHaveLength(4);
  });
});

describe('which window does the user mean', () => {
  const windows = [
    win({ handle: 1, process: 'chrome', title: 'Inbox - Google Chrome', foreground: true }),
    win({ handle: 2, process: 'WINWORD', title: 'report.docx - Word' }),
    win({ handle: 3, process: 'chrome', title: 'Docs - Google Chrome' }),
    win({ handle: 4, process: 'ApplicationFrameHost', title: 'Calculator' }),
    win({ handle: 5, process: 'notepad', title: 'notes.txt - Notepad' }),
    win({ handle: 6, process: 'msedge', title: 'Maps - Microsoft Edge' }),
  ];

  it('maps what people say to the real program: "Word" is WINWORD, "Edge" is msedge', () => {
    expect(matchWindows(windows, 'Word').best?.handle).toBe(2);
    expect(matchWindows(windows, 'microsoft word').best?.handle).toBe(2);
    expect(matchWindows(windows, 'edge').best?.handle).toBe(6);
    expect(matchWindows(windows, 'the Chrome app').matches.map((w) => w.handle)).toEqual([1, 3]);
    expect(matchWindows(windows, 'Chrome').by).toBe('process');
  });

  it('with several windows of one program, the one in front wins', () => {
    expect(matchWindows(windows, 'chrome').best?.handle).toBe(1);
    const noneInFront = windows.map((w) => ({ ...w, foreground: false }));
    expect(matchWindows(noneInFront, 'chrome').best?.handle).toBe(1); // otherwise the frontmost in the list
    expect(matchWindows([windows[2] as WindowInfo, ...windows], 'chrome').best?.handle).toBe(1); // foreground beats list order
  });

  it('falls back to the title, for apps that all run inside a host process', () => {
    const r = matchWindows(windows, 'calculator');
    expect(r.best?.handle).toBe(4);
    expect(r.by).toBe('title');
    expect(matchWindows(windows, 'report.docx').best?.handle).toBe(2);
    expect(matchWindows(windows, 'DOCS').best?.handle).toBe(3);
  });

  it('exact means the whole title', () => {
    expect(matchWindows(windows, 'Calculator', { exact: true }).best?.handle).toBe(4);
    expect(matchWindows(windows, 'Calc', { exact: true }).best).toBeNull();
    expect(matchWindows(windows, 'notes.txt - notepad', { exact: true }).best?.handle).toBe(5);
  });

  it('finds nothing rather than something near, and never an empty query', () => {
    expect(matchWindows(windows, 'photoshop').matches).toEqual([]);
    expect(matchWindows(windows, '   ').best).toBeNull();
    expect(matchWindows(windows, 'the').best).toBeNull();
    expect(matchWindows([], 'chrome').best).toBeNull();
  });

  it('never offers Eya\'s own windows or the desktop', () => {
    const own = new Set([5]);
    expect(isActable(windows[4] as WindowInfo, own)).toBe(false);
    expect(isActable(windows[0] as WindowInfo, own)).toBe(true);
    expect(isActable(win({ handle: 9, process: 'explorer', title: 'Program Manager' }), new Set())).toBe(false);
    expect(isActable(win({ handle: 10, process: 'explorer', title: 'Downloads' }), new Set())).toBe(true);
  });

  it('names an application the way a person would', () => {
    expect(appLabel(windows[1] as WindowInfo)).toBe('Word');
    expect(appLabel(windows[5] as WindowInfo)).toBe('Edge');
    expect(appLabel(windows[3] as WindowInfo)).toBe('Calculator'); // a Store app: the title says more than "ApplicationFrameHost"
    expect(appLabel(win({ handle: 1, process: 'obscure' }))).toBe('obscure');
    expect(appLabel(win({ handle: 1, process: '' }))).toBe('an application');
  });
});
