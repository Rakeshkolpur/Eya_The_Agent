import type { StoredAuto, StoredDraft } from './session';

/**
 * Authorized auto-reply: whether ONE drafted reply may go out without the person pressing anything. It may only when the person turned this on for this chat and run
 * (with the other person's awareness confirmed) and the limits they set still hold. The person is watching the chat, so by default a reply goes out as the message
 * comes in — Eya does not hold it back for how it reads. What is still never sent by itself, whatever the person asked: a word for something private (a password, a
 * one-time code, a card or account number, an Aadhaar number), because the other person can write anything into the chat, including "reply with your password".
 * A person who prefers the stricter way can ask for replies that promise something, mention figures or links, or that Eya is unsure of to be held back (`holdBack`).
 * Anything that stops a reply is not "wait and see": it stops automatic replies and gives the chat back to the person.
 */

/**
 * Automatic replies have NO count or time limit unless the person sets one: a live chat waits for the next message for as long as it is on, until the person pauses or
 * stops it. What keeps it from running away is the gap between two replies (and the person's own Pause / Stop at any moment).
 */
export const AUTO_DEFAULTS = { maxReplies: null, maxMinutes: null, minGapSeconds: 10 } as const;

/**
 * The one thing that ends a live chat by itself besides the person's own Pause / Stop: the OTHER person has not written for this long (counted from their last message, or
 * from Eya's last one when they have not answered it), and nothing of theirs is waiting for an answer. A conversation that has gone quiet is over; Eya does not sit on it.
 * But she does not let it vanish unasked: when she may answer by herself, the first time this much silence has passed she sends ONE friendly check-in, and the chat ends only
 * if they are silent for this long again (see `LiveChatController.checkIn`). Fifteen minutes: a person who is busy and answers later is not a person who left (the person
 * asked for 15 on 6 Nov 2026; it was 5). So in automatic mode a chat that is truly abandoned ends after about half an hour.
 */
export const IDLE_STOP_MS = 15 * 60_000;
export const AUTO_LIMITS = { maxReplies: 1000, maxMinutes: 24 * 60 } as const;

/**
 * What an automatic reply may never contain in the strict way (`holdBack`), whatever the model says about itself: a figure of three digits or more (an amount, a
 * code, a number), a link or an address, or a word for something private (a password, a one-time code, a card or account number).
 */
const NEVER_BY_ITSELF = /\d{3,}|https?:\/\/|www\.|\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b(?:otp|one[- ]time|password|passcode|pin|cvv|cvc|card number|account number|ifsc|aadhaar|aadhar|pan card|upi|bank)\b/i;
/** What no automatic reply contains, in either way: the words for secrets a person never types into a chat by the hand of an assistant. */
const SECRETS = /\b(?:otp|one[- ]time (?:password|code|pin)|password|passcode|cvv|cvc|card number|account number|aadhaar|aadhar)\b/i;
const MAX_AUTO_LENGTH = 240;

/** What the automatic replies are limited by, in words: nothing, unless the person set a count or a time. */
export function autoLimitsSaid(auto: { readonly maxReplies: number | null; readonly until: number | null }, now: number): string {
  const parts: string[] = [];
  if (auto.maxReplies !== null) parts.push(`up to ${auto.maxReplies} replies`);
  if (auto.until !== null) parts.push(`for about ${Math.max(1, Math.round((auto.until - now) / 60_000))} more minutes`);
  return parts.length === 0 ? 'with no limit on the number of replies: it goes on until you pause or stop it, or until they have stayed quiet for fifteen minutes' : parts.join(', ');
}

export type AutoDecision =
  | { readonly ok: true }
  /** Not yet: the gap between two automatic replies has not passed. Try again after this many ms. */
  | { readonly ok: false; readonly wait: number }
  /** Automatic replies end here, for this reason (a sentence for the person). */
  | { readonly ok: false; readonly stop: string }
  /** THIS reply is not sent by itself (it waits for the person), and automatic replies go on for the next message. */
  | { readonly ok: false; readonly hold: string };

export function autoGate(auto: StoredAuto | null, draft: StoredDraft, now: number): AutoDecision {
  if (auto === null) return { ok: false, stop: 'Automatic replies are not switched on.' };
  if (auto.until !== null && now >= auto.until) return { ok: false, stop: 'The time you allowed for automatic replies has run out.' };
  if (auto.maxReplies !== null && auto.repliesSent >= auto.maxReplies) return { ok: false, stop: `The ${auto.maxReplies} automatic replies you allowed have been sent.` };
  if (draft.by !== 'eya') return { ok: false, stop: 'A reply you wrote yourself is never sent automatically.' };
  // (this one reply waits for the person; the live chat stays on for the next message: one word like "password" in a harmless answer must not end it)
  if (SECRETS.test(draft.text)) return { ok: false, hold: 'This reply mentions something private (a password, a code, a card or account number), which I never send by myself. It is waiting for you; automatic replies go on for the next message.' };
  if (auto.holdBack) {
    if (draft.confidence !== 'high') return { ok: false, stop: 'Eya is not sure enough of this reply to send it without you.' };
    if (draft.commitment) return { ok: false, stop: 'This reply agrees to, promises or states something for you, so it needs your approval.' };
    if (NEVER_BY_ITSELF.test(draft.text) || draft.text.length > MAX_AUTO_LENGTH) return { ok: false, stop: 'This reply is longer than a plain one, or mentions a figure, a link or something private, so it needs your approval.' };
  }
  if (auto.lastSentAt !== null && now - auto.lastSentAt < auto.minGapMs) return { ok: false, wait: auto.minGapMs - (now - auto.lastSentAt) };
  return { ok: true };
}

/** The auto-reply settings as asked for, kept within sensible bounds. */
export function autoFrom(now: number, ask: { readonly maxReplies?: number; readonly maxMinutes?: number; readonly minGapSeconds?: number; readonly holdBack?: boolean }): StoredAuto {
  // (no number asked for: no limit; the person can still set one)
  const maxReplies = ask.maxReplies === undefined ? null : Math.max(1, Math.min(AUTO_LIMITS.maxReplies, Math.trunc(ask.maxReplies)));
  const maxMinutes = ask.maxMinutes === undefined ? null : Math.max(1, Math.min(AUTO_LIMITS.maxMinutes, Math.trunc(ask.maxMinutes)));
  const gap = Math.max(5, Math.min(600, Math.trunc(ask.minGapSeconds ?? AUTO_DEFAULTS.minGapSeconds)));
  return { maxReplies, repliesSent: 0, minGapMs: gap * 1000, until: maxMinutes === null ? null : now + maxMinutes * 60_000, lastSentAt: null, holdBack: ask.holdBack === true };
}
