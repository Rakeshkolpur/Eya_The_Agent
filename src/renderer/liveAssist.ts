/**
 * LIVE ASSISTANT: "if I type 'do live chat', she should say 'OK Rakesh, wait, I'm opening it here — scan it', and wait, like a live person; one live mic, also when I typed." When a task the
 * person TYPED begins to work in a browser, Eya starts her live voice conversation (the one microphone button, if voice is on and she can hear) and tells the voice model what the person asked
 * and how to be: one short natural line, then listen — and when the page needs the person (a QR code to scan, a code to type), say exactly what, and wait. Pure: what the page decides, and the
 * words the live voice model is given.
 */

/** How long after typing a task is still "the task they typed" (the browser shows its goal only when it first uses the page). */
export const TYPED_WINDOW_MS = 2 * 60_000;
/** A page that needs the person can come late in a long task: it is still the task they typed. */
export const TYPED_LONG_WINDOW_MS = 30 * 60_000;

const words = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether the goal the Browser page shows (the request's words, cut to 200 characters) is the task the person typed a moment ago. */
export function isTypedGoal(goal: string, typed: { readonly text: string; readonly at: number }, now: number, windowMs: number = TYPED_WINDOW_MS): boolean {
  if (typed.text === '' || now - typed.at > windowMs) return false;
  const g = words(goal);
  const t = words(typed.text);
  if (g === '' || t === '') return false;
  return g === t || t.startsWith(g.slice(0, 60)) || g.startsWith(t.slice(0, 60));
}

/** What the live voice model is told once per conversation: be a person beside them, short, never invent what you did not do, stay interruptible. */
export const LIVE_ASSIST_RULES =
  "[Eya's note] LIVE ASSISTANT: you are working beside the user while they watch, like a person sitting next to them. When a note tells you what they typed and that you are on it, say ONE short natural line " +
  '("okay, wait, I\'m opening it") — never a list, never the whole plan — and then listen: they may talk to you at any moment, and if they say wait, stop, or something else, do that. When a note says the page ' +
  'needs them (a QR code to scan, a code, a sign-in), tell them exactly what to do in a few friendly words and wait; do not repeat it. Say only what a note told you: never claim something is done, opened or sent ' +
  'unless a note or a tool said so. Use their name when you know it.';

/** The person typed a task and Eya has started on it: say a short line now, then listen. */
export function typedTaskNote(owner: string, task: string): string {
  const who = owner.trim() !== '' ? ` The user's name is ${owner.trim()}.` : '';
  return `[Eya's note] (live) The user just typed this task: "${task.slice(0, 200)}". You are doing it now.${who} Say one short, natural line like a person beside them would ("okay, wait, I'm on it") and then listen.`;
}

/** The page needs the person: tell them exactly what to do, and wait. */
export function blockerNote(owner: string, blocker: string): string {
  const who = owner.trim() !== '' ? ` The user's name is ${owner.trim()}.` : '';
  return `[Eya's note] (live) You have to wait for the user: ${blocker.slice(0, 240)}${who} Tell them in a few friendly words what to do, then wait quietly; you carry on by yourself when it is done.`;
}

/** Something Eya is doing or waiting for, said to the person right now (the live chat's "wait, I opened WhatsApp here, scan the QR"). */
export function liveNote(text: string): string {
  return `[Eya's note] (live) Say this to the user right now, in your own natural words and in a few of them, like a person beside them: "${text}" Then wait: they may answer, and you carry on when it is done.`;
}

/** Whether a typed task should start the live conversation: the setting is on, voice is on and she can hear, and no conversation is going or starting. */
export function shouldStartLiveAssist(input: { readonly enabled: boolean; readonly voiceOn: boolean; readonly canHear: boolean; readonly talk: 'off' | 'connecting' | 'on'; readonly handsFree: boolean }): boolean {
  return input.enabled && input.voiceOn && input.canHear && input.talk === 'off' && !input.handsFree;
}
