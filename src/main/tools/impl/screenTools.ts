import { BrowserUnavailableError, CommunicationAccessError } from '@main/browser/errors';
import { findBestTextMatchIndex } from '@main/browser/pageSnapshot';
import { sensitiveActionReason } from '@main/browser/sensitiveActions';
import { permissionRequest } from '@main/permissions/PermissionManager';
import type { CommunicationPolicy } from '@main/privacy/communicationAccess';
import { ScreenCaptureError } from '@main/screen/screenCapture';
import type { ScreenCapture } from '@main/screen/screenCapture';
import type { UiAutomation, UiElement } from '@main/screen/uiAutomation';
import { appLabel, isActable, matchWindows } from '@main/windowsApi/windowMatch';
import type { WindowControl, WindowInfo } from '@main/windowsApi/windowControl';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { unavailable } from './browserTools';

/**
 * Eya's eyes and hands for whatever is on the screen, in any application: look at it (a picture, read by Gemini — asked first,
 * never saved), list what it is made of (Windows' own description of the window, text only), click one of those parts, and check
 * from the window itself whether anything changed. Observe, act, observe again, verify.
 *
 * What it will not do: look at a chat app that Communication Access has switched off, read a password field, click by guessed
 * screen coordinates, or say a click worked just because it was made.
 */

export interface VisionBrain {
  analyzeFile(dataBase64: string, mimeType: string, question: string): Promise<string>;
}

export interface ScreenToolDeps {
  readonly control: WindowControl;
  readonly ui: UiAutomation;
  readonly screen?: ScreenCapture;
  readonly brain?: VisionBrain;
  readonly policy: CommunicationPolicy;
  /** Eya's own windows are never looked at or clicked. */
  readonly ownPids: () => readonly number[];
  /** Shrinks a picture before it is sent to be read. Without it the picture goes as it is. */
  readonly prepareImage?: (png: Buffer) => { readonly bytes: Buffer; readonly mime: 'image/jpeg' | 'image/png' };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const LISTING_LIFE_MS = 2 * 60_000;
const MAX_SHOWN = 100;

const stringArg = (args: ToolArgs, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

const fail = (summary: string, error: string, data?: Record<string, unknown>): ToolResult => ({ ok: false, summary, error, ...(data !== undefined ? { data } : {}) });

/** A card number the picture's reader copied out: removed (long digit runs that pass the card-number checksum). */
export function scrubSecrets(text: string): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (run) => {
    const digits = run.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return run;
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    return sum % 10 === 0 ? '[card number removed]' : run;
  });
}

/** Where on the window an element sits, in words: "top left", "middle right", "centre". */
export function whereIn(win: { x: number; y: number; width: number; height: number }, el: { x: number; y: number; width: number; height: number }): string {
  if (win.width <= 0 || win.height <= 0) return 'somewhere in the window';
  const fx = (el.x + el.width / 2 - win.x) / win.width;
  const fy = (el.y + el.height / 2 - win.y) / win.height;
  const col = fx < 0.34 ? 'left' : fx > 0.66 ? 'right' : 'centre';
  const row = fy < 0.34 ? 'top' : fy > 0.66 ? 'bottom' : 'middle';
  return row === 'middle' && col === 'centre' ? 'centre' : row === 'middle' ? `middle ${col}` : col === 'centre' ? `${row} centre` : `${row} ${col}`;
}

const GENERATION_STEP = 100_000;
const numberFor = (gen: number, index: number): number => gen * GENERATION_STEP + index;
const generationOf = (n: number): number => Math.floor(n / GENERATION_STEP);
const indexOf = (n: number): number => n % GENERATION_STEP;

/** The area the window's parts cover (a window's own frame is not always the first or biggest thing Windows lists). */
export function boundsOf(elements: readonly UiElement[]): { x: number; y: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const e of elements) {
    if (e.offscreen || e.width < 2 || e.height < 2) continue;
    left = Math.min(left, e.x);
    top = Math.min(top, e.y);
    right = Math.max(right, e.x + e.width);
    bottom = Math.max(bottom, e.y + e.height);
  }
  return Number.isFinite(left) ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 };
}

interface Listing {
  /** Which look at the window this is. A number is only good for the look it came from. */
  readonly generation: number;
  readonly handle: number;
  readonly title: string;
  readonly label: string;
  readonly at: number;
  readonly elements: readonly UiElement[];
  readonly bounds: { x: number; y: number; width: number; height: number };
}

function namesByKey(elements: readonly UiElement[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of elements) {
    if (e.name === '' || e.offscreen) continue;
    map.set(e.automationId !== '' ? `id:${e.automationId}` : `${e.type}#${e.index}`, e.name);
  }
  return map;
}

/** What changed between two looks at a window: names that changed in place, and controls that appeared or went. */
export function diffListings(before: readonly UiElement[], after: readonly UiElement[]): { changed: Array<{ was: string; now: string }>; appeared: string[]; gone: string[] } {
  const a = namesByKey(before);
  const b = namesByKey(after);
  const changed: Array<{ was: string; now: string }> = [];
  const appeared: string[] = [];
  const gone: string[] = [];
  for (const [key, now] of b) {
    const was = a.get(key);
    if (was === undefined) appeared.push(now);
    else if (was !== now) changed.push({ was, now });
  }
  for (const [key, was] of a) if (!b.has(key)) gone.push(was);
  return { changed, appeared, gone };
}

export function createScreenTools(deps: ScreenToolDeps): Tool[] {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let last: Listing | null = null;
  let generation = 0;

  function blockedBy(win: Pick<WindowInfo, 'process' | 'title'>): string | null {
    return deps.policy.blockedForWindow({ process: win.process, title: win.title })?.name ?? null;
  }

  const refusal = (app: string): ToolResult => unavailable(new CommunicationAccessError(app));

  /** The window the user means: the one they named, else the front one that is not Eya's own. */
  async function chooseWindow(query: string | undefined): Promise<{ win: WindowInfo } | { fail: ToolResult }> {
    const own = new Set(deps.ownPids());
    const usable = (await deps.control.list()).filter((w) => isActable(w, own));
    if (query !== undefined) {
      const found = matchWindows(usable, query);
      if (found.best === null) {
        const apps = [...new Set(usable.map((w) => appLabel(w)))];
        return { fail: fail('no such window', `No open window matches "${query}". Open applications: ${apps.length > 0 ? apps.join(', ') : 'none'}. Ask the user which one they mean.`) };
      }
      return { win: found.best };
    }
    const front = usable.find((w) => w.state !== 'minimized') ?? usable[0];
    if (front === undefined) return { fail: fail('nothing open', 'There is no application window open to look at.') };
    return { win: front };
  }

  // ------------------------------------------------------------------------------------------------ describe_screen
  const describeScreen: Tool = {
    schema: {
      name: 'describe_screen',
      status: 'Looking at the screen…',
      description:
        'LOOK at what is on the user\'s screen right now — any application — and answer in words: "what is this?", "what does it say?", "what is the button on the right?". ' +
        'It takes a picture and has Gemini read it (the picture is not saved), so it ASKS FIRST: the first call looks at nothing and hands back a question; ask it plainly and only after a clear yes ' +
        'call again with confirm: true (when the user\'s own request already asks you to look, that is their yes). By default it looks at the application window in front (not Eya\'s own); ' +
        'name a window to look at another, or target screen for everything showing. It will not look at a chat app while Communication Access is off for it. It does not click anything. ' +
        'For the parts of a window you may need to click, use screen_elements. In a web page in the browser, prefer inspect_page and find_on_page: they are exact.',
      args: {
        question: { type: 'string', description: 'What the user wants to know about the screen, in their words. Leave out for a general description.' },
        target: { type: 'string', enum: ['window', 'screen'], description: 'window (default) = one application window; screen = everything showing.' },
        window: { type: 'string', description: 'Part of the application\'s name or title, to look at one other than the one in front.' },
        confirm: { type: 'boolean', description: 'true ONLY after the user clearly said yes to being looked at, or their request already asked you to look.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      if (deps.screen === undefined || deps.brain === undefined) return fail('not available', 'Looking at the screen needs the screen capture and the Gemini key, and one of them is missing.');
      const target = args['target'] === 'screen' ? 'screen' : 'window';
      const question = stringArg(args, 'question');
      try {
        let win: WindowInfo | null = null;
        if (target === 'window') {
          const chosen = await chooseWindow(stringArg(args, 'window'));
          if ('fail' in chosen) return chosen.fail;
          win = chosen.win;
          const blocked = blockedBy(win);
          if (blocked !== null) return refusal(blocked);
        } else {
          // Everything showing: refuse if a chat app that is switched off is showing anywhere.
          const own = new Set(deps.ownPids());
          for (const w of (await deps.control.list()).filter((x) => isActable(x, own) && x.state !== 'minimized')) {
            const blocked = blockedBy(w);
            if (blocked !== null) {
              return fail('a private app is showing', `${blocked} is open on the screen and Communication Access is off for it, so I will not look at the whole screen. Look at one other application's window instead, or the user can turn on the Chats switch in Eya's panel.`, {
                communicationAccess: 'off',
                app: blocked,
                nothingWasRead: true,
              });
            }
          }
        }
        const label = win !== null ? appLabel(win) : 'the screen';

        if (args['confirm'] !== true) {
          const what = target === 'screen' ? 'everything on your screen' : `your ${label} window`;
          const question2 = `Can I look at ${what}? I'll have Google's Gemini read the picture so I can tell you what's there, and it isn't saved.`;
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `Nothing was looked at yet. Ask the user this, plainly: "${question2}" Only if they clearly say yes, call describe_screen again with the same arguments and confirm: true. If they say no, do not look.`,
            data: permissionRequest('describe_screen', label, question2, ['yes', 'no']),
          };
        }

        const shot = target === 'screen' ? await deps.screen.screen() : await deps.screen.window((win as WindowInfo).title);
        const image = deps.prepareImage !== undefined ? deps.prepareImage(shot.bytes) : { bytes: shot.bytes, mime: 'image/png' as const };
        if (image.bytes.length > MAX_IMAGE_BYTES) return fail('too large', 'The picture is too large to read.');
        const prompt =
          `You are the eyes of a voice assistant. This is a picture of ${target === 'screen' ? "a Windows user's whole screen" : `the "${label}" window on a Windows PC`}. Answer for someone who cannot see it.\n` +
          (question !== undefined ? `The user's question: ${question}\n` : 'Say what application this is, what it is showing, and the controls that matter, with where each one is (left, right, top, bottom, centre).\n') +
          'Be concise (under 150 words unless more is asked for). Never read out passwords, card numbers, one-time codes or other secrets: say "a password field" or "a card number" instead. ' +
          'If you cannot tell, say so; do not guess or invent anything that is not in the picture.';
        const answer = scrubSecrets((await deps.brain.analyzeFile(image.bytes.toString('base64'), image.mime, prompt)).trim());
        if (answer === '') return fail('could not read it', 'Gemini gave no answer for that picture. Try again, or ask the user.');
        return {
          ok: true,
          summary: `looked at ${label}`,
          data: { window: label, target, description: answer.slice(0, 3000), howItWasSeen: 'a picture read by Gemini, not saved', size: `${shot.width}x${shot.height}` },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        if (err instanceof ScreenCaptureError) return fail('could not look', err.message);
        return fail('could not look', `I could not look at the screen: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  // ---------------------------------------------------------------------------------------------- screen_elements
  const screenElements: Tool = {
    schema: {
      name: 'screen_elements',
      status: 'Reading the window…',
      description:
        'List what the application window in front (or a named one) is made of, as Windows itself describes it: each button, field, tab and label with its name, kind, where it is in the window ' +
        '(top left, middle right…) and what can be done to it. Text only, no picture. Use it to find "the button on the right" or to choose a control by name before screen_click, and to look ' +
        'again afterwards. Numbers (n) are only good for this listing. Password fields are never shown. Not for chat apps that Communication Access has off. For a web page use inspect_page. ' +
        'If the control you need is not listed, the application does not expose it: use describe_screen, or say so.',
      args: {
        window: { type: 'string', description: 'Part of the application\'s name or title. Omit for the one in front (not Eya\'s own).' },
        find: { type: 'string', description: 'Only controls whose name has these words. Omit to list the main ones.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      try {
        const chosen = await chooseWindow(stringArg(args, 'window'));
        if ('fail' in chosen) return chosen.fail;
        const win = chosen.win;
        const blocked = blockedBy(win);
        if (blocked !== null) return refusal(blocked);
        const listing = await deps.ui.list(win.handle, 600);
        const label = appLabel(win);
        generation += 1;
        const bounds = boundsOf(listing.elements);
        last = { generation, handle: win.handle, title: win.title, label, at: now(), elements: listing.elements, bounds };

        const find = stringArg(args, 'find')?.toLowerCase();
        const named = listing.elements.filter((e) => e.name !== '' && !e.offscreen && !e.password && (find === undefined || e.name.toLowerCase().includes(find)));
        const doable = named.filter((e) => e.actions.some((a) => a !== 'value') || e.type === 'Edit' || e.type === 'ComboBox');
        const rest = named.filter((e) => !doable.includes(e));
        const shown = [...doable.slice(0, MAX_SHOWN), ...rest.slice(0, Math.max(0, Math.min(40, MAX_SHOWN - doable.length)))].sort((a, b) => a.index - b.index);
        if (shown.length === 0) {
          return {
            ok: true,
            summary: find === undefined ? `${label} exposes nothing I can list` : `nothing in ${label} is called that`,
            data: { window: label, controls: [], hint: 'The application may not describe its parts to Windows. Use describe_screen to look at it instead, or ask the user.' },
          };
        }
        return {
          ok: true,
          summary: `${shown.length} controls in ${label}`,
          data: {
            window: label,
            title: win.title,
            controls: shown.map((e) => ({
              n: numberFor(generation, e.index),
              type: e.type,
              name: e.name,
              where: whereIn(bounds, e),
              ...(e.enabled ? {} : { disabled: true }),
              ...(e.actions.length > 0 ? { canDo: e.actions } : {}),
            })),
            ...(listing.truncated || named.length > shown.length ? { more: `${named.length - shown.length} more not shown; pass find to narrow it` } : {}),
            next: 'To click one, call screen_click with its n (or its name). Then look again before saying it worked.',
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return fail('could not read the window', `I could not read that window: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  // ------------------------------------------------------------------------------------------------- screen_click
  const screenClick: Tool = {
    schema: {
      name: 'screen_click',
      status: 'Clicking…',
      description:
        'Click one control from the last screen_elements listing — by its n, or by its name — in any application: it uses the control\'s own "invoke" (a button press, a tick box, a tab) when it has one, ' +
        'else a real click at its centre. It never clicks guessed screen positions. A control that would send, delete, buy, install or change something important is NOT clicked on the first call: you get a ' +
        'question to put to the user, and only after a clear yes call again with confirm: true. It then looks at the window again and reports what changed; if nothing visibly changed, say that — ' +
        'do not say it worked just because it was clicked. If the window changed since the listing it asks you to list again.',
      args: {
        n: { type: 'number', description: 'The control\'s number from the last screen_elements result.' },
        name: { type: 'string', description: 'Or the control\'s name (when n is not known); several with the same name come back for you to choose.' },
        confirm: { type: 'boolean', description: 'true ONLY after the user clearly agreed to this exact click when asked.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const before = last;
      if (before === null || now() - before.at > LISTING_LIFE_MS) return fail('look first', 'List the window first with screen_elements (the last listing is missing or too old), then choose a control from it.');
      const n = typeof args['n'] === 'number' && Number.isFinite(args['n']) ? Math.trunc(args['n']) : undefined;
      const name = stringArg(args, 'name');
      if (n === undefined && name === undefined) return fail('which control?', 'Give the control\'s n from screen_elements, or its name.');

      let target: UiElement | undefined;
      if (n !== undefined) {
        if (generationOf(n) !== before.generation) {
          return fail('old number', 'That number is from an earlier look at the window, and the window has changed since (every click changes what the numbers mean). Call screen_elements again and use the new number, or give the control\'s name.');
        }
        target = before.elements.find((e) => e.index === indexOf(n));
        if (target === undefined) return fail('no such control', `There is no control number ${n} in the last listing. Call screen_elements again.`);
      } else {
        const wanted = (name as string).toLowerCase().replace(/\s+/g, ' ');
        const pool = before.elements.filter((e) => e.name !== '' && !e.offscreen && !e.password && (e.actions.some((a) => a !== 'value') || e.type === 'Edit'));
        const exact = pool.filter((e) => e.name.toLowerCase().replace(/\s+/g, ' ') === wanted);
        if (exact.length > 1) {
          return {
            ok: false,
            summary: 'which one?',
            error: `${exact.length} controls are called "${name}". Tell the user where each is and ask which, then call again with its n.`,
            data: { candidates: exact.map((e) => ({ n: numberFor(before.generation, e.index), type: e.type, where: whereIn(before.bounds, e) })) },
          };
        }
        const index = exact.length === 1 ? 0 : findBestTextMatchIndex(wanted, (exact.length === 1 ? exact : pool).map((e) => e.name));
        target = exact.length === 1 ? exact[0] : index === null ? undefined : pool[index];
        if (target === undefined) return fail('no such control', `Nothing in the last listing is called "${name}". Call screen_elements (with find) to look again, or ask the user.`);
      }
      if (target.password) return fail('not allowed', 'That is a password field. Eya never types into or clicks to reveal one; the user has to do that part.');
      if (!target.enabled) return fail('disabled', `"${target.name}" is switched off right now, so it cannot be clicked.`);

      try {
        const win = await deps.control.info(before.handle);
        if (win === null) return fail('window gone', `The ${before.label} window is not open any more. List what is open (list_windows) and start again.`);
        if (win.title !== before.title) return fail('the window changed', `The window is now called "${win.title}" (it was "${before.title}"), so the listing is out of date. Call screen_elements again.`);
        const blocked = blockedBy(win);
        if (blocked !== null) return refusal(blocked);
        if (new Set(deps.ownPids()).has(win.pid)) return fail('not allowed', "That is Eya's own window; she does not click in it.");

        if (args['confirm'] !== true) {
          const why = sensitiveActionReason(target.name, 'button');
          if (why !== null) {
            const q = `That would be ${why} ("${target.name}" in ${before.label}). Do you want me to go ahead?`;
            return {
              ok: false,
              summary: 'needs confirmation',
              error: `Nothing was clicked. Ask the user this plainly: "${q}" Only if they clearly say yes, call screen_click again with the same control and confirm: true.`,
              data: permissionRequest('screen_sensitive_click', target.name, q),
            };
          }
        }

        const outcome = await deps.ui.act(before.handle, target);
        let how: string;
        if (outcome.ok) {
          how = outcome.how;
        } else if (outcome.reason === 'needs_mouse') {
          await deps.control.act(before.handle, 'focus'); // a real click lands on whatever is on top, so the window must be in front
          await deps.ui.clickAt(outcome.x, outcome.y);
          how = 'mouse';
        } else {
          const why: Record<string, string> = {
            stale: 'The window no longer has that control there (it changed). Call screen_elements again.',
            gone: 'That control is no longer in the window. Call screen_elements again.',
            disabled: `"${target.name}" is switched off right now.`,
            offscreen: `"${target.name}" is out of view (scrolled away or hidden), so it cannot be clicked. Scroll it into view, or ask the user.`,
            no_way: `Windows gives no way to click "${target.name}" from outside. Use describe_screen to look, or ask the user.`,
          };
          return fail('not clicked', why[outcome.reason] ?? 'The click did not happen.', { clicked: false });
        }

        // Observe again: did the window really change?
        await sleep(700);
        const after = await deps.ui.list(before.handle, 600);
        const winAfter = await deps.control.info(before.handle);
        const diff = diffListings(before.elements, after.elements);
        const titleChanged = winAfter !== null && winAfter.title !== before.title;
        const changed = diff.changed.length > 0 || diff.appeared.length > 0 || diff.gone.length > 0 || titleChanged || winAfter === null;
        generation += 1; // the window is a new look now: numbers from the listing the user acted on stop working
        last = { ...before, generation, at: now(), elements: after.elements, bounds: boundsOf(after.elements), ...(winAfter !== null ? { title: winAfter.title } : {}) };
        const clip = (s: string) => (s.length > 70 ? `${s.slice(0, 69)}…` : s);
        return {
          ok: true,
          summary: changed ? `clicked "${target.name}" and the window changed` : `clicked "${target.name}", but nothing visibly changed`,
          data: {
            clicked: target.name,
            how,
            changed,
            ...(diff.changed.length > 0 ? { nowReads: diff.changed.slice(0, 5).map((c) => ({ was: clip(c.was), now: clip(c.now) })) } : {}),
            ...(diff.appeared.length > 0 ? { appeared: diff.appeared.slice(0, 5).map(clip), appearedCount: diff.appeared.length } : {}),
            ...(diff.gone.length > 0 ? { disappearedCount: diff.gone.length } : {}),
            ...(titleChanged ? { windowNowCalled: (winAfter as WindowInfo).title } : {}),
            ...(winAfter === null ? { note: 'The window closed.' } : {}),
            ...(changed ? {} : { note: 'The click was accepted but the window shows no difference (it may be slow to react, or the click did nothing). Look again (screen_elements) before saying it worked.' }),
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return fail('could not click', `I could not click that: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };

  return [describeScreen, screenElements, screenClick];
}
