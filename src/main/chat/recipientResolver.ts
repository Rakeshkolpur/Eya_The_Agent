import { looksLikeControl, normalizeText, resolveChat } from './contactMatch';
import type { ChatCandidate } from './contactMatch';
import { DEFAULT_COUNTRY, maskNumber, readPhoneReference } from './phoneNumbers';
import type { CountryContext, PhoneReading } from './phoneNumbers';

/**
 * Who a message or a file is for: the one place that reads what the person said ("+91 9361113900", "9361113900", "the one ending 3900", "Anna", "him",
 * "the same person I messaged yesterday"), weighs it against what is on offer, and says how sure it is — in a structured answer that any chat app can use.
 *
 * It knows nothing about WhatsApp's page, a browser or a tool: the page (or any other source of contacts) gives it ROWS (a name, and a number when the
 * app shows one) and it gives back WHO, WITH WHAT EVIDENCE, and whether the person has to be asked. Pure, so it is tested without any app.
 *
 * What it never does:
 *  - make up a digit, a number or a person (a whole number is only ever the one the person said, with a country code added only when the number is valid in
 *    the configured country: see phoneNumbers.ts);
 *  - call a recipient settled on the end of a number alone, unless that end is on the row itself, is long enough to be nearly unique, and nobody else fits;
 *  - choose between people who all fit: several are returned for the person to choose between, with their numbers masked;
 *  - settle on a pronoun or "the person I messaged yesterday" without it being said back and confirmed.
 */

export type ReferenceKind =
  /** A whole phone number (with or without its country code, valid for its country). */
  | 'full_number'
  /** Some digits of a number ("ending 3900"). */
  | 'partial_number'
  /** Digits that look like a whole number but are not a valid number anywhere (no country code is guessed onto them). */
  | 'unclear_number'
  /** A name, a nickname, a part of a name. */
  | 'name'
  /** "him", "her", "the last person I messaged", "the same person I messaged yesterday". */
  | 'context';

export type ContextKind = 'pronoun' | 'last' | 'recent' | 'yesterday';

export interface ContextReference {
  readonly kind: ContextKind;
  /** The words as they were said, for saying them back. */
  readonly phrase: string;
}

export interface RecipientReference {
  /** What the person said, as it was said. */
  readonly raw: string;
  readonly kind: ReferenceKind;
  readonly phone?: PhoneReading;
  readonly context?: ContextReference;
}

// ------------------------------------------------------------------------------------------------------------------------ reading what was said
const PRONOUN = /^(?:him|her|them|that\s+(?:person|contact|chat|one|guy|girl)|this\s+(?:person|contact|chat)|the\s+same\s+(?:person|contact|chat|one|guy|girl)|same\s+(?:person|contact|chat|one)|the\s+(?:person|contact|chat)\s+(?:i\s+)?(?:am|was)\s+(?:talking|chatting|speaking)\s+(?:to|with))$/i;
const LAST = /^(?:the\s+)?(?:last|previous|latest|most\s+recent)\s+(?:one|person|contact|chat|conversation|guy|girl)(?:\s+(?:i|we)\s+(?:just\s+)?(?:messaged|texted|wrote\s+to|sent\s+(?:a\s+message\s+)?to|chatted\s+with|talked\s+to|spoke\s+to|whatsapped))?$/i;
const PERSON_I_MESSAGED =
  /^(?:the\s+)?(?:same\s+)?(?:person|one|guy|girl|friend|contact|chat)\s+(?:that\s+|whom\s+|who\s+)?(?:i|we)\s+(?:just\s+)?(?:messaged|texted|wrote\s+to|sent\s+(?:a\s+message\s+)?to|chatted\s+with|talked\s+to|spoke\s+to|whatsapped|was\s+chatting\s+with)(?:\s+(.+))?$/i;
const YESTERDAY = /^(?:yesterday|last\s+night|the\s+(?:day|night)\s+before)$/i;
const RECENT = /^(?:today|this\s+morning|earlier(?:\s+today)?|just\s+now|a\s+(?:moment|minute|while)\s+ago|(?:a\s+)?(?:few|couple\s+of)\s+(?:minutes|moments)\s+ago|before|last\s+time|previously|recently|a\s+little\s+while\s+ago)$/i;

/** "him", "the last person I messaged", "the same person I messaged yesterday": a reference to somebody by the conversation, not by name or number. Null for anything else. */
export function readContextReference(text: string): ContextReference | null {
  const phrase = text.trim().replace(/[.,!?]+$/, '').replace(/\s+/g, ' ');
  if (phrase === '' || phrase.length > 80) return null;
  if (PRONOUN.test(phrase)) return { kind: 'pronoun', phrase };
  if (LAST.test(phrase)) return { kind: 'last', phrase };
  const said = PERSON_I_MESSAGED.exec(phrase);
  if (said !== null) {
    const when = (said[1] ?? '').trim();
    if (when === '') return { kind: 'last', phrase };
    if (YESTERDAY.test(when)) return { kind: 'yesterday', phrase };
    if (RECENT.test(when)) return { kind: 'recent', phrase };
    return null; // "…on Monday", "…last week": not something that is known well enough to be settled by guessing
  }
  return null;
}

const LEAD_CONTEXT: readonly RegExp[] = [
  /^(him|her|them)\s+(.+)$/is,
  /^((?:the\s+)?(?:last|previous|latest|most\s+recent)\s+(?:one|person|contact|chat)(?:\s+i\s+(?:just\s+)?(?:messaged|texted))?)\s+(.+)$/is,
  /^((?:the\s+)?(?:same\s+)?(?:person|one|guy|girl|friend)\s+(?:that\s+|who\s+)?i\s+(?:just\s+)?(?:messaged|texted|chatted\s+with)(?:\s+(?:yesterday|today|earlier|just\s+now|before|last\s+time))?)\s+(.+)$/is,
];

/** "him I'm late", "the last person I messaged hello": a reference to the conversation at the START of the words, and the message after it exactly as it was said. Null when the words do not start with one. */
export function splitLeadingContext(rest: string): { readonly phrase: string; readonly text: string } | null {
  const words = rest.trim();
  for (const pattern of LEAD_CONTEXT) {
    const m = pattern.exec(words);
    if (m?.[1] === undefined || m[2] === undefined || readContextReference(m[1]) === null) continue;
    return { phrase: m[1].trim(), text: m[2].trim() };
  }
  return null;
}

/** What a recipient phrase is: a number (whole, partial, unclear), a reference to the conversation, or a name. Country decides how a number without a code is read. */
export function readRecipientReference(raw: string, country: CountryContext = DEFAULT_COUNTRY): RecipientReference {
  const text = raw.trim();
  const phone = readPhoneReference(text, country);
  if (phone !== null) {
    const kind: ReferenceKind = phone.kind === 'partial' ? 'partial_number' : phone.kind === 'unclear' ? 'unclear_number' : 'full_number';
    return { raw: text, kind, phone };
  }
  const context = readContextReference(text);
  if (context !== null) return { raw: text, kind: 'context', context };
  return { raw: text, kind: 'name' };
}

// ------------------------------------------------------------------------------------------------------------------------ the answer
export type Confidence = 'high' | 'medium' | 'low' | 'none';

/**
 * resolved   — one person, settled by evidence strong enough to act on.
 * confirm    — one person, found, but the evidence is not an identity (a part of a number, a pronoun…): say who it is and ask before sending.
 * ambiguous  — several people fit: ask which.
 * not_found  — nobody fits what was said: say what is missing.
 * unreadable — what was said cannot be read as a recipient (an invalid number, "him" with nobody before): ask once, focused.
 */
export type RecipientStatus = 'resolved' | 'confirm' | 'ambiguous' | 'not_found' | 'unreadable';

export type EvidenceKind =
  | 'exact_number'
  | 'number_other_country'
  | 'app_search_whole_number'
  | 'number_suffix'
  | 'number_prefix'
  | 'number_inside'
  | 'app_search_part_of_number'
  | 'exact_name'
  | 'name_match'
  | 'close_spelling'
  | 'used_earlier'
  | 'recent_conversation'
  | 'recent_history';

export interface RecipientRow {
  readonly label: string;
  readonly detail?: string;
  /** The app's own search (typed with the digits) returned this row: it matched the number in its own data even when it does not show the number. */
  readonly fromSearch?: boolean;
}

export interface RecipientCandidate<T extends RecipientRow = RecipientRow> {
  readonly row: T;
  readonly evidence: EvidenceKind;
  /** The number the row itself shows (an unsaved contact is listed under its number), as digits; null when it shows none. */
  readonly shownNumber: string | null;
  /** The shown number with all but its last four digits hidden: how a person is asked about it without a whole number being read out. */
  readonly masked: string | null;
  readonly confidence: Confidence;
  /** In a few words, why this row fits (for saying it, and for the log: never a whole number or a message). */
  readonly why: string;
}

export interface RecipientResolution<T extends RecipientRow = RecipientRow> {
  readonly reference: RecipientReference;
  /** The whole number, with its country code (digits only), when the person gave one that is valid. */
  readonly normalized: string | null;
  readonly status: RecipientStatus;
  readonly confidence: Confidence;
  readonly candidates: ReadonlyArray<RecipientCandidate<T>>;
  /** The one person, for `resolved` and `confirm`. */
  readonly chosen: RecipientCandidate<T> | null;
  /** True when the person must say something before anything is sent: `confirm`, `ambiguous`, `unreadable`. */
  readonly needsClarification: boolean;
  /** One focused question for the person when `needsClarification`; never a whole number, never a request to repeat what was already said. */
  readonly question: string | null;
  /** Why, in one sentence (for the log and for the person when nobody was found). */
  readonly reason: string;
  /** True only for `resolved` with `high` confidence: a request to send IS the instruction to send, once this is true. */
  readonly safeToSend: boolean;
}

export interface RecentRecipient {
  readonly label: string;
  /** When it was last used (milliseconds since 1970). */
  readonly at: number;
  /** In this very conversation (in memory) rather than from the saved history. */
  readonly session?: boolean;
}

export interface ResolveOptions {
  readonly country?: CountryContext;
  /** The chats this conversation used, and when (most recent first), for a pronoun or "the one I messaged yesterday". Names only. */
  readonly recents?: readonly RecentRecipient[];
  readonly now?: number;
  /** Whether the rows came from the app's own search typed with the digits (so a row that shows no number still matched it). */
  readonly searched?: boolean;
}

// ------------------------------------------------------------------------------------------------------------------------ numbers shown on a row
/** The run of digits a row shows as its number (an unsaved contact is listed as "+91 93611 13900"), as a whole number when it can be read as one. */
export function shownNumberOf(row: RecipientRow, country: CountryContext = DEFAULT_COUNTRY): string | null {
  for (const text of [row.label, row.detail ?? '']) {
    for (const run of text.normalize('NFKC').match(/\+?\d[\d\s().-]{5,}\d/g) ?? []) {
      const read = readPhoneReference(run, country);
      if (read !== null && read.e164 !== undefined && (read.kind === 'international' || read.kind === 'national')) return read.e164;
      const digits = run.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) return digits;
    }
  }
  return null;
}

const HOUR = 3_600_000;
const SAME_CONVERSATION_MS = 30 * 60_000;

function dayStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function result<T extends RecipientRow>(
  reference: RecipientReference,
  fields: Pick<RecipientResolution<T>, 'status' | 'confidence' | 'candidates' | 'chosen' | 'reason'> & { readonly question?: string | null },
): RecipientResolution<T> {
  const needs = fields.status === 'confirm' || fields.status === 'ambiguous' || fields.status === 'unreadable';
  return {
    reference,
    normalized: reference.phone?.e164 ?? null,
    status: fields.status,
    confidence: fields.confidence,
    candidates: fields.candidates,
    chosen: fields.chosen,
    needsClarification: needs,
    question: needs ? (fields.question ?? null) : null,
    reason: fields.reason,
    safeToSend: fields.status === 'resolved' && fields.confidence === 'high',
  };
}

/** A text with every phone number in it (a chat listed under its number) hidden down to its last four digits. */
export function maskNumbersIn(text: string): string {
  return text.replace(/\+?\d[\d\s().-]{5,}\d/g, (run) => maskNumber(run.replace(/\D/g, '')) || run);
}

/** "Anna (+91 ••••••3900)" — a row as a person is asked about it. */
export function describeCandidate(c: { readonly row: RecipientRow; readonly masked: string | null }): string {
  const shown = maskNumbersIn(c.row.label);
  const withNumber = c.masked !== null && !/•/.test(shown) ? ` (${c.masked})` : '';
  return `${shown}${withNumber}`;
}

function choose(items: readonly string[]): string {
  return items.length === 2 ? `${items[0]} or ${items[1]}` : `${items.slice(0, -1).join('; ')}; or ${items[items.length - 1]}`;
}

const NO_CHAT = (row: RecipientRow): boolean => row.label.trim() === '' || looksLikeControl(row.label);

// ------------------------------------------------------------------------------------------------------------------------ numbers
function judgeNumber<T extends RecipientRow>(phone: PhoneReading, row: T, opts: ResolveOptions): RecipientCandidate<T> | null {
  const country = opts.country ?? DEFAULT_COUNTRY;
  const shown = shownNumberOf(row, country);
  const masked = shown === null ? null : maskNumber(shown);
  const make = (evidence: EvidenceKind, confidence: Confidence, why: string): RecipientCandidate<T> => ({ row, evidence, shownNumber: shown, masked, confidence, why });

  if (phone.kind === 'international' || phone.kind === 'national' || phone.kind === 'unclear') {
    const whole = phone.e164 ?? phone.digits;
    const national = phone.national ?? phone.digits;
    if (shown !== null) {
      if (shown === whole) return make('exact_number', 'high', 'the chat is listed under exactly this number');
      // The same digits under another country code, when the person did NOT say a code (it was read from the configured country): not proven to be this
      // person, so it is asked about. A number said WITH its country code is that country's number: another code is another number.
      if (phone.countryAssumed && shown.length > national.length && shown.endsWith(national)) return make('number_other_country', 'medium', 'the same digits, but with a different country code');
      if (shown === national || shown.replace(/^0+/, '') === national) return make('exact_number', phone.countryAssumed ? 'medium' : 'high', 'the chat is listed under this number without its country code');
      return null; // it shows a number, and it is not this one
    }
    if (opts.searched === true && row.fromSearch !== false) {
      // The app's own search, typed with the whole number, found this person; the row does not show the number, so the match is the app's.
      // A number read against the configured country (no code said) that is a landline is doubtful for a chat app: it is asked about.
      const doubtful = phone.countryAssumed && phone.lineType !== undefined && phone.lineType !== 'MOBILE' && phone.lineType !== 'FIXED_LINE_OR_MOBILE';
      if (phone.kind === 'unclear') return make('app_search_whole_number', 'medium', 'the app found this chat for these digits, but they are not a valid number, so it is not certain');
      return make('app_search_whole_number', doubtful ? 'medium' : 'high', doubtful ? 'the app found this chat for this landline-style number' : "the app's own search found this chat for this whole number");
    }
    return null;
  }

  // part of a number
  const want = phone.digits;
  if (shown !== null) {
    const nationalOf = (n: string): string[] => [n, n.slice(1), n.slice(2), n.slice(3)];
    const ends = shown.endsWith(want);
    const starts = nationalOf(shown).some((n) => n.startsWith(want));
    const inside = shown.includes(want);
    const mode = phone.mode;
    if ((mode === 'ends' || mode === 'any') && ends) return make('number_suffix', want.length >= 6 ? 'high' : 'medium', `the number shown ends in ${want.length} digits that match`);
    if ((mode === 'starts' || mode === 'any') && starts) return make('number_prefix', want.length >= 6 ? 'medium' : 'low', 'the number shown starts with these digits');
    if (mode === 'any' && inside && want.length >= 4) return make('number_inside', 'low', 'the digits are inside the number shown');
    return null;
  }
  if (opts.searched === true && row.fromSearch !== false && want.length >= 3) {
    // The app's search matched the digits somewhere in the number; the row does not say where, so this is never an identity.
    return make('app_search_part_of_number', want.length >= 6 ? 'medium' : 'low', 'the app found this chat for part of the number');
  }
  return null;
}

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1, none: 0 };

function resolveByNumber<T extends RecipientRow>(reference: RecipientReference, rows: readonly T[], opts: ResolveOptions): RecipientResolution<T> {
  const phone = reference.phone as PhoneReading;
  if (phone.kind === 'unclear' && phone.digits.length > 15) {
    return result(reference, { status: 'unreadable', confidence: 'none', candidates: [], chosen: null, reason: 'more digits than a phone number has', question: 'That has more digits than a phone number. Could you say the number again?' });
  }
  const candidates: Array<RecipientCandidate<T>> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (NO_CHAT(row)) continue;
    const key = `${normalizeText(row.label)}|${shownNumberOf(row, opts.country) ?? ''}`;
    if (seen.has(key)) continue; // the same chat shown twice (a search result and the list) is one chat
    const judged = judgeNumber(phone, row, opts);
    if (judged !== null) {
      seen.add(key);
      candidates.push(judged);
    }
  }
  candidates.sort((a, b) => RANK[b.confidence] - RANK[a.confidence]);

  if (candidates.length === 0) {
    if (phone.kind === 'unclear') {
      return result(reference, {
        status: 'unreadable',
        confidence: 'none',
        candidates,
        chosen: null,
        reason: `those digits are not a valid number${phone.notes.length > 0 ? ` (${phone.notes.join('; ')})` : ''}, and no chat shows them`,
        question: "I couldn't read that as a phone number, and I don't see a chat with those digits. Could you say the number again, or tell me the name?",
      });
    }
    return result(reference, { status: 'not_found', confidence: 'none', candidates, chosen: null, reason: phone.kind === 'partial' ? 'no chat has those digits' : 'no chat has this number' });
  }

  // One chat is exactly this whole number: that is the one, whatever else the app's search also listed.
  const exact = candidates.filter((c) => c.evidence === 'exact_number' && c.confidence === 'high');
  if (exact.length === 1) return result(reference, { status: 'resolved', confidence: 'high', candidates, chosen: exact[0] as RecipientCandidate<T>, reason: (exact[0] as RecipientCandidate<T>).why });
  if (exact.length > 1) return ambiguous(reference, candidates, 'more than one chat is listed under this number');

  const top = candidates[0] as RecipientCandidate<T>;
  if (candidates.length === 1) {
    const status = top.confidence === 'high' ? 'resolved' : 'confirm';
    return result(reference, {
      status,
      confidence: top.confidence,
      candidates,
      chosen: top,
      reason: top.why,
      question: status === 'confirm' ? `I found ${describeCandidate(top)} (${top.why}). Is that the one?` : null,
    });
  }
  // Several fit. A single one the whole number is the app's own match for, with the others clearly weaker, would still be a guess among people: ask.
  return ambiguous(reference, candidates, `${candidates.length} chats fit these digits`);
}

function ambiguous<T extends RecipientRow>(reference: RecipientReference, candidates: ReadonlyArray<RecipientCandidate<T>>, reason: string): RecipientResolution<T> {
  const shown = candidates.slice(0, 6).map(describeCandidate);
  return result(reference, { status: 'ambiguous', confidence: 'none', candidates, chosen: null, reason, question: `Which one: ${choose(shown)}?` });
}

// ------------------------------------------------------------------------------------------------------------------------ names
function resolveByName<T extends RecipientRow & ChatCandidate>(reference: RecipientReference, rows: readonly T[], opts: ResolveOptions): RecipientResolution<T> {
  const recent = (opts.recents ?? []).map((r) => r.label);
  const usable = rows.filter((r) => !NO_CHAT(r));
  const found = resolveChat(reference.raw, usable, { recent });
  const asCandidate = (m: { candidate: T; evidence: string; verified: boolean; strength: string }, viaRecent: boolean): RecipientCandidate<T> => {
    const shown = shownNumberOf(m.candidate, opts.country);
    const evidence: EvidenceKind = viaRecent ? 'used_earlier' : m.evidence === 'exact name' ? 'exact_name' : m.strength === 'fuzzy' ? 'close_spelling' : 'name_match';
    const confidence: Confidence = viaRecent ? 'medium' : m.verified ? 'high' : m.strength === 'fuzzy' ? 'low' : 'medium';
    return { row: m.candidate, evidence, shownNumber: shown, masked: shown === null ? null : maskNumber(shown), confidence, why: viaRecent ? 'used earlier in this conversation' : m.evidence };
  };
  if (found.kind === 'none') return result(reference, { status: 'not_found', confidence: 'none', candidates: [], chosen: null, reason: 'no chat has that name' });
  if (found.kind === 'unique') {
    const c = asCandidate(found.match, found.viaRecent === true);
    return result(reference, {
      status: c.confidence === 'high' ? 'resolved' : 'confirm',
      confidence: c.confidence,
      candidates: [c],
      chosen: c,
      reason: c.why,
      question: c.confidence === 'high' ? null : `I found ${describeCandidate(c)} (${c.why}), not an exact name. Is that the one?`,
    });
  }
  return ambiguous(reference, found.matches.map((m) => asCandidate(m, false)), `${found.matches.length} chats fit that name`);
}

// ------------------------------------------------------------------------------------------------------------------------ the conversation
/**
 * "him", "the last person I messaged", "the same person I messaged yesterday": settled from who was messaged and when. A reference like this is never an identity
 * by itself, so a person it settles on is `confirm` (said back, and a yes asked for) — and several people it could mean are asked about, never chosen between.
 */
export function resolveByContext(reference: RecipientReference, opts: ResolveOptions = {}): RecipientResolution<RecipientRow> {
  const ref = reference.context as ContextReference;
  const now = opts.now ?? Date.now();
  const all = [...(opts.recents ?? [])].filter((r) => !NO_CHAT(r)).sort((a, b) => b.at - a.at);
  // (one chat is one person however many times it appears)
  const distinct = (list: readonly RecentRecipient[]): RecentRecipient[] => {
    const seen = new Set<string>();
    return list.filter((r) => {
      const k = normalizeText(r.label);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const candidateOf = (r: RecentRecipient, why: string): RecipientCandidate => ({
    row: { label: r.label },
    evidence: r.session === true ? 'recent_conversation' : 'recent_history',
    shownNumber: null,
    masked: null,
    confidence: 'medium',
    why,
  });
  const settle = (list: readonly RecentRecipient[], what: string, none: string): RecipientResolution => {
    const people = distinct(list);
    if (people.length === 0) return result(reference, { status: 'not_found', confidence: 'none', candidates: [], chosen: null, reason: none });
    const candidates = people.map((p) => candidateOf(p, what));
    if (people.length === 1) {
      const only = candidates[0] as RecipientCandidate;
      return result(reference, { status: 'confirm', confidence: 'medium', candidates, chosen: only, reason: what, question: `By "${ref.phrase}" do you mean ${only.row.label}?` });
    }
    return result(reference, { status: 'ambiguous', confidence: 'none', candidates, chosen: null, reason: `${people.length} people fit "${ref.phrase}"`, question: `Which one: ${choose(candidates.slice(0, 6).map((c) => c.row.label))}?` });
  };

  switch (ref.kind) {
    case 'pronoun':
      // a pronoun is only clear when the conversation has been about one person (the last half hour)
      return settle(all.filter((r) => now - r.at <= SAME_CONVERSATION_MS), 'the chat in this conversation', 'nobody has been messaged in this conversation');
    case 'last': {
      const latest = all[0];
      return latest === undefined
        ? result(reference, { status: 'not_found', confidence: 'none', candidates: [], chosen: null, reason: 'no earlier chat is known' })
        : settle([latest], 'the chat used last', 'no earlier chat is known');
    }
    case 'recent':
      return settle(all.filter((r) => now - r.at <= 12 * HOUR), 'a chat used a little while ago', 'no chat was used recently');
    case 'yesterday': {
      const start = dayStart(now - 24 * HOUR);
      const end = dayStart(now);
      return settle(all.filter((r) => r.at >= start && r.at < end), 'a chat used yesterday', 'no chat is known to have been used yesterday');
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------------ the entry point
/**
 * The decision: who the recipient is, from what was said and the rows on offer. `rows` are what the app shows for it (its chat list, or its search results for the
 * digits): rows that are not chats (menus, buttons) must already be left out by the caller, and are left out here too when they are plainly controls.
 */
export function resolveRecipient<T extends RecipientRow & ChatCandidate>(spoken: string | RecipientReference, rows: readonly T[], opts: ResolveOptions = {}): RecipientResolution<T> {
  const reference = typeof spoken === 'string' ? readRecipientReference(spoken, opts.country) : spoken;
  switch (reference.kind) {
    case 'full_number':
    case 'partial_number':
    case 'unclear_number':
      return resolveByNumber(reference, rows, opts);
    case 'context':
      return resolveByContext(reference, opts) as unknown as RecipientResolution<T>;
    case 'name':
      return resolveByName(reference, rows, opts);
  }
}
