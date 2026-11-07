import type { ToolArgs, ToolResult } from '@main/tools/types';

/**
 * When the page's own list of things to click does not have what Eya was told to click ("Buy at ₹14,249", "Place order"), she looks at the screen herself — a
 * picture of the browser window, read by Gemini — and puts what it shows into the answer of the failed step, so the next step is not another guess. The person
 * asked for exactly this ("if it is not recognising the buy option it can turn on the screen option by itself, without asking me"); it is a setting
 * (Settings → "Look at the screen by herself when she cannot find a button"), on by default, and each look is said in the chat.
 *
 * Limits that keep it honest: only after a click or fill that did not find its target; at once for a buying / cart / sign-in / checkout word, otherwise on
 * the second miss in a row; at most twice for one request; only the user's own Chrome or Edge window (the picture is read by Gemini, never saved, and
 * describe_screen itself refuses a chat app that Communication Access is off for). It does not click anything: it only looks.
 */
export const AUTO_LOOKS_PER_REQUEST = 2;

/** The words of a control that decides something: finding it matters at once, not after a second miss. */
const DECIDING = /\b(buy|cart|bag|basket|check\s*out|order|pay|place|continue|proceed|log\s*in|sign\s*in|otp|book|confirm|deliver|add)\b/i;

export interface LookState {
  /** Clicks / fills in a row that found nothing. */
  notFoundInARow: number;
  /** Looks at the screen made for this request. */
  looks: number;
}

export function newLookState(): LookState {
  return { notFoundInARow: 0, looks: 0 };
}

export function isNotFound(name: string, result: ToolResult): boolean {
  return (name === 'click_on_page' || name === 'fill_on_page') && !result.ok && result.summary === 'not found';
}

/** What was being looked for, in the words the model used. */
export function targetOf(args: ToolArgs): string {
  const t = args['text'] ?? args['label'];
  return typeof t === 'string' ? t.trim().slice(0, 80) : '';
}

/** Counts the miss (or the success that ends a run of misses) and says whether the screen should be looked at now. */
export function shouldLook(state: LookState, name: string, args: ToolArgs, result: ToolResult): boolean {
  if (isNotFound(name, result)) {
    state.notFoundInARow += 1;
    if (state.looks >= AUTO_LOOKS_PER_REQUEST) return false;
    return DECIDING.test(targetOf(args)) || state.notFoundInARow >= 2;
  }
  if (result.ok && (name === 'click_on_page' || name === 'fill_on_page')) state.notFoundInARow = 0;
  return false;
}

export function lookQuestion(target: string): string {
  const what = target === '' ? 'the button or field I was told to use' : `"${target}" (or the button that does that)`;
  return (
    `This is a web page in a browser. Where is ${what}, and what does it look like? ` +
    'Name the words and buttons around it, and say whether something covers it (a pop-up, a sign-in box, a cookie notice, a banner). Answer in under 80 words.'
  );
}

/** The failed step's result, with what the screen showed added so the model's next step is made from it. */
export function withScreenLook(result: ToolResult, seen: string): ToolResult {
  const text = seen.trim().slice(0, 900);
  return {
    ...result,
    error: `${result.error ?? 'Not found.'} I (Eya) then looked at the screen myself, without asking the user, and it shows: ${text}`,
    data: { ...(result.data ?? {}), screenLook: text },
  };
}
