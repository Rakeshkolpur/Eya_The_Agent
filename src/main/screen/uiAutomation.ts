import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What an application's window is made of, as Windows itself describes it (UI Automation — the same description screen readers
 * use): each button, field, tab and text with its name, kind and place on screen, and what can be done to it. Text only: no
 * picture is taken. This is how Eya can "click the Seven button" in an application without guessing where it is, and then
 * check, from the window itself, that something changed.
 */

export type ElementAction = 'invoke' | 'toggle' | 'select' | 'expand' | 'value';

export interface UiElement {
  /** Position in this window's listing — what a click refers to. */
  readonly index: number;
  /** Button, Edit, CheckBox, TabItem, Text, MenuItem, ListItem … */
  readonly type: string;
  readonly name: string;
  readonly automationId: string;
  readonly enabled: boolean;
  readonly offscreen: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly actions: readonly ElementAction[];
  /** A password field: its name and contents are never reported. */
  readonly password: boolean;
}

export interface UiListing {
  readonly elements: readonly UiElement[];
  /** More elements exist than were listed. */
  readonly truncated: boolean;
}

export type ClickMethod = 'invoke' | 'toggle' | 'select' | 'expand' | 'mouse';

export type ActionOutcome =
  | { readonly ok: true; readonly how: ClickMethod }
  /** The element is not the one that was listed any more (the window changed): list again. */
  | { readonly ok: false; readonly reason: 'stale' | 'gone' | 'disabled' | 'offscreen' | 'no_way'; readonly detail?: string }
  /** The element has no pattern to use: the caller may click its centre with the mouse. */
  | { readonly ok: false; readonly reason: 'needs_mouse'; readonly x: number; readonly y: number };

export interface UiAutomation {
  list(handle: number, limit?: number): Promise<UiListing>;
  /** Does the best available thing to element `index` — after checking that it still has the name and kind that were listed. */
  act(handle: number, element: Pick<UiElement, 'index' | 'name' | 'type'>): Promise<ActionOutcome>;
  /** A real mouse click at a point on the screen (the window must already be in front). */
  clickAt(x: number, y: number): Promise<void>;
}

export type ScriptRunner = (script: string) => Promise<string>;

const UTF8 = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;';
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const HEAD = `${UTF8}$ErrorActionPreference='Stop';Add-Type -AssemblyName UIAutomationClient;Add-Type -AssemblyName UIAutomationTypes;`;

// The walk is one cached FindAll (fast), kept identical between listing and acting so that "element 12" means the same thing.
const WALK =
  `$AE=[System.Windows.Automation.AutomationElement];` +
  `$cr=New-Object System.Windows.Automation.CacheRequest;` +
  `foreach($p in @($AE::NameProperty,$AE::ControlTypeProperty,$AE::AutomationIdProperty,$AE::BoundingRectangleProperty,$AE::IsEnabledProperty,$AE::IsOffscreenProperty,$AE::IsPasswordProperty,` +
  `$AE::IsInvokePatternAvailableProperty,$AE::IsTogglePatternAvailableProperty,$AE::IsSelectionItemPatternAvailableProperty,$AE::IsExpandCollapsePatternAvailableProperty,$AE::IsValuePatternAvailableProperty)){$cr.Add($p)};` +
  `$cr.TreeScope=[System.Windows.Automation.TreeScope]::Element;` +
  `$scope=$cr.Activate();` +
  `$root=$AE::FromHandle([IntPtr]$HANDLE);` +
  `$all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);`;

function walk(handle: number): string {
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new Error('bad window handle');
  return WALK.replace('$HANDLE', String(handle));
}

export function listScript(handle: number, limit: number): string {
  const cap = Math.max(1, Math.min(Math.floor(limit), 800));
  return (
    HEAD +
    walk(handle) +
    `$n=0;$shown=0;'COUNT='+$all.Count;` +
    `foreach($e in $all){$c=$e.Cached;$i=$n;$n++;` +
    `if($shown -ge ${cap}){continue};` +
    `$type=$c.ControlType.ProgrammaticName -replace '^ControlType\\.','';` +
    `$pw=$c.IsPassword;$name=if($pw){''}else{[string]$c.Name};$name=$name -replace '[\\t\\r\\n]+',' ';` +
    `$flags='';if($e.GetCachedPropertyValue($AE::IsInvokePatternAvailableProperty)){$flags+='I'};if($e.GetCachedPropertyValue($AE::IsTogglePatternAvailableProperty)){$flags+='T'};` +
    `if($e.GetCachedPropertyValue($AE::IsSelectionItemPatternAvailableProperty)){$flags+='S'};if($e.GetCachedPropertyValue($AE::IsExpandCollapsePatternAvailableProperty)){$flags+='E'};` +
    `if($e.GetCachedPropertyValue($AE::IsValuePatternAvailableProperty)){$flags+='V'};` +
    `if($name -eq '' -and $flags -eq '' -and $type -notin 'Edit','Document','ComboBox'){continue};` +
    `$r=$c.BoundingRectangle;$x=if([double]::IsInfinity($r.X)){0}else{[int]$r.X};$y=if([double]::IsInfinity($r.Y)){0}else{[int]$r.Y};` +
    `$w=if([double]::IsInfinity($r.Width)){0}else{[int]$r.Width};$h=if([double]::IsInfinity($r.Height)){0}else{[int]$r.Height};` +
    `$shown++;` +
    `($i,$type,$name,$c.AutomationId,[int]$c.IsEnabled,[int]$c.IsOffscreen,$x,$y,$w,$h,$flags,[int]$pw) -join [char]9}`
  );
}

export function actScript(handle: number, index: number, name: string, type: string): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('bad element index');
  return (
    HEAD +
    walk(handle) +
    `if(${index} -ge $all.Count){'GONE';exit};` +
    `$e=$all[${index}];$c=$e.Cached;` +
    `$type=$c.ControlType.ProgrammaticName -replace '^ControlType\\.','';` +
    `$name=[string]$c.Name;$name=$name -replace '[\\t\\r\\n]+',' ';` +
    `if($type -ne ${psQuote(type)} -or $name -ne ${psQuote(name)}){'STALE '+$type+' '+$name;exit};` +
    `if(-not $c.IsEnabled){'DISABLED';exit};` +
    `if($e.GetCachedPropertyValue($AE::IsInvokePatternAvailableProperty)){$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke();'OK invoke';exit};` +
    `if($e.GetCachedPropertyValue($AE::IsTogglePatternAvailableProperty)){$e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle();'OK toggle';exit};` +
    `if($e.GetCachedPropertyValue($AE::IsSelectionItemPatternAvailableProperty)){$e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select();'OK select';exit};` +
    `if($e.GetCachedPropertyValue($AE::IsExpandCollapsePatternAvailableProperty)){$e.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand();'OK expand';exit};` +
    `if($c.IsOffscreen){'OFFSCREEN';exit};` +
    `$r=$c.BoundingRectangle;if([double]::IsInfinity($r.X) -or $r.Width -lt 2 -or $r.Height -lt 2){'NOWAY';exit};` +
    `'MOUSE '+[int]($r.X+$r.Width/2)+' '+[int]($r.Y+$r.Height/2)`
  );
}

export function clickScript(x: number, y: number): string {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('bad point');
  return (
    `${UTF8}$ErrorActionPreference='Stop';` +
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class EyaMouse{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);}';` +
    `[void][EyaMouse]::SetCursorPos(${Math.round(x)},${Math.round(y)});Start-Sleep -Milliseconds 60;` +
    `[EyaMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[EyaMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero);'CLICKED'`
  );
}

const FLAG_ACTIONS: ReadonlyArray<readonly [string, ElementAction]> = [
  ['I', 'invoke'],
  ['T', 'toggle'],
  ['S', 'select'],
  ['E', 'expand'],
  ['V', 'value'],
];

export function parseListing(out: string, limit: number): UiListing {
  const lines = out.split(/\r?\n/);
  const count = Number(/^COUNT=(\d+)$/.exec(lines[0]?.trim() ?? '')?.[1] ?? 0);
  const elements: UiElement[] = [];
  for (const line of lines.slice(1)) {
    const f = line.split('\t');
    if (f.length < 12) continue;
    const index = Number(f[0]);
    if (!Number.isInteger(index)) continue;
    const flags = f[10] ?? '';
    const password = f[11]?.trim() === '1';
    elements.push({
      index,
      type: (f[1] ?? '').slice(0, 30),
      name: password ? '' : (f[2] ?? '').slice(0, 160),
      automationId: (f[3] ?? '').slice(0, 80),
      enabled: f[4] === '1',
      offscreen: f[5] === '1',
      x: Number(f[6]) || 0,
      y: Number(f[7]) || 0,
      width: Number(f[8]) || 0,
      height: Number(f[9]) || 0,
      actions: FLAG_ACTIONS.filter(([letter]) => flags.includes(letter)).map(([, a]) => a),
      password,
    });
  }
  return { elements, truncated: count > limit || count > elements.length + 2000 };
}

export function parseOutcome(out: string): ActionOutcome {
  const text = out.trim();
  const ok = /^OK (invoke|toggle|select|expand)$/.exec(text);
  if (ok !== null) return { ok: true, how: ok[1] as ClickMethod };
  const mouse = /^MOUSE (-?\d+) (-?\d+)$/.exec(text);
  if (mouse !== null) return { ok: false, reason: 'needs_mouse', x: Number(mouse[1]), y: Number(mouse[2]) };
  if (text === 'GONE') return { ok: false, reason: 'gone' };
  if (text === 'DISABLED') return { ok: false, reason: 'disabled' };
  if (text === 'OFFSCREEN') return { ok: false, reason: 'offscreen' };
  if (text === 'NOWAY') return { ok: false, reason: 'no_way' };
  if (text.startsWith('STALE')) return { ok: false, reason: 'stale', detail: text.slice(5).trim() };
  return { ok: false, reason: 'no_way', detail: text.slice(0, 200) };
}

const runPowerShell: ScriptRunner = async (script) => {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 25_000,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout;
};

export function createUiAutomation(run: ScriptRunner = runPowerShell): UiAutomation {
  return {
    async list(handle, limit = 300) {
      return parseListing(await run(listScript(handle, limit)), limit);
    },
    async act(handle, element) {
      return parseOutcome(await run(actScript(handle, element.index, element.name, element.type)));
    },
    async clickAt(x, y) {
      const out = await run(clickScript(x, y));
      if (!out.includes('CLICKED')) throw new Error('Windows did not accept the click.');
    },
  };
}
