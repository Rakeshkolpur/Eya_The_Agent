import type { LiveChatView } from '../shared/liveChat';

/**
 * TOGETHER (see LiveChatView.together): the person sits with Eya in a live chat, like two friends over one phone. While it lasts Eya's microphone stays on — she is not "quiet" however
 * long the person says nothing, because the other person may write at any moment and the person is there to answer — and what comes in is said to them at once, in a natural voice.
 * Pure: what the page asks, and the words the live voice model is given.
 */

/** Whether the person is with Eya in a live chat that is going now: the microphone is kept on for as long as this is true. A paused or ended chat lets it go. */
export function togetherListening(view: LiveChatView | null): boolean {
  return view !== null && view.active && view.together === true && view.state !== 'PAUSED';
}

/**
 * Whether a conversation with Eya is kept open however quiet the person is: while tasks are open, while she is working for them, and — new — while they sit with her in a live chat. This is the
 * one rule both ways of talking (Gemini Live and the hands-free one) ask, so the microphone is never let go in the middle of a chat that is going.
 */
export function keepTalkOpen(state: { readonly tasksOpen: number; readonly agentWorking: boolean; readonly together: boolean }): boolean {
  return state.tasksOpen > 0 || state.agentWorking || state.together;
}

/** What the live voice model is told once, when together begins: how to be, and that the person's own words are carried out as they said them. */
export const TOGETHER_RULES =
  "[Eya's note] TOGETHER MODE is on. The user is sitting right beside you and the two of you are chatting with one person on the same phone, like two friends. Be a real, warm third person, " +
  'not a machine: react to what comes in with one short natural line, give a quick honest opinion when asked, keep it brief and never lecture. When a line that starts with [Eya\'s note] tells you what ' +
  'the other person wrote, say it to the user right away in your own words. Whenever the user tells you what to send or type, or what to do with a reply — "send this …", "type this …", ' +
  '"no, send this …", "send it", "don\'t send it", "change it to …", "wait", "go ahead", "what did she say" — call quick_command at once with exactly what they said, and then say in a few ' +
  'words what happened ("okay, sending that", "okay, holding it"). Never put words in their mouth, and never send or type anything they did not tell you to. If they say "together mode off", it is over.';

/** One thing that came in, or that Eya would reply, as the live voice model is told it: say it now, like a friend glancing at the phone, then listen. */
export function togetherNote(text: string): string {
  return `[Eya's note] (together) Tell the user this right now, in a few natural words, like a friend glancing at the phone: "${text}" Then listen: if they tell you what to send or type, call quick_command with exactly what they say. Do not decide anything for them.`;
}
