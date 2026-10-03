/**
 * Working out WHICH chat the user means, from what they said and what the chat list really shows — locally, so the
 * model is only ever told the few names that matched, never the whole list.
 *
 * People say "Rahul", "Rahul Sharma", "Sharma", "the one ending 432", "the number starting 98765", or a name as a
 * speech recogniser heard it. The rule that matters is the last one: when more than one chat genuinely fits, this says
 * so and nothing is guessed. A single strong match is used; several are shown for the user to choose.
 */

export interface ChatCandidate {
  /** The chat's name as the app shows it (a contact's name, or a bare phone number for someone not saved). */
  readonly label: string;
  /** Any extra text from the same row that may hold a number (never a message). */
  readonly detail?: string;
}

export type MatchStrength = 'exact' | 'strong' | 'partial' | 'fuzzy';

export interface ChatMatch<T extends ChatCandidate = ChatCandidate> {
  readonly candidate: T;
  readonly strength: MatchStrength;
  /** What matched, in a few words — for the log and for telling the user why. */
  readonly reason: 'name' | 'first or last name' | 'close spelling' | 'phone number';
  /** A higher number is a closer match. */
  readonly score: number;
  /** The last digits of the number, when one was visible. */
  readonly phoneEnding?: string;
}

export type ChatResolution<T extends ChatCandidate = ChatCandidate> =
  | { readonly kind: 'unique'; readonly match: ChatMatch<T>; readonly viaRecent?: boolean }
  | { readonly kind: 'ambiguous'; readonly matches: readonly ChatMatch<T>[] }
  | { readonly kind: 'none' };

const FILLER = new Set([
  'chat', 'chats', 'contact', 'contacts', 'number', 'phone', 'mobile', 'with', 'named', 'called', 'name', 'the', 'a', 'an', 'to', 'in', 'on', 'of',
  'whose', 'which', 'that', 'has', 'have', 'digits', 'digit', 'person', 'one', 'and', 'ending', 'ends', 'end', 'ended', 'last', 'starting', 'starts',
  'start', 'begins', 'begin', 'beginning', 'my', 'for', 'is', 'at', 'from', 'send', 'open', 'find', 'search', 'share', 'message', 'messages', 'text',
]);

/** Lower-case, no accents on Latin letters (but Indic and other scripts keep their vowel signs), punctuation to spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type DigitMode = 'ends' | 'starts' | 'any';

export interface ParsedChatQuery {
  readonly names: readonly string[];
  readonly digits: string;
  readonly digitMode: DigitMode | null;
}

/** Splits what the user said into name words and digits ("ending in 432", "starts with 98765", "+91 98765 00432"). */
export function parseChatQuery(query: string): ParsedChatQuery {
  const raw = query.normalize('NFKC');
  const lower = raw.toLowerCase();
  const digits = (raw.match(/\d/g) ?? []).join('');
  let mode: DigitMode | null = null;
  if (digits.length > 0) {
    if (/\b(ending|ends?|ended|last)\b/.test(lower)) mode = 'ends';
    else if (/\b(starting|starts?|begins?|beginning)\b/.test(lower)) mode = 'starts';
    else mode = 'any';
  }
  const names = normalizeText(raw.replace(/[+\d][\d\s().-]*/g, ' '))
    .split(' ')
    .filter((t) => t.length > 0 && !FILLER.has(t));
  return { names, digits, digitMode: mode };
}

/** The last `n` digits of the first phone-looking number (7+ digits) in the text, or null. */
export function phoneEnding(text: string, n = 3): string | null {
  for (const run of text.match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) {
    const d = run.replace(/\D/g, '');
    if (d.length >= 7) return d.slice(-n);
  }
  return null;
}

function digitRuns(text: string): string[] {
  return (text.match(/\+?\d[\d\s().-]{4,}\d/g) ?? []).map((r) => r.replace(/\D/g, '')).filter((d) => d.length >= 6);
}

function levenshtein(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length] as number;
}

type TokenHit = 'equal' | 'prefix' | 'inside' | 'close';

/** `initial`: the user gave several words, so a single letter is an initial ("Rahul V"), not a guess. */
function tokenHit(q: string, c: string, initial: boolean): TokenHit | null {
  if (q === c) return 'equal';
  if ((q.length >= 2 || initial) && c.startsWith(q)) return 'prefix';
  if (q.length >= 3 && c.includes(q)) return 'inside';
  const limit = q.length >= 9 ? 2 : q.length >= 5 ? 1 : 0;
  if (limit > 0 && levenshtein(q, c, limit) <= limit) return 'close';
  return null;
}

const HIT_SCORE: Record<TokenHit, number> = { equal: 4, prefix: 3, inside: 2, close: 1 };

function digitsMatch(mode: DigitMode, want: string, runs: readonly string[]): 'strong' | 'weak' | null {
  if (want.length < 2) return null;
  for (const run of runs) {
    const national = [run, run.slice(1), run.slice(2), run.slice(3)];
    if (mode === 'ends') {
      if (run.endsWith(want)) return 'strong';
    } else if (mode === 'starts') {
      if (national.some((r) => r.startsWith(want))) return 'strong';
    } else if (run.endsWith(want) || national.some((r) => r.startsWith(want))) {
      return want.length >= 3 ? 'strong' : 'weak';
    }
  }
  if (mode === 'any' && runs.some((r) => r.includes(want))) return 'weak';
  return null;
}

/** How a single candidate answers the query, or null if it does not fit. */
function judge<T extends ChatCandidate>(q: ParsedChatQuery, candidate: T): ChatMatch<T> | null {
  const label = normalizeText(candidate.label);
  const tokens = label.split(' ').filter((t) => t.length > 0);
  const runs = digitRuns(`${candidate.label} ${candidate.detail ?? ''}`);
  const ending = phoneEnding(`${candidate.label} ${candidate.detail ?? ''}`) ?? undefined;
  const withEnding = (m: Omit<ChatMatch<T>, 'phoneEnding'>): ChatMatch<T> => ({ ...m, ...(ending !== undefined ? { phoneEnding: ending } : {}) });

  let namePart: { strength: MatchStrength; score: number; reason: ChatMatch['reason'] } | null = null;
  if (q.names.length > 0) {
    const used = new Set<number>();
    let score = 0;
    let worst: TokenHit = 'equal';
    for (const word of q.names) {
      let bestIdx = -1;
      let best: TokenHit | null = null;
      for (let i = 0; i < tokens.length; i += 1) {
        if (used.has(i)) continue;
        const hit = tokenHit(word, tokens[i] as string, q.names.length > 1);
        if (hit !== null && (best === null || HIT_SCORE[hit] > HIT_SCORE[best])) {
          best = hit;
          bestIdx = i;
        }
      }
      if (best === null) return null; // every word the user said has to be found in the name
      used.add(bestIdx);
      score += HIT_SCORE[best];
      if (HIT_SCORE[best] < HIT_SCORE[worst]) worst = best;
    }
    const sameWords = used.size === tokens.length;
    if (label === normalizeText(q.names.join(' ')) && worst === 'equal') namePart = { strength: 'exact', score: 100 + score, reason: 'name' };
    else if (sameWords && worst === 'equal') namePart = { strength: 'strong', score: 50 + score, reason: 'name' }; // the same words, in any order
    else if (worst === 'close') namePart = { strength: 'fuzzy', score, reason: 'close spelling' };
    else namePart = { strength: 'partial', score, reason: 'first or last name' };
  }

  let phonePart: 'strong' | 'weak' | null = null;
  if (q.digitMode !== null) phonePart = digitsMatch(q.digitMode, q.digits, runs);

  if (q.names.length === 0) {
    // Only digits were given.
    if (phonePart === null) return null;
    return withEnding({ candidate, strength: phonePart === 'strong' ? 'strong' : 'partial', reason: 'phone number', score: phonePart === 'strong' ? 60 : 10 });
  }
  if (q.digitMode !== null) {
    // Name AND digits were given. If the row shows no number at all the digits cannot be checked: only a partial fit.
    if (phonePart === null) {
      if (runs.length > 0) return null; // it shows a number and it is not this one
      return namePart === null ? null : withEnding({ candidate, strength: 'partial', reason: namePart.reason, score: namePart.score });
    }
    return namePart === null ? null : withEnding({ candidate, strength: namePart.strength === 'fuzzy' ? 'fuzzy' : 'strong', reason: 'phone number', score: namePart.score + 40 });
  }
  return namePart === null ? null : withEnding({ candidate, strength: namePart.strength, reason: namePart.reason, score: namePart.score });
}

const TIERS: readonly MatchStrength[] = ['exact', 'strong', 'partial', 'fuzzy'];

/**
 * Decides between the chats on screen. The best tier that has any match decides: one match in it means that chat; several
 * mean the user must choose (unless exactly one of them is a chat used earlier in this conversation).
 */
export function resolveChat<T extends ChatCandidate>(query: string, candidates: readonly T[], options: { readonly recent?: readonly string[] } = {}): ChatResolution<T> {
  const parsed = parseChatQuery(query);
  if (parsed.names.length === 0 && parsed.digits.length < 2) return { kind: 'none' };
  const seen = new Set<string>();
  const matches: ChatMatch<T>[] = [];
  for (const c of candidates) {
    const m = judge(parsed, c);
    if (m === null) continue;
    // The same chat shown twice (a search result and the list) is one chat.
    const key = `${normalizeText(c.label)}|${m.phoneEnding ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(m);
  }
  for (const tier of TIERS) {
    const inTier = matches.filter((m) => m.strength === tier).sort((a, b) => b.score - a.score);
    if (inTier.length === 0) continue;
    if (inTier.length === 1) return { kind: 'unique', match: inTier[0] as ChatMatch<T> };
    const recent = (options.recent ?? []).map(normalizeText);
    const used = inTier.filter((m) => recent.includes(normalizeText(m.candidate.label)));
    if (used.length === 1) return { kind: 'unique', match: used[0] as ChatMatch<T>, viaRecent: true };
    return { kind: 'ambiguous', matches: inTier };
  }
  return { kind: 'none' };
}

/** Words that are controls of a chat app, never somebody's name. */
const CONTROL_NAME =
  /^(send|attach|search|new chat|menu|status|channels?|communit(?:y|ies)|settings|profile|log ?out|archived?|filter|unread|all|groups?|mute|call|video call|voice call|emoji|gif|stickers?|camera|photos?(?: videos?)?|document|contact|poll|more|back|close|cancel|ok|chats?|calls?|reels?|explore|home|notifications?|messages?|requests?|inbox|primary|general|new message|add|info|details|type a message|write a message)$/;

export function looksLikeControl(name: string): boolean {
  return CONTROL_NAME.test(normalizeText(name));
}
