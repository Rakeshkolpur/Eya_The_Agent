import type { LiveRelation } from '@shared/liveChat';

/**
 * How Eya sounds in a live chat. Three things, all of them checked in code and not only asked of the model:
 *  1. SHORT, like a person on a phone: a reply is at most about twice as many words as what they wrote, plus a few (never more than 24, 30 for a senior or a client, two short
 *     sentences, one line). The cloud models were told "short" and still wrote four sentences; what is longer is cut at a sentence or a clause, never sent whole.
 *  2. Fitted to WHO they are to the person: a friend, a partner, family, a senior (sir, madam, boss, teacher), a client. Asked once before the chat starts.
 *  3. Fitted to how they FEEL: the feeling is answered first, in a few words.
 */

export const RELATION_LABEL: Readonly<Record<LiveRelation, string>> = {
  friend: 'a friend',
  partner: 'a partner',
  family: 'family',
  senior: 'a senior (sir, madam, boss, teacher)',
  client: 'a client',
  other: 'someone else',
};

// (partner first: "my girlfriend, she is a friend of …" is a partner; a word for a senior in a sentence about a friend is rare, a friend's word in one about a senior rarer)
const PARTNER = /\b(?:lover|girl\s?friend|boy\s?friend|gf|bf|wife|husband|fianc[eé]e?|partner|darling|sweetheart|spouse|my\s+love)\b/i;
const CLIENT = /\b(?:client|customer|patient|litigant)\b/i;
const SENIOR = /\b(?:sir|madam|ma'?am|saar|boss|manager|teacher|professor|principal|senior|judge|guru(?:ji)?|my\s+advocate|lawyer\s+sir)\b/i;
const FAMILY = /\b(?:mom|mum|mother|amma|dad|father|nanna|appa|brother|sister|akka|uncle|aunt(?:y|ie)?|grand\s?(?:ma|pa|mother|father)|family|cousin|son|daughter|relative|in-?laws?)\b/i;
const FRIEND = /\b(?:friend|buddy|bestie|best\s+friend|close\s+friend|pal|mate|dude|bro|sis|classmate)\b/i;
const OTHER = /\b(?:other|colleague|co-?worker|neighbou?r|stranger|someone\s+else|acquaintance)\b/i;

/** Who the other person is, from what was said about them ("she is my close friend", "my sir", "girlfriend", "family"); null when nothing says. */
export function relationFrom(text: string): LiveRelation | null {
  const t = text.trim();
  if (t === '') return null;
  if (PARTNER.test(t)) return 'partner';
  if (CLIENT.test(t)) return 'client';
  if (SENIOR.test(t)) return 'senior';
  if (FAMILY.test(t)) return 'family';
  if (FRIEND.test(t)) return 'friend';
  if (OTHER.test(t)) return 'other';
  return null;
}

/** What the model is told about how to be with this person. */
export function relationStyle(r: LiveRelation | null): string {
  switch (r) {
    case 'friend':
      return 'They are a friend: casual, playful and warm, like friends texting; a light joke or slang is fine; at most one emoji.';
    case 'partner':
      return 'They are the person\'s partner (lover, spouse): warm, caring and affectionate, gentle and personal, never cold or formal; use a pet name only if they use one first; keep it respectful and never explicit; never claim feelings or facts the chat does not give.';
    case 'family':
      return 'They are family: warm, respectful (especially to elders) and simple; show care for their health and wellbeing; no slang with elders.';
    case 'senior':
      return 'They are a senior (sir, madam, boss, teacher): polite, respectful and brief; address them the way the chat does (sir, madam); no slang, no jokes, no emoji; never familiar.';
    case 'client':
      return 'They are a client: professional, courteous and brief; no slang, no emoji; never promise a time, a price or an outcome.';
    case 'other':
      return 'Polite, friendly and brief; no slang until they use it.';
    default:
      return 'Be natural, polite and warm.';
  }
}

/** How to answer what they FEEL (put to every model). */
export const FEELINGS_RULE =
  'Read how they feel from their words, punctuation and emoji, and answer the FEELING first, in a few words: if they are sad or worried, comfort them kindly; if they are happy or excited, share it; if they are upset or angry, stay calm and kind, acknowledge it and do not argue or defend; if they joke, answer lightly; if they miss you or show affection, answer warmly; if they only say "ok" or "thanks", answer in one or two words, or not at all. Do not give advice, lectures or explanations nobody asked for.';

export interface ReplyLimits {
  readonly maxWords: number;
  readonly maxSentences: number;
}

export const wordsOf = (t: string): string[] => t.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w !== '');

/**
 * How long a reply may be. About twice what they wrote, plus a few words, between 16 and 24 words (30 for a senior or a client: a courteous reply needs a little more);
 * the first message of a chat may say who Eya is (a few words more), and a check-in is one short line.
 */
export function replyLimits(input: { readonly theirText: string; readonly relation?: LiveRelation | null; readonly kind?: 'reply' | 'opening' | 'nudge'; readonly introduce?: boolean }): ReplyLimits {
  const formal = input.relation === 'senior' || input.relation === 'client';
  const cap = formal ? 30 : 24;
  const theirs = wordsOf(input.theirText).length;
  // (a first message may say who Eya is, and a check-in is one short line: neither answers anything, so what they wrote does not set their length)
  let max = input.kind === 'opening' ? 28 : input.kind === 'nudge' ? 18 : Math.min(cap, Math.max(16, Math.round(theirs * 2) + 10));
  if (input.introduce === true) max += 10;
  // (the number of words is what keeps it short; three very short sentences may fit in it: "Thanks for the file! It looks like notes. Why did you send it?")
  return { maxWords: max, maxSentences: 3 };
}

const SENTENCE_END = /(?<=[.!?…])\s+/;

/**
 * The reply cut to the limits: one line; the first sentences while they fit; and a sentence that is too long on its own cut at the last comma or "and"/"but" that fits (a reply
 * is never cut in the middle of a clause that has no ending, and never gets "…" added). A reply within the limits is returned as it is, apart from the line breaks.
 */
export function fitLength(text: string, limits: ReplyLimits): string {
  const one = text.replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (one === '') return one;
  // ("Hi!", "Aww!", "Oh no!": a word or two of reaction belongs to the sentence after it, and is not a sentence of its own)
  const sentences: string[] = [];
  for (const part of one.split(SENTENCE_END).filter((x) => x !== '')) {
    const last = sentences.length - 1;
    // (an emoji or a mark on its own after a sentence belongs to it too)
    if (last >= 0 && (wordsOf(sentences[last] as string).length <= 2 || !/[\p{L}\p{N}]/u.test(part))) sentences[last] = `${sentences[last]} ${part}`;
    else sentences.push(part);
  }
  const kept: string[] = [];
  let words = 0;
  for (const s of sentences) {
    const n = wordsOf(s).length;
    if (kept.length >= limits.maxSentences) break;
    if (kept.length > 0 && words + n > limits.maxWords) break;
    kept.push(s);
    words += n;
  }
  let out = kept.join(' ');
  if (wordsOf(out).length <= limits.maxWords) return out;
  // one sentence (or two) still too long: the clauses that fit
  const all = wordsOf(out);
  const head = all.slice(0, limits.maxWords).join(' ');
  const clause = Math.max(head.lastIndexOf(','), head.search(/\s(?:and|but|so|because)\s[^\s]*$/));
  out = clause > head.length * 0.4 ? head.slice(0, clause).replace(/[,\s]+$/, '') : head.replace(/[,\s]+$/, '');
  return out;
}
