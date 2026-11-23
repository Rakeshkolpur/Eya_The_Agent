import { EYA_NAME_PATTERN } from '@shared/wake';
import { resolveApp } from '@main/tools/impl/openApplication';
import type { ToolArgs } from '@main/tools/types';

export interface IntentMatch {
  readonly tool: string;
  readonly args: ToolArgs;
  readonly confidence: number;
  readonly canonicalName: string;
}

const OPEN_VERB = /^(?:open up|fire up|bring up|open|launch|start up|start|run)\s+/;
const CLOSE_VERB = /^(?:close|quit|exit)\s+/;

const LEADING_FILLER: readonly RegExp[] = [
  new RegExp(`^(?:hey|hi|hello|ok|okay)\\s+${EYA_NAME_PATTERN}\\s+`),
  new RegExp(`^${EYA_NAME_PATTERN}\\s+`),
  /^(?:please|kindly|just)\s+/,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/,
  /^go\s+ahead\s+and\s+/,
];
const TRAILING_FILLER: readonly RegExp[] = [
  /\s+(?:please|for me|now|right now|quickly|thanks|thank you)$/,
  /\s+(?:app|application|program|window)$/,
];
const LEADING_ARTICLE = /^(?:the|my|a|an)\s+/;

/**
 * Speech comes in as "Hey Eya, could you please open the Notepad app for me?".
 * Reduce it to the bare command so simple requests stay on the instant local
 * path instead of costing a round trip to the language model.
 */
export function normalizeCommand(raw: string, options: { readonly keepDots?: boolean } = {}): string {
  // keepDots leaves a dot inside a word alone ("github.com", "report.pdf"); a full stop at the end of a word is still punctuation.
  const punctuation = options.keepDots === true ? /(?:\.(?=\s|$)|[,!?;:"])+/g : /[.,!?;:"]+/g;
  let text = raw
    .toLowerCase()
    .replace(punctuation, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 6; i += 1) {
    const before = text;
    for (const re of LEADING_FILLER) text = text.replace(re, '');
    for (const re of TRAILING_FILLER) text = text.replace(re, '');
    if (text === before) break;
  }
  return text.trim();
}

const LEADING_FILLER_ANY_CASE: readonly RegExp[] = LEADING_FILLER.map((re) => new RegExp(re.source, 'i'));

/**
 * Drops the polite lead-in ("Hey Eya, could you please ...") from a request WITHOUT changing the rest of it: unlike
 * normalizeCommand this keeps capital letters and punctuation, which matters when the rest is a message to be sent word for word.
 */
export function stripPoliteness(raw: string): string {
  // Punctuation turned into spaces of the same length, so a position in this copy is the same position in the original.
  const aligned = raw.replace(/[.,!?;:"]/g, ' ');
  let at = 0;
  for (let i = 0; i < 6; i += 1) {
    at += aligned.length - at - aligned.slice(at).trimStart().length;
    let moved = false;
    for (const re of LEADING_FILLER_ANY_CASE) {
      const m = re.exec(aligned.slice(at));
      if (m !== null && m[0].length > 0) {
        at += m[0].length;
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return raw.slice(at).trim();
}

/**
 * Local fast-path intent router. Returns undefined for anything ambiguous so
 * the AgentEngine can fall through to the language model.
 *
 * Matches are conservative: we only claim a match when we recognize both the
 * verb and a concrete object (application, folder, file).
 */
export class IntentRouter {
  /**
   * `installed` is the remembered list of the apps on this PC (see AppCatalog): with it, "open Spotify" or "open Word" goes straight
   * to the app instead of through the model. It only ever answers for an exact name, and only for opening: closing stays limited to
   * the apps listed above.
   */
  constructor(private readonly installed?: { lookup(spoken: string): string | null }) {}

  match(rawText: string): IntentMatch | undefined {
    const text = normalizeCommand(rawText);
    if (text.length === 0) return undefined;
    return this.matchApp(text, OPEN_VERB, 'open_application', 0.95)
      ?? this.matchApp(text, CLOSE_VERB, 'close_application', 0.9);
  }

  private matchApp(
    text: string,
    verb: RegExp,
    tool: string,
    confidence: number,
  ): IntentMatch | undefined {
    if (!verb.test(text)) return undefined;
    let remainder = text.replace(verb, '').trim();
    for (let i = 0; i < 3; i += 1) {
      const before = remainder;
      remainder = remainder.replace(LEADING_ARTICLE, '');
      for (const re of TRAILING_FILLER) remainder = remainder.replace(re, '');
      remainder = remainder.trim();
      if (remainder === before) break;
    }
    if (remainder.length === 0) return undefined;
    const app = resolveApp(remainder);
    if (app !== undefined) return { tool, args: { name: app.canonical }, confidence, canonicalName: app.canonical };
    if (tool === 'open_application') {
      const installed = this.installed?.lookup(remainder) ?? null;
      if (installed !== null) return { tool, args: { name: installed }, confidence, canonicalName: installed };
    }
    return undefined;
  }
}
