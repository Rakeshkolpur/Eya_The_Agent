/**
 * When a Gemini limit comes back, and how to say so in the user's own time.
 *
 * The source of truth is Google's own answer: a 429 carries how long to wait, and that holds for the free tier's daily
 * cap too. Measured against the real API, a spent daily limit answered "wait 26755 s" at 16:34 UTC — which ends exactly
 * at 00:00 UTC — so that is what the user is told, converted to their own clock. Only when Google names no wait is a
 * time guessed (the next midnight UTC, the same moment), and then it is said as "around", never as a promise.
 *
 * Pure and parameterised on time zone and locale, so it can be tested without depending on the machine it runs on.
 */

export interface TimeOptions {
  /** IANA zone to speak in; defaults to the machine's own. */
  readonly timeZone?: string;
  /** BCP 47 locale for the clock format; defaults to the machine's own. */
  readonly locale?: string;
}

/** The next midnight UTC after `now` — where the free daily cap has been measured to reset. Used only when Google gave no wait. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function localDay(date: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { ...(timeZone !== undefined ? { timeZone } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** "5:30 AM today", "5:30 AM tomorrow", or "5:30 AM on Sunday" — in the user's own time, never the server's. */
export function clockPhrase(at: Date, now: Date, options: TimeOptions = {}): string {
  const zone = options.timeZone !== undefined ? { timeZone: options.timeZone } : {};
  const time = new Intl.DateTimeFormat(options.locale, { ...zone, hour: 'numeric', minute: '2-digit' }).format(at);
  const day = localDay(at, options.timeZone);
  if (day === localDay(now, options.timeZone)) return `${time} today`;
  if (day === localDay(new Date(now.getTime() + 86_400_000), options.timeZone)) return `${time} tomorrow`;
  const weekday = new Intl.DateTimeFormat(options.locale, { ...zone, weekday: 'long' }).format(at);
  return `${time} on ${weekday}`;
}

/** "about 40 seconds", "about 3 minutes" — for a short wait Google has named. */
export function shortWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `about ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export interface LimitInfo {
  /** The free daily limit is spent (retrying in a minute will not help). */
  readonly daily: boolean;
  /** How long Google said to wait, when it said. */
  readonly retryAfterMs?: number | undefined;
}

/** When the daily limit is back, in the user's time: Google's own wait if it gave one, else "around" the measured reset. */
function dailyBack(info: LimitInfo, now: Date, options: TimeOptions): string {
  if (info.retryAfterMs !== undefined) {
    // Google's wait is to the second (and often one short of a round time): say the next whole minute — better a moment late than early.
    const back = Math.ceil((now.getTime() + info.retryAfterMs) / 60_000) * 60_000;
    return `at ${clockPhrase(new Date(back), now, options)}`;
  }
  return `around ${clockPhrase(nextUtcMidnight(now), now, options)}`;
}

/**
 * What to tell the user when Gemini's limits are why something cannot be done. Always says what comes back and when:
 * the daily limit at the moment Google gave (in the user's own time), a short wait as named, and — when Google named
 * nothing — both possibilities, honestly.
 */
export function limitMessage(info: LimitInfo, now: Date, options: TimeOptions = {}): string {
  if (info.daily) {
    return (
      `I've used up today's free Gemini limit, so I can't do that until it comes back ${dailyBack(info, now, options)}. ` +
      'Try again after that, or turn on billing in Google AI Studio and it works straight away.'
    );
  }
  if (info.retryAfterMs !== undefined) {
    return `I've hit Gemini's usage limit for a moment. Try again in ${shortWait(info.retryAfterMs)}.`;
  }
  return (
    "I've hit Gemini's free usage limit. If it's the short per-minute one, try again in about a minute. " +
    `If it still says this, it's the daily limit, which comes back ${dailyBack({ daily: true }, now, options)}.`
  );
}

/** For Gemini Live (Talk mode), which only says "quota exceeded" without which limit it was or when it ends. */
export function liveLimitMessage(detail: string, now: Date, options: TimeOptions = {}): string {
  const daily = dailyBack({ daily: true }, now, options);
  if (/\bday\b|daily|per.?day/i.test(detail)) {
    return `Live voice has used up its limit for today. It should come back ${daily}. Until then I can still do things you type or say normally.`;
  }
  return `Live voice has hit its usage limit right now. Try again in a minute or two. If it keeps saying that, the daily limit should come back ${daily}.`;
}
