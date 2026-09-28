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
export function normalizeCommand(raw: string): string {
  let text = raw
    .toLowerCase()
    .replace(/[.,!?;:"]+/g, ' ')
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

/**
 * Local fast-path intent router. Returns undefined for anything ambiguous so
 * the AgentEngine can fall through to the language model.
 *
 * Matches are conservative: we only claim a match when we recognize both the
 * verb and a concrete object (application, folder, file).
 */
export class IntentRouter {
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
    if (app === undefined) return undefined;
    return { tool, args: { name: app.canonical }, confidence, canonicalName: app.canonical };
  }
}
