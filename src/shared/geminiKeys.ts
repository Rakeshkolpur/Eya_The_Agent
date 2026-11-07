/**
 * Several Gemini keys: the person's own, and keys that family or friends have given (each from their own free Google account), used one
 * after another: the first until its free allowance for the day is spent, then the next, and so on. What the page and the main process
 * both need to know about them lives here; nothing in this file ever holds a key beyond the moment it is typed or pasted.
 */

import { backupPreset, providerFromKey } from './backupAi';
import { clockPhrase } from './quotaReset';

/** The most keys that can be added besides the person's own. */
export const MAX_FAMILY_KEYS = 10;

// Letters, numbers, dashes and underscores (a Google key is 39 of them, starting AIza). A dot is allowed too: Google has issued other
// styles of key, and only Google can say whether one is real, so the shape is checked loosely and the key is then checked with Google.
const KEY_PATTERN = /^[A-Za-z0-9_.-]{20,120}$/;

export function looksLikeGeminiKey(text: string): boolean {
  return KEY_PATTERN.test(text);
}

/**
 * What was pasted, with what a copy from a web page, a chat or a document often brings along taken out: invisible characters, a
 * no-break space, curly quotes. What the person can't see is what makes a key "not a key".
 */
export function normalizePasted(text: string): string {
  return text
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[  -   　]/g, ' ')
    .replace(/[‘’“”«»`"']/g, ' ');
}

const TOKEN = /[A-Za-z0-9_.-]{20,120}/g;

/**
 * The key among the long words of a line: the one that starts like a Google key if there is one; then one in Google's other style; then
 * the last one without a dot (a name is rarely that long, and an address such as aistudio.google.com has dots); last of all any long word.
 */
function pickKey(tokens: readonly string[]): string | undefined {
  const found =
    tokens.find((t) => t.startsWith('AIza')) ??
    tokens.find((t) => t.startsWith('AQ.')) ??
    [...tokens].reverse().find((t) => !t.includes('.')) ??
    tokens[tokens.length - 1];
  return found === undefined ? undefined : found.replace(/^\.+|\.+$/g, '');
}

/** The one key in a pasted text (a name, quotes, "key=" or a stray line around it do not matter), or undefined. */
export function extractKey(text: string): string | undefined {
  const key = pickKey(normalizePasted(text).match(TOKEN) ?? []);
  return key !== undefined && looksLikeGeminiKey(key) && !isAnotherServicesKey(key) ? key : undefined;
}

/** A key that starts the way another service's keys do (OpenRouter, Groq, …): it is not a Gemini key, so it is not sent to Google to find out. */
function isAnotherServicesKey(key: string): boolean {
  const other = providerFromKey(key);
  return other !== undefined && other !== 'google';
}

/**
 * Why a pasted text is not a Gemini key, in words the person can act on. Never repeats what was pasted beyond its first four characters
 * (enough to tell an OpenAI key from a Google one) and its length.
 */
export function whyNotAKey(raw: string): string {
  const text = normalizePasted(raw).trim();
  if (text === '') return 'Paste a key first.';
  const other = providerFromKey(text);
  if (other !== undefined && other !== 'google') {
    return `That looks like a ${backupPreset(other).label} key, not a Gemini key. Add it under Backup AI instead. Nothing was saved.`;
  }
  const compact = text.replace(/\s+/g, '');
  const start = /^[A-Za-z0-9_.-]{4}/.test(compact) ? ` It starts with "${compact.slice(0, 4)}".` : '';
  if (compact.length < 20) {
    return `What you pasted is only ${compact.length} character${compact.length === 1 ? '' : 's'} long; a Gemini key is about 39 letters and numbers, usually starting with AIza. Copy it whole from aistudio.google.com/apikey.${start} Nothing was saved.`;
  }
  return `I couldn't use what you pasted as a Gemini key (${compact.length} characters; a key is letters, numbers, dashes and underscores, about 39 of them, usually starting with AIza).${start} Copy it again from aistudio.google.com/apikey, with nothing else around it. Nothing was saved.`;
}

/** "…abcd": enough to recognise a key by, nothing that could be used. */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

/** A name someone typed ("Father", "my brother's account"), tidied: no stray separators, one line, short. */
export function cleanKeyName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s:=,;|\-–—]+|[\s:=,;|\-–—]+$/g, '')
    .slice(0, 24)
    .trim();
}

export interface KeyLine {
  readonly name: string;
  readonly key: string;
}

/**
 * Reads what was pasted into the "add several" box: one key to a line, with the person's name before or after it
 * ("Father  AIza…", "Brother: AIza…", or just the key). A line with nothing that looks like a key is reported by its number, never echoed:
 * it may be half a key.
 */
export function parseKeyLines(text: string): { readonly entries: readonly KeyLine[]; readonly skippedLines: readonly number[] } {
  const entries: KeyLine[] = [];
  const skippedLines: number[] = [];
  const lines = normalizePasted(text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;
    const key = pickKey(line.match(TOKEN) ?? []);
    if (key === undefined || !looksLikeGeminiKey(key) || isAnotherServicesKey(key)) {
      skippedLines.push(index + 1);
      return;
    }
    entries.push({ name: cleanKeyName(line.replace(key, ' ')), key });
  });
  return { entries, skippedLines };
}

/** How a key stands right now. */
export type GeminiKeyState = 'ready' | 'used-up' | 'busy' | 'refused';

export interface GeminiKeyEntry {
  /** A short fingerprint: names the key without being it. */
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  /** The person's own key (set under "Paste your key" or in .env). It cannot be removed from the list of extra keys. */
  readonly main: boolean;
  readonly state: GeminiKeyState;
  /** When a used-up or busy key will be tried again (epoch ms). */
  readonly backAt: number | null;
  /** How many requests it has answered today. */
  readonly requests: number;
  /** The key that is answering now. */
  readonly inUse: boolean;
}

export interface GeminiKeysStatus {
  /** Whether Windows can protect saved keys on this account. */
  readonly canSave: boolean;
  readonly max: number;
  readonly entries: readonly GeminiKeyEntry[];
  /** Eya started with no Gemini key at all, so some of what a key switches on needs her to restart once. */
  readonly pendingRestart: boolean;
}

export interface GeminiKeysResult {
  readonly ok: boolean;
  /** What happened, in words the person can read. */
  readonly message: string;
  readonly status: GeminiKeysStatus;
}

/** What the page sends to add keys: one key with a name, or the text of the "add several" box. */
export type GeminiKeysInput = { readonly name: string; readonly key: string } | { readonly lines: string };

/** At most this many automatic restarts of the live voice on another key within `windowMs`, so a broken connection cannot loop. */
export function liveRetryAllowed(previous: readonly number[], now: number, max = 2, windowMs = 120_000): boolean {
  return previous.filter((t) => now - t < windowMs).length < max;
}

/** One line about how a key stands, for the list: "answering now · 12 requests today", "free allowance for today is used up · tried again 5:30 AM tomorrow". */
export function describeKey(entry: GeminiKeyEntry, now: number = Date.now()): string {
  const used = entry.requests > 0 ? ` · ${entry.requests} request${entry.requests === 1 ? '' : 's'} today` : '';
  switch (entry.state) {
    case 'used-up':
      return `free allowance for today is used up${entry.backAt !== null ? ` · tried again ${clockPhrase(new Date(entry.backAt), new Date(now))}` : ''}${used}`;
    case 'busy':
      return `slowed down by Google for a moment${used}`;
    case 'refused':
      return 'Google refused this key: remove it and add a new one';
    default:
      return `${entry.inUse ? 'answering now' : 'ready'}${used}`;
  }
}
