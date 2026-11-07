import { parseLocalIntent } from '@main/local/localIntents';

/**
 * Agent mode and plain chat. With Agent switched off (the button beside the message box) Eya only talks: she answers questions and chats, can look
 * a fact up on the web and read a file that was attached, and does nothing on the computer or in a browser. Nothing said in chat becomes a task or
 * opens the panel on the right. With Agent on, the request is carried out with the browser and the other tools.
 */

/** The tools plain chat may use: a fact looked up on the web (no page is opened or driven) and a file the person attached. */
export const CHAT_TOOLS: ReadonlySet<string> = new Set(['web_search', 'analyze_document']);

/** Something to DO on the computer or the web, said so plainly that no thinking is needed to tell it from a question. */
const COMMAND_START =
  /^(?:(?:hey )?eya[, ]+)?(?:(?:please|can you|could you|will you|would you|kindly)\s+)*(?:open|launch|close|quit|play|download|visit|go to|browse|book|order|buy|click|log ?in|sign ?in|take a screenshot|screenshot|lock (?:the |my )?(?:screen|pc|computer|laptop)|shut ?down|restart|reboot|mute|unmute|create (?:a |the )?(?:new )?(?:folder|file|document)|delete|rename|move|copy|zip|compress|send (?:a |the |my |this |that |it |him |her |them )|message \w+)/i;

/** Whether a request is an everyday command that Agent mode is for (so chat can say so at once instead of guessing at an answer). */
export function wantsAgent(text: string): boolean {
  const t = text.trim();
  if (t === '') return false;
  if (COMMAND_START.test(t)) return true;
  const intent = parseLocalIntent(t);
  if (intent === null) return false;
  // ("find <something>" is as often a question as a file search: only the clear commands count)
  return intent.kind !== 'file' || intent.action === 'open';
}

/** What chat says to a request that needs Agent mode. */
export const AGENT_HINT = 'That is a job for Agent mode, since I would use your browser or PC. Switch Agent on beside the message box, or press the button below.';

/** Whether an answer from the AI is itself pointing the person to Agent mode (so the screen can offer the button). */
export function pointsToAgent(answer: string): boolean {
  return /\bagent\b/i.test(answer) && /\b(turn|switch|toggle|enable|press|click|use)\b/i.test(answer);
}

/** The instruction for plain chat. */
export function chatSystemPrompt(now: Date): string {
  const today = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return [
    'You are Eya, a warm and capable assistant, in plain chat mode.',
    '- Chat naturally and answer questions directly and briefly, in the language the person uses. No markdown lists, no headings, no emoji.',
    '- For a factual question that needs fresh or exact information (news, prices, scores, dates, who is who) use web_search, then answer from what it found. For a file the person attached, read it with analyze_document before saying anything about it.',
    '- In this mode you do NOT control the computer or a browser. If the person asks you to do something on their PC or on a website (open a site or an app, play a film or song, find or open files, send a message, fill in a form, download, click, book or buy), do not pretend and do not refuse for any other reason: say in one short, friendly sentence that this is what Agent mode is for and that they can switch it on with the Agent button beside the message box.',
    '- A greeting or small talk is answered like a person would: briefly and warmly, nothing more.',
    `Now: ${today}.`,
  ].join('\n');
}

/**
 * What the person wanted from a site, said after its name ("Open MovieRulz site and play Telugu HD Paradise movie" → "Telugu HD Paradise movie"),
 * without the site and the words around it. Empty when nothing is asked for after the site (or it is not a film, song or program to watch or get),
 * so the site's own name never goes into a search for it.
 */
export function wantedAfterSite(text: string, siteName: string): string {
  const escaped = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  if (escaped === '') return '';
  const at = new RegExp(escaped, 'i').exec(text);
  if (at === null) return '';
  const after = text
    .slice(at.index + at[0].length)
    .replace(/^\.[a-z]{2,6}\b/i, '')
    .replace(/^\s*(?:site|web\s*site|page|app)?\b\s*[,.]?\s*(?:and|then|&)?\s*(?:please\s+)?/i, '');
  const verb = /^(?:play|watch|stream|download|find|get|show(?:\s+me)?)\b\s*(?:me\s+)?/i.exec(after);
  if (verb === null) return '';
  return after.slice(verb[0].length).replace(/[\s.!?]+$/, '').trim();
}

/** The result of looking for a site that gives films, songs or programs away without permission, which is not opened or searched for by name. */
export function isBlockedSiteResult(result: { readonly ok: boolean; readonly data?: Readonly<Record<string, unknown>> }): boolean {
  if (result.ok) return false;
  const navigation = result.data?.['navigation'];
  return typeof navigation === 'object' && navigation !== null && (navigation as { readonly problem?: unknown }).problem === 'blocked_site';
}
