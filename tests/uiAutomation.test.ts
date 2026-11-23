import { describe, it, expect } from 'vitest';
import { actScript, clickScript, createUiAutomation, listScript, parseListing, parseOutcome } from '../src/main/screen/uiAutomation';

const row = (f: Array<string | number>) => f.join('\t');

describe('reading what Windows reports about a window', () => {
  const out = [
    'COUNT=5',
    row([3, 'Button', 'Minimize Calculator', 'Minimize', 1, 0, 1168, 1, 57, 40, 'I', 0]),
    row([13, 'Text', 'Display is 12', 'CalculatorResults', 1, 0, 59, 147, 880, 149, 'I', 0]),
    row([20, 'Edit', 'Password', 'pw', 1, 0, 10, 10, 100, 20, 'V', 1]),
    row([21, 'CheckBox', 'Remember me', 'rm', 0, 1, 0, 0, 0, 0, 'TS', 0]),
    'garbage line',
    row(['x', 'Button', 'not a number', '', 1, 0, 0, 0, 0, 0, '', 0]),
  ].join('\r\n');

  it('turns each line into an element: kind, name, place, what can be done to it', () => {
    const listing = parseListing(out, 300);
    expect(listing.elements).toHaveLength(4);
    expect(listing.elements[0]).toEqual({ index: 3, type: 'Button', name: 'Minimize Calculator', automationId: 'Minimize', enabled: true, offscreen: false, x: 1168, y: 1, width: 57, height: 40, actions: ['invoke'], password: false });
    expect(listing.elements[3]).toMatchObject({ type: 'CheckBox', enabled: false, offscreen: true, actions: ['toggle', 'select'] });
  });

  it('never reports a password field\'s name or contents', () => {
    const pw = parseListing(out, 300).elements.find((e) => e.automationId === 'pw');
    expect(pw).toMatchObject({ password: true, name: '' });
  });

  it('survives junk: lines that are not elements are skipped, and an empty answer is an empty window', () => {
    expect(parseListing('', 300).elements).toEqual([]);
    expect(parseListing('nonsense', 300).elements).toEqual([]);
    expect(parseListing('COUNT=0', 300).truncated).toBe(false);
  });

  it('says when there were more elements than were listed', () => {
    expect(parseListing('COUNT=900', 300).truncated).toBe(true);
    expect(parseListing('COUNT=4', 300).truncated).toBe(false);
  });

  it('caps what the window can make Eya hold: long names are cut', () => {
    const long = parseListing(`COUNT=1\n${row([1, 'Text', 'x'.repeat(500), 'a'.repeat(300), 1, 0, 0, 0, 1, 1, '', 0])}`, 300).elements[0];
    expect(long?.name.length).toBe(160);
    expect(long?.automationId.length).toBe(80);
  });
});

describe('what happened when an element was acted on', () => {
  it('knows each way it can go', () => {
    expect(parseOutcome('OK invoke\r\n')).toEqual({ ok: true, how: 'invoke' });
    expect(parseOutcome('OK toggle')).toEqual({ ok: true, how: 'toggle' });
    expect(parseOutcome('OK select')).toEqual({ ok: true, how: 'select' });
    expect(parseOutcome('OK expand')).toEqual({ ok: true, how: 'expand' });
    expect(parseOutcome('MOUSE 640 480')).toEqual({ ok: false, reason: 'needs_mouse', x: 640, y: 480 });
    expect(parseOutcome('GONE')).toEqual({ ok: false, reason: 'gone' });
    expect(parseOutcome('DISABLED')).toEqual({ ok: false, reason: 'disabled' });
    expect(parseOutcome('OFFSCREEN')).toEqual({ ok: false, reason: 'offscreen' });
    expect(parseOutcome('NOWAY')).toEqual({ ok: false, reason: 'no_way' });
    expect(parseOutcome('STALE Button Seven')).toEqual({ ok: false, reason: 'stale', detail: 'Button Seven' });
  });

  it('treats anything unrecognised as "no way to do it", never as success', () => {
    for (const odd of ['', 'OK', 'OK delete', 'done', 'MOUSE x y']) expect(parseOutcome(odd).ok, odd).toBe(false);
  });
});

describe('the scripts it runs', () => {
  it('only ever take a plain number for the window and element, and quote the name safely', () => {
    expect(() => listScript(Number.NaN, 10)).toThrow();
    expect(() => listScript(-5, 10)).toThrow();
    expect(() => listScript(1.5, 10)).toThrow();
    expect(() => actScript(100, -1, 'x', 'Button')).toThrow();
    expect(() => actScript(0, 1, 'x', 'Button')).toThrow();
    const script = actScript(4242, 7, "Rahul's $(calc) button", 'Button');
    expect(script).toContain("'Rahul''s $(calc) button'");
    expect(script).toContain('[IntPtr]4242');
    expect(script).toContain('$all[7]');
  });

  it('clamps how much it reads, and lists with the same walk it acts with (so "element 12" means the same thing)', () => {
    expect(listScript(10, 100000)).toContain('-ge 800');
    expect(listScript(10, 0)).toContain('-ge 1');
    const walk = (s: string) => /\$AE=\[System\.Windows\.Automation\.AutomationElement\];[\s\S]*?\$all=[^;]*;/.exec(s)?.[0];
    expect(walk(listScript(99, 50))).toBe(walk(actScript(99, 3, 'a', 'Button')));
  });

  it('a mouse click needs real coordinates', () => {
    expect(() => clickScript(Number.NaN, 5)).toThrow();
    expect(clickScript(10.4, 20.6)).toContain('SetCursorPos(10,21)');
  });
});

describe('the wrapper', () => {
  it('lists, acts and clicks through whatever runs the scripts', async () => {
    const seen: string[] = [];
    const ui = createUiAutomation(async (script) => {
      seen.push(script);
      if (script.includes('COUNT=')) return `COUNT=1\n${row([1, 'Button', 'OK', 'ok', 1, 0, 0, 0, 10, 10, 'I', 0])}`;
      if (script.includes('EyaMouse')) return 'CLICKED';
      return 'OK invoke';
    });
    expect((await ui.list(5)).elements).toHaveLength(1);
    expect(await ui.act(5, { index: 1, name: 'OK', type: 'Button' })).toEqual({ ok: true, how: 'invoke' });
    await expect(ui.clickAt(3, 4)).resolves.toBeUndefined();
    expect(seen).toHaveLength(3);
  });

  it('a click that Windows did not take is an error', async () => {
    const ui = createUiAutomation(async () => 'nothing');
    await expect(ui.clickAt(1, 1)).rejects.toThrow(/did not accept/);
  });
});
