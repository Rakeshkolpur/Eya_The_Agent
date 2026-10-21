import { rootLogger } from '@main/logging/logger';
import type { AIChatMessage, AICompletion } from '@main/providers/ai/AIProvider';
import type { RawFinding } from './types';

const log = rootLogger.child('writing');

/**
 * The optional deeper check: ONE paragraph, sent to Gemini, only while the user has allowed it for this session. It is asked for real
 * mistakes only (a wrong word, a missing word, broken grammar, an unclear reference) — not for a different style — and what it says is
 * trusted no further than it can be checked: a suggestion has to quote words that really are in the paragraph.
 */

const SYSTEM = [
  'You are a careful proofreader for legal drafting: English petitions, affidavits and applications for Indian courts.',
  'You are given ONE paragraph. Report only real mistakes: grammar, a wrong or missing word, wrong tense or number agreement, an unclear',
  'reference, a drafting slip. Do NOT suggest a different style, shorter wording or anything that is only a preference. Do not report',
  "names, case numbers, dates or amounts as wrong: you cannot know them. If the paragraph is fine, report nothing.",
  'Reply with JSON only, no other text: {"issues":[{"quote":"the exact words from the paragraph","problem":"what is wrong, in a short plain sentence","fix":"what those exact words should be instead, or an empty string if you are not sure"}]}',
  'At most three issues. "quote" must be copied exactly from the paragraph.',
].join(' ');

interface Asker {
  complete(messages: readonly AIChatMessage[], tools: readonly never[]): Promise<AICompletion>;
}

/** What the model said, as findings — keeping only what can be checked against the paragraph. */
export function parseCloudAnswer(text: string, paragraph: string): RawFinding[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  const issues = (parsed as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  const out: RawFinding[] = [];
  for (const raw of issues.slice(0, 3)) {
    const issue = raw as { quote?: unknown; problem?: unknown; fix?: unknown };
    if (typeof issue.quote !== 'string' || typeof issue.problem !== 'string') continue;
    const quote = issue.quote.trim();
    const problem = issue.problem.trim();
    // A made-up quotation, or one too short or too long to be a real slip, is thrown away.
    if (quote.length < 3 || quote.length > 200 || problem === '' || !paragraph.includes(quote)) continue;
    const fix = typeof issue.fix === 'string' ? issue.fix.trim() : '';
    out.push({
      kind: 'ai',
      message: problem.length > 220 ? `${problem.slice(0, 217)}…` : problem,
      excerpt: quote,
      ...(fix !== '' && fix !== quote && fix.length <= 400 ? { replace: { from: quote, to: fix } } : {}),
    });
  }
  return out;
}

export function createCloudCheck(ai: Asker): { check(paragraph: string): Promise<RawFinding[]> } {
  return {
    async check(paragraph) {
      const started = Date.now();
      const answer = await ai.complete([{ role: 'system', content: SYSTEM }, { role: 'user', content: paragraph }], []);
      const findings = parseCloudAnswer(answer.text, paragraph);
      // Never the words themselves: only how long it took and how many things it said.
      log.info('cloud check', { ms: Date.now() - started, issues: findings.length });
      return findings;
    },
  };
}
