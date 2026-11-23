import { createHash } from 'node:crypto';
import { inventedFacts } from '@main/livechat/messages';

/**
 * What may be published in the person's name, and the checks every text passes before it is shown to them and again before it goes out. The person is an advocate: a public post must not
 * carry a client's matter (a case number, a phone number, an e-mail) and must not promise a result (the Bar Council's rules on advertising and soliciting). Those are ERRORS: nothing
 * with one goes out, whatever anyone says. A figure, date or link that is not in what the person told Eya is a WARNING: it is shown to them next to the text, so they can check it.
 */
export type SocialKind = 'post' | 'comment' | 'reply';

export const KIND_WORDS: Readonly<Record<SocialKind, string>> = {
  post: 'post',
  comment: 'comment on someone else\'s post',
  reply: 'reply to a comment on your post',
};

export const LIMITS = {
  post: 3000,
  comment: 1250,
  reply: 1250,
  /** More than this reads as spam; LinkedIn itself suggests three to five. */
  hashtagsAdvised: 5,
  hashtagsMax: 30,
  /** A bigger picture is slow to upload and often refused. */
  imageBytesWarn: 5 * 1024 * 1024,
} as const;

export const IMAGE_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

export interface SocialProblem {
  readonly code: string;
  /** error: nothing goes out until it is fixed. warn: shown to the person, who decides. */
  readonly severity: 'error' | 'warn';
  readonly text: string;
}

export const hasErrors = (problems: readonly SocialProblem[]): boolean => problems.some((p) => p.severity === 'error');

/** The text as it will be compared and counted: line breaks kept (they matter in a post), other white space collapsed, ends trimmed. */
export function tidyPostText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What makes two texts "the same post": the words, ignoring case, spacing and line breaks. */
export function textHash(text: string): string {
  const words = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(words).digest('hex').slice(0, 16);
}

export function hashtagsIn(text: string): string[] {
  return [...new Set((text.match(/(?:^|\s)#[\p{L}\p{N}_]{2,60}/gu) ?? []).map((h) => h.trim().toLowerCase()))];
}

export const preview = (text: string, max = 500): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

// A case, a crime or a petition number: "O.S. No. 123/2020", "W.P.(C) 4567 of 2023", "Crl. M.P. No. 88/2024", "FIR No. 12/2024", "C.C. No. 5".
const CASE_NUMBER = /\b(?:o\.?\s?s|c\.?\s?c|w\.?\s?p|crl|cri|s\.?\s?c|c\.?\s?s|m\.?\s?a|c\.?\s?m\.?\s?p|e\.?\s?p|a\.?\s?s|r\.?\s?c|c\.?\s?r\.?\s?p|fir|cr|crime|case|suit|petition|appeal|complaint)\b[\s.()a-z]{0,12}(?:no\.?|nos\.?|number)\s*[:.]?\s*\d+(?:\s*(?:\/|of)\s*\d{2,4})?/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// Seven or more digits, with the spaces and dashes people put in a phone number.
const PHONE = /(?:\+?\d[\s-]?){7,}\d/;
const GUARANTEE = /\b(?:guarantee[sd]?|assured\s+(?:win|result|success|victory)|sure[-\s]?shot|we\s+will\s+win|will\s+win\s+(?:your|the)\s+case|win\s+(?:your|the)\s+case|no\s+fees?\s+unless|best\s+advocate|number\s+one\s+(?:advocate|lawyer))\b|\b100\s?%/i;
const CLIENT = /\b(?:my|our|a|one)\s+client\b|\bclient\s+(?:mr|mrs|ms|shri|smt|sri)\b\.?/i;

export interface SocialTextInput {
  readonly kind: SocialKind;
  readonly text: string;
  /** What the figures, dates and links in the text may come from: what the person said, their profile facts, the comment being answered. */
  readonly sources?: readonly string[];
  readonly hashtags?: readonly string[];
  readonly imagePath?: string;
  readonly imageBytes?: number;
}

/** Every problem with a text about to be published (an empty list when it is fine to show to the person). */
export function checkSocialText(input: SocialTextInput): SocialProblem[] {
  const problems: SocialProblem[] = [];
  const text = tidyPostText(input.text);
  const add = (code: string, severity: SocialProblem['severity'], message: string): void => void problems.push({ code, severity, text: message });
  if (text === '') {
    add('empty', 'error', 'There is no text.');
    return problems;
  }
  if (text.length > LIMITS[input.kind]) add('too_long', 'error', `It is ${text.length} characters; a ${input.kind === 'post' ? 'LinkedIn post' : 'comment'} takes at most ${LIMITS[input.kind]}.`);
  const tags = [...new Set([...(input.hashtags ?? []).map((h) => `#${h.replace(/^#/, '').toLowerCase()}`), ...hashtagsIn(text)])];
  if (tags.length > LIMITS.hashtagsMax) add('hashtags_max', 'error', `${tags.length} hashtags; LinkedIn allows at most ${LIMITS.hashtagsMax}.`);
  else if (tags.length > LIMITS.hashtagsAdvised) add('hashtags_many', 'warn', `${tags.length} hashtags is a lot; three to five reads better.`);
  if (CASE_NUMBER.test(text)) add('case_number', 'error', 'It contains a case, crime or petition number. A client\'s matter must not be published: take it out.');
  if (EMAIL.test(text)) add('contact_email', 'error', 'It contains an e-mail address. Private contact details must not be published: take it out.');
  if (PHONE.test(text.replace(/\d{4}-\d{2}-\d{2}/g, ''))) add('contact_phone', 'error', 'It contains what looks like a phone number. Private contact details must not be published: take it out.');
  if (GUARANTEE.test(text)) add('guarantee', 'error', 'It promises or advertises a result ("guaranteed", "100%", "we will win"). An advocate may not do that in public: reword it.');
  if (CLIENT.test(text)) add('client', 'warn', 'It mentions a client. Make sure nothing in it can identify them or their matter.');
  const sources = (input.sources ?? []).join('\n');
  if (sources.trim() !== '') {
    const made = inventedFacts(text, sources);
    if (made !== null) add('unsourced', 'warn', `It says "${made}", which is not in what you told me. Check that it is right, or take it out.`);
  }
  if (input.imagePath !== undefined && input.imagePath !== '') {
    const ext = (/\.[^./\\]+$/.exec(input.imagePath)?.[0] ?? '').toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) add('image_type', 'error', `The picture is a ${ext || 'file without a type'}; LinkedIn takes ${IMAGE_EXTENSIONS.join(', ')}.`);
    if (input.imageBytes !== undefined && input.imageBytes > LIMITS.imageBytesWarn) add('image_big', 'warn', 'The picture is over 5 MB; it may upload slowly or be refused.');
  }
  return problems;
}

export const sayProblems = (problems: readonly SocialProblem[]): string => problems.map((p) => `${p.severity === 'error' ? 'Must fix' : 'Check'}: ${p.text}`).join(' ');
