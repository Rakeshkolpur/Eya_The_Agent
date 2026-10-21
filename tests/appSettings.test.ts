import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realIo } from '../src/main/privacy/communicationAccessStore';
import { AppSettingsStore, DEFAULT_APP_SETTINGS, parseAppSettings, WindowStateStore } from '../src/main/settings/appSettings';
import { cleanSettingsPatch } from '../src/main/windows/snapshots';
import { buildMenuTemplate } from '../src/main/windows/trayMenu';
import type { MenuHost } from '../src/main/windows/trayMenu';
import { iconBitmap } from '../src/main/windows/iconBitmap';
import { currentHardware, readSavedPerformance } from '../src/main/perf/earlyProfile';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'eya-set-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const memoryIo = () => {
  const files = new Map<string, string>();
  return { files, io: { read: (p: string) => files.get(p) ?? null, write: (p: string, t: string) => void files.set(p, t) } };
};

describe('Eya\'s own settings', () => {
  it('start with the bubble shown, tap-to-talk on and a history kept — and a missing or damaged file means exactly that', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({ showBubble: true, tapToTalk: true, keepHistory: true, performance: 'auto', aiFirst: 'auto' });
    const { io } = memoryIo();
    expect(new AppSettingsStore('s.json', io).load()).toEqual(DEFAULT_APP_SETTINGS);
    const bad = memoryIo();
    bad.files.set('s.json', '{ not json');
    expect(new AppSettingsStore('s.json', bad.io).load()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('read only real booleans, field by field: a wrong type falls back to that field\'s default, never to "off"', () => {
    expect(parseAppSettings({ showBubble: false })).toEqual({ showBubble: false, tapToTalk: true, keepHistory: true, performance: 'auto', aiFirst: 'auto' });
    expect(parseAppSettings({ showBubble: 'no', tapToTalk: 0, keepHistory: null })).toEqual(DEFAULT_APP_SETTINGS);
    for (const junk of [null, undefined, 5, 'x', [], true]) expect(parseAppSettings(junk)).toEqual(DEFAULT_APP_SETTINGS);
  });

  it('save each change, tell the listeners, and keep working (for this run) if the disk refuses', () => {
    const { files, io } = memoryIo();
    const store = new AppSettingsStore('s.json', io);
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.showBubble));
    store.update({ showBubble: false });
    expect(JSON.parse(files.get('s.json') ?? '{}')).toEqual({ showBubble: false, tapToTalk: true, keepHistory: true, performance: 'auto', aiFirst: 'auto' });
    expect(seen).toEqual([false]);
    const broken = new AppSettingsStore('s.json', { read: () => null, write: () => { throw new Error('disk is read-only'); } });
    expect(broken.update({ keepHistory: false }).keepHistory).toBe(false);
    expect(broken.get().keepHistory).toBe(false);
  });

  it('survive a restart, and tolerate the byte-order mark that Notepad and PowerShell put at the start of a file', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    new AppSettingsStore(path).update({ tapToTalk: false });
    expect(new AppSettingsStore(path).load().tapToTalk).toBe(false);
    writeFileSync(path, '﻿{"showBubble": false}', 'utf8');
    expect(new AppSettingsStore(path).load().showBubble).toBe(false);
    expect(realIo.read(path)?.startsWith('{')).toBe(true);
  });

  it('a settings change from the page may only change booleans it knows', () => {
    expect(cleanSettingsPatch({ showBubble: false, tapToTalk: 'yes', keepHistory: true, evil: true, startWithWindows: true })).toEqual({
      patch: { showBubble: false, keepHistory: true },
      startWithWindows: true,
    });
    expect(cleanSettingsPatch({ startWithWindows: 'yes' })).toEqual({ patch: {} });
    // which AI is asked first: only the two real values get through (this was silently dropped once, so the choice never took)
    expect(cleanSettingsPatch({ aiFirst: 'backup' })).toEqual({ patch: { aiFirst: 'backup' } });
    expect(cleanSettingsPatch({ aiFirst: 'auto' })).toEqual({ patch: { aiFirst: 'auto' } });
    expect(cleanSettingsPatch({ aiFirst: 'gemini' })).toEqual({ patch: {} });
    for (const junk of [null, undefined, 3, 'x', []]) expect(cleanSettingsPatch(junk)).toEqual({ patch: {} });
  });
});

describe('where the bubble was left', () => {
  it('is remembered across restarts, and a missing, damaged or nonsense file means "no position"', () => {
    const dir = tmp();
    const path = join(dir, 'window-state.json');
    expect(new WindowStateStore(path).load()).toBeNull();
    new WindowStateStore(path).saveBubble({ x: 6.4, y: 347.6 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ bubble: { x: 6, y: 348 } });
    expect(new WindowStateStore(path).load()).toEqual({ x: 6, y: 348 });
    for (const bad of ['{ nope', '{"bubble":{"x":"a","y":2}}', '{"bubble":{"x":1}}', '{"bubble":null}', '[]']) {
      writeFileSync(path, bad, 'utf8');
      expect(new WindowStateStore(path).load(), bad).toBeNull();
    }
    writeFileSync(path, '﻿{"bubble":{"x":10,"y":20}}', 'utf8');
    expect(new WindowStateStore(path).load()).toEqual({ x: 10, y: 20 });
  });
});

describe('the tray and bubble menu', () => {
  const host = (over: Partial<MenuHost> = {}): MenuHost & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      chatsOn: () => false,
      turnChatsOff: () => void calls.push('chats off'),
      writingWatchOn: () => false,
      setWritingWatch: (on) => void calls.push(`writing ${on}`),
      showBubble: () => true,
      setShowBubble: (on) => void calls.push(`bubble ${on}`),
      startWithWindows: () => null,
      setStartWithWindows: (on) => void calls.push(`login ${on}`),
      openApp: (page) => void calls.push(`open ${page ?? ''}`.trim()),
      askEya: () => void calls.push('ask'),
      quit: () => void calls.push('quit'),
      ...over,
    };
  };
  const labels = (h: MenuHost) => buildMenuTemplate(h).map((i) => i.label ?? '---');
  const click = (h: MenuHost, label: string): void => void buildMenuTemplate(h).find((i) => i.label === label)?.click?.(undefined as never, undefined, undefined as never);

  it('offers Open, Ask, Chats, the bubble, and Quit — with Chats OFF leading to Settings, never switching it on', () => {
    const h = host();
    expect(labels(h)).toEqual(['Open Eya', 'Ask Eya', '---', 'Chats: OFF — set up in Settings…', 'Watch my writing (Word, Notepad)', 'Show the floating bubble', '---', 'Quit Eya']);
    click(h, 'Chats: OFF — set up in Settings…');
    expect(h.calls).toEqual(['open settings']);
  });

  it('Writing Watch is one click in the menu, both ways', () => {
    const off = host();
    click(off, 'Watch my writing (Word, Notepad)');
    expect(off.calls).toEqual(['writing true']);
    const on = host({ writingWatchOn: () => true });
    click(on, 'Watch my writing (Word, Notepad)');
    expect(on.calls).toEqual(['writing false']);
  });

  it('with Chats ON, one click turns it off', () => {
    const h = host({ chatsOn: () => true });
    expect(labels(h)).toContain('Chats: ON — turn off');
    click(h, 'Chats: ON — turn off');
    expect(h.calls).toEqual(['chats off']);
  });

  it('toggles the bubble, and offers Start with Windows only where it can work', () => {
    const h = host({ startWithWindows: () => false });
    expect(labels(h)).toContain('Start with Windows');
    click(h, 'Start with Windows');
    click(h, 'Show the floating bubble');
    click(h, 'Quit Eya');
    click(h, 'Open Eya');
    click(h, 'Ask Eya');
    expect(h.calls).toEqual(['login true', 'bubble false', 'quit', 'open', 'ask']);
    expect(labels(host())).not.toContain('Start with Windows');
  });
});

describe('the icon, drawn in code', () => {
  it('is a blue disc with soft edges and a transparent corner, in BGRA', () => {
    const size = 32;
    const px = iconBitmap(size);
    expect(px.length).toBe(size * size * 4);
    const at = (x: number, y: number) => ({ b: px[(y * size + x) * 4]!, g: px[(y * size + x) * 4 + 1]!, r: px[(y * size + x) * 4 + 2]!, a: px[(y * size + x) * 4 + 3]! });
    expect(at(0, 0).a).toBe(0);
    expect(at(31, 31).a).toBe(0);
    const middle = at(16, 16);
    expect(middle.a).toBe(255);
    expect(middle.b).toBeGreaterThan(middle.r); // blue, not grey
    expect(at(10, 10).b).toBeGreaterThan(at(22, 22).b); // lit from the upper left
    const edge = at(16, 0);
    expect(edge.a).toBeGreaterThan(0);
    expect(edge.a).toBeLessThan(255); // anti-aliased
  });
});

describe('the performance level setting', () => {
  it('is "auto" unless a known level was saved, and a wrong value never turns anything off', () => {
    expect(parseAppSettings({ performance: 'light' }).performance).toBe('light');
    for (const junk of [undefined, null, 5, 'LIGHT', 'turbo', {}, true]) expect(parseAppSettings({ performance: junk }).performance).toBe('auto');
  });

  it('only a known level gets through from the page', () => {
    expect(cleanSettingsPatch({ performance: 'full' }).patch).toEqual({ performance: 'full' });
    expect(cleanSettingsPatch({ performance: 'auto', showBubble: false }).patch).toEqual({ performance: 'auto', showBubble: false });
    for (const junk of ['turbo', 3, null, ['light'], { x: 1 }]) expect(cleanSettingsPatch({ performance: junk }).patch).toEqual({});
  });

  it('is saved with the other settings and survives a restart', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    new AppSettingsStore(path).update({ performance: 'light' });
    expect(new AppSettingsStore(path).load().performance).toBe('light');
    expect(new AppSettingsStore(path).load().showBubble).toBe(true); // the rest is untouched
  });

  it('can be read before Eya is ready, straight from the file, whatever state the file is in', () => {
    const dir = tmp();
    const path = join(dir, 'settings.json');
    expect(readSavedPerformance(path)).toBe('auto'); // no file
    writeFileSync(path, '{ not json');
    expect(readSavedPerformance(path)).toBe('auto');
    writeFileSync(path, JSON.stringify({ showBubble: true, performance: 'light' }));
    expect(readSavedPerformance(path)).toBe('light');
    writeFileSync(path, '﻿' + JSON.stringify({ performance: 'balanced' })); // a byte-order mark from Notepad
    expect(readSavedPerformance(path)).toBe('balanced');
    writeFileSync(path, JSON.stringify({ performance: 'ludicrous' }));
    expect(readSavedPerformance(path)).toBe('auto');
    writeFileSync(path, 'null');
    expect(readSavedPerformance(path)).toBe('auto');
  });

  it('asks the machine what it has', () => {
    const hw = currentHardware();
    expect(hw.totalMemBytes).toBeGreaterThan(0);
    expect(hw.logicalCores).toBeGreaterThan(0);
  });
});
