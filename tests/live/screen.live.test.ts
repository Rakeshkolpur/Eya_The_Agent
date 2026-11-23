/**
 * The screen tools on a REAL application: Windows Calculator, driven through Windows UI Automation, with the result checked from
 * the window itself. Observe, act, observe again.
 *
 *   EYA_LIVE_WINDOWS=1 npx vitest run tests/live/screen.live.test.ts
 *   EYA_LIVE_WINDOWS=1 EYA_LIVE_GEMINI=1 ...   also has the real Gemini read a real picture of it (uses the key in .env; nothing is printed)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWindowControl } from '../../src/main/windowsApi/windowControl';
import type { WindowInfo } from '../../src/main/windowsApi/windowControl';
import { createUiAutomation } from '../../src/main/screen/uiAutomation';
import type { ScreenCapture } from '../../src/main/screen/screenCapture';
import { COMMUNICATION_OFF, CommunicationPolicy } from '../../src/main/privacy/communicationAccess';
import { boundsOf, createScreenTools } from '../../src/main/tools/impl/screenTools';
import { GeminiAIProvider } from '../../src/main/providers/ai/GeminiAIProvider';
import type { Tool, ToolArgs, ToolResult } from '../../src/main/tools/types';

const run = promisify(execFile);
const live = process.env['EYA_LIVE_WINDOWS'] === '1' && process.platform === 'win32';
const vision = live && process.env['EYA_LIVE_GEMINI'] === '1';

/** The key from .env, read without ever being printed. */
function loadKey(): string {
  try {
    const text = readFileSync(join(process.cwd(), '.env'), 'utf8');
    return /^EYA_GEMINI_API_KEY=(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

describe.skipIf(!live)('a real Calculator, through the screen tools', () => {
  const control = createWindowControl();
  const ui = createUiAutomation();
  let tools: Tool[];
  let calc: WindowInfo;
  let work = '';
  const call = (name: string, args: ToolArgs = {}): Promise<ToolResult> => (tools.find((t) => t.schema.name === name) as Tool).execute(args);

  /** What the display really says, read straight from Windows (not through the tools under test). */
  async function display(): Promise<string> {
    const listing = await ui.list(calc.handle, 600);
    return listing.elements.find((e) => e.automationId === 'CalculatorResults')?.name ?? '';
  }

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Calculator remembers its last mode (it can be a converter): put it in Standard, the way a person would, through its own menu. */
  async function ensureStandardMode(): Promise<void> {
    const isStandard = async () => (await ui.list(calc.handle, 600)).elements.some((e) => e.name === 'Standard Calculator mode');
    if (await isStandard()) return;
    const press = async (match: (name: string) => boolean): Promise<void> => {
      const target = (await ui.list(calc.handle, 600)).elements.find((e) => match(e.name) && e.actions.length > 0 && !e.offscreen);
      if (target === undefined) throw new Error('could not find the menu entry to switch Calculator to Standard');
      const outcome = await ui.act(calc.handle, target);
      if (!outcome.ok) throw new Error(`could not press "${target.name}": ${outcome.reason}`);
      await pause(900);
    };
    await press((n) => n === 'Open Navigation');
    await press((n) => /^Standard Calculator$/.test(n));
    if (!(await isStandard())) throw new Error('Calculator is not in Standard mode');
  }

  /** A picture of the Calculator window, taken the way the real app does it but with System.Drawing (Electron is not available here). */
  const screen: ScreenCapture = {
    async screen() {
      throw new Error('not used');
    },
    async window() {
      await control.act(calc.handle, 'focus');
      const frame = boundsOf((await ui.list(calc.handle, 600)).elements);
      if (frame.width < 100) throw new Error('no window frame');
      const file = join(work, 'calc.png');
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -AssemblyName System.Drawing;$b=New-Object System.Drawing.Bitmap ${frame.width},${frame.height};$g=[System.Drawing.Graphics]::FromImage($b);$g.CopyFromScreen(${frame.x},${frame.y},0,0,$b.Size);$b.Save('${file}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      ]);
      const bytes = readFileSync(file);
      return { bytes, mime: 'image/png', width: frame.width, height: frame.height, kind: 'window', label: 'Calculator' };
    },
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'eya-screen-live-'));
    // Start from a clean Calculator: one left over from an earlier run could be in another mode.
    for (const old of (await control.list()).filter((w) => w.title === 'Calculator')) await control.act(old.handle, 'close');
    await new Promise((r) => setTimeout(r, 1200));
    spawn('calc.exe', [], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 40; i += 1) {
      const found = (await control.list()).find((w) => w.title === 'Calculator');
      if (found !== undefined) {
        calc = found;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (calc === undefined) throw new Error('Calculator did not open');
    await control.act(calc.handle, 'focus');
    await ensureStandardMode();
    const key = vision ? loadKey() : '';
    const gemini = key !== '' ? new GeminiAIProvider({ apiKey: key }) : undefined;
    tools = createScreenTools({
      control,
      ui,
      screen,
      ...(gemini !== undefined ? { brain: gemini } : {}),
      policy: new CommunicationPolicy(() => COMMUNICATION_OFF),
      ownPids: () => [process.pid],
    });
  }, 60_000);

  afterAll(async () => {
    if (calc !== undefined) await control.act(calc.handle, 'close').catch(() => undefined);
    if (work !== '') rmSync(work, { recursive: true, force: true });
  }, 30_000);

  it('lists the real controls with real positions and what can be done to them', async () => {
    const r = await call('screen_elements', { window: 'Calculator' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const controls = r.data?.['controls'] as Array<{ n: number; type: string; name: string; where: string; canDo?: string[] }>;
    const byName = (n: string) => controls.find((c) => c.name === n);
    for (const name of ['Seven', 'Five', 'Plus', 'Equals', 'Clear']) expect(byName(name), name).toMatchObject({ type: 'Button', canDo: ['invoke'] });
    expect(byName('Seven')?.where).toMatch(/left/); // the 7 is on the left of the number pad
    expect(byName('Equals')?.where).toMatch(/bottom/); // = is at the bottom of the pad
    expect(byName('Clear')?.where).toBeTruthy();
    expect(controls.some((c) => /^Display is/.test(c.name))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/password/i);
  });

  it('clicks 7 + 5 = by name, and the display really says 12 (checked from Windows, not from the click)', async () => {
    expect((await call('screen_click', { name: 'Clear' })).ok).toBe(true);
    await call('screen_elements', { window: 'Calculator' });
    const seven = await call('screen_click', { name: 'Seven' });
    expect(seven.ok, JSON.stringify(seven)).toBe(true);
    expect(seven.data).toMatchObject({ clicked: 'Seven', how: 'invoke', changed: true });
    expect(await display()).toBe('Display is 7');
    expect((await call('screen_click', { name: 'Plus' })).ok).toBe(true);
    expect((await call('screen_click', { name: 'Five' })).ok).toBe(true);
    const equals = await call('screen_click', { name: 'Equals' });
    expect(equals.data).toMatchObject({ clicked: 'Equals', changed: true });
    expect(await display()).toBe('Display is 12');
    expect(JSON.stringify(equals.data)).toContain('Display is 12'); // and the tool itself reported what the window now says
  }, 90_000);

  it('a switched-off control is not clicked, and one that is not there is not invented', async () => {
    await call('screen_elements', { window: 'Calculator' });
    const recall = await call('screen_click', { name: 'Memory recall' });
    expect(recall.ok).toBe(false);
    expect(recall.summary).toBe('disabled');
    const nope = await call('screen_click', { name: 'Tangent' });
    expect(nope.ok).toBe(false);
    expect(nope.summary).toBe('no such control');
  }, 60_000);

  it('a number from before the window changed is refused — it can never land on a different control', async () => {
    const before = await call('screen_elements', { window: 'Calculator' });
    const plus = (before.data?.['controls'] as Array<{ n: number; name: string }>).find((c) => c.name === 'Plus');
    expect(plus).toBeDefined();
    const shown = await display();
    // The user (or a click) opens the navigation pane: the whole window re-flows.
    const opened = await call('screen_click', { name: 'Open Navigation' });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    expect(opened.data).toMatchObject({ changed: true });
    const stale = await call('screen_click', { n: (plus as { n: number }).n });
    expect(stale.ok).toBe(false);
    expect(stale.summary).toBe('old number');
    expect(await display()).toBe(shown); // nothing else was clicked in its place
    // By name, against the fresh look, it is fine.
    expect((await call('screen_click', { name: 'Close Navigation' })).ok).toBe(true);
  }, 90_000);

  it.skipIf(!vision)('describe_screen: asks first, then the real Gemini reads a real picture and says what the display shows', async () => {
    await call('screen_elements', { window: 'Calculator' });
    const asked = await call('describe_screen', { window: 'Calculator', question: 'What number is on the display?' });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    const out = await call('describe_screen', { window: 'Calculator', question: 'What number is on the display?', confirm: true });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(String(out.data?.['description'])).toMatch(/12/);
    expect(existsSync(join(work, 'calc.png'))).toBe(true);
  }, 120_000);
});
