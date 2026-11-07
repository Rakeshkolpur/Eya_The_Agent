import type { LocalCommandResult } from './LocalCommands';

/**
 * The fast everyday commands (messaging by name, sites, folders, files, downloads) for a live voice conversation.
 *
 * In Talk mode the model hears the user and picks tools itself, so the typed-request layers never see what was said. This gives it
 * ONE tool, `quick_command`, that takes nothing from the model: it works on what the user actually said this turn (their own words,
 * as the speech service transcribed them). That matters in two ways: a message is sent word for word as spoken rather than as the
 * model paraphrased it, and a "yes" to "Send it?" can only be the user's — the model cannot make one up by passing it as an argument.
 */

/** What one layer of fast commands offers (ChatCommands and LocalCommands both fit). */
export interface QuickLayer {
  tryHandle(text: string, options?: { readonly live?: boolean }): Promise<LocalCommandResult | null>;
}

export type QuickAnswer = { readonly handled: false } | { readonly handled: true; readonly result: LocalCommandResult };

/** What the live bridge needs: given what the user said (and which of their turns it was), carry it out or say it is not for us. */
export interface QuickRunner {
  run(heard: string, turn?: number): Promise<QuickAnswer>;
}

export class QuickCommands implements QuickRunner {
  /** The last thing done this turn — as the answer to wait for, so that asking again while it is still going waits for it, not redoes it. */
  private last: { readonly turn: number; readonly heard: string; readonly answer: Promise<QuickAnswer> } | null = null;

  constructor(private readonly layers: readonly QuickLayer[]) {}

  async run(heard: string, turn?: number): Promise<QuickAnswer> {
    const said = heard.trim();
    if (said.length < 2) return { handled: false };
    // The model may call the tool again within the same turn: that must not do (or ask) the same thing twice — even while the first is
    // still going (a slow page), when the second call simply waits for the same answer.
    if (turn !== undefined && this.last !== null && this.last.turn === turn && this.last.heard === said) return this.last.answer;
    const answer = this.ask(said);
    if (turn !== undefined) {
      const mine = { turn, heard: said, answer };
      this.last = mine;
      // An answer that failed is not kept: asking again may work.
      answer.catch(() => {
        if (this.last === mine) this.last = null;
      });
    }
    return answer;
  }

  private async ask(said: string): Promise<QuickAnswer> {
    for (const layer of this.layers) {
      // A conversation the user is having with Eya is not always-on room listening: it is what they said to her.
      const result = await layer.tryHandle(said, {});
      if (result !== null) return { handled: true, result };
    }
    return { handled: false };
  }
}

/** The tool as the live model is told about it. */
export const QUICK_COMMAND_TOOL = {
  name: 'quick_command',
  description:
    'USE THIS INSTEAD OF find_file, find_folder, open_file, open_folder, open_url, open_website, find_chat and download_file for everyday requests. ' +
    'Do an everyday request in one step, by what the user just said (it takes nothing from you: it reads their own words). Call it FIRST ' +
    'whenever they ask to message, text or tell someone something, open someone\'s chat, open a website, search a site, open a folder, ' +
    'find or open a file, send a file to someone ("send the latest pdf to Akka", "send it to Uber"), download a link, or to remember or forget their ' +
    'chat names, or to watch their writing or check a document ("watch my writing", "check this document", "fix it", "ignore it"), or a common ' +
    'Microsoft Word action ("add page numbers", "insert a table of contents", "update the index", "page break", "bold this", "centre this", ' +
    '"undo that", "save the document", "go to page 10", "next page", "scroll down", "fill the running index"), or to start, pause, resume or stop a LIVE CHAT in WhatsApp ("do live chat with <name or number>", "live chat now go", "I opened that chat, you can do now", "pause the live chat", "stop live chat", "turn on auto reply" — a live chat is Eya replying in a chat for the user as the messages come in: it is NOT a call and NOT a single message), or, while a live chat is running, to answer the person in it with what the user says ("tell her I will call at 6", "tell him I am busy", "let them know I am coming", "reply: ok done" — pass exactly what the user said, so it is sent in that chat), ' +
    'or what Eya is keeping going in the background ' +
    '("cancel the task", "stop all tasks", "never mind", "what are you working on", "continue"), or teaching and using a reference document ("learn this document ' +
    'as my writ petition", "what have you learned", "format this like my writ petition"). It does the whole job. Returns handled: true with ' +
    'what to say, or handled: false when the request is not one of these (then use your other tools as usual). If what it says is a ' +
    'question for the user (like "Send it?" or "Which one?"), ask it, wait for THEIR answer, then call quick_command again — it reads ' +
    'their answer itself; never answer for them.',
  parameters: { type: 'object' as const, properties: {} },
} as const;
