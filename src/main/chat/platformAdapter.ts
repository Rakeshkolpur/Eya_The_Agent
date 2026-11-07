/**
 * What is particular to one chat app, in one place. The agent's steps (find the chat, open it, put the message or file in, press Send, check it went)
 * are the same for every app and live in `chatTools.ts` and `ChatCommands.ts`; what differs from app to app — where the app is, what its search box
 * and message box are called, what its login screen says, what it can and cannot do — is an adapter. A new app is a new entry here (plus its host in
 * the Communication Access list), not a new set of conditions through the agent. An app that has no adapter is not worked in: the caller says so.
 *
 * Only WhatsApp Web and Telegram Web are described, because only those have been built and tested (against mock pages). Instagram, Messenger and the
 * rest are known to Communication Access (so the privacy switch covers them) but have no adapter yet, and they are not assumed to work like these two.
 */

export type ChatAppId = 'whatsapp' | 'telegram';

export interface ChatPlatformAdapter {
  readonly id: ChatAppId;
  readonly name: string;
  /** The page that is the app. */
  readonly url: string;
  /** What the app's own search box is labelled (a name is typed there, once, and the list narrows). */
  readonly searchField: RegExp;
  /** What the message box is labelled, tried in order. */
  readonly composerLabels: readonly string[];
  /** The visible name of the control that sends. */
  readonly sendLabel: string;
  /** The visible name of the control that opens the attach menu. */
  readonly attachLabel: string;
  /**
   * What the open chat's message box is called, as patterns (first match wins). A group in a pattern is WHO THE CHAT IS WITH ("Type a message to Anna"):
   * the page itself says which conversation is open, which is the best proof that the right one is. Absent when the app's box says nothing reliable.
   */
  readonly composerInput?: readonly RegExp[];
  /**
   * The app's own "pick who to send this to" step, which opens by itself when a file is given to the page with no chat open (WhatsApp Web's
   * "Select chats": a search box, a tick box per person, and a Send button that appears once someone is ticked). Sending a file through it needs no
   * chat to be opened first. Absent when the app has no such step.
   */
  readonly shareDialog?: {
    /** The step's heading. */
    readonly title: RegExp;
    /** Its search box (a name, a number or a username is typed there). */
    readonly searchLabel: string;
    readonly sendLabel: string;
    readonly closeLabel: string;
  };
  /**
   * The app's own list of every file in every chat (WhatsApp Web's "Media" in the left rail, then its "Docs" tab), which can be searched and which shows who
   * sent each file and when — but not which chat it is in; for that the chat is opened at the file's message ("Go to message", which sends nothing). Absent
   * when the app has no such list, or it has not been looked at.
   */
  readonly fileSearch?: {
    /** The button that opens the list. */
    readonly openLabel: string;
    /** The tab of it that holds documents. */
    readonly docsTab: string;
    /** The list's own search box (named only while the list is open: it is how the list is known to be open). */
    readonly searchLabel: RegExp;
    /** The button that closes the list. */
    readonly closeLabel: string;
    /** The button each file's row has, which opens its menu. */
    readonly menuLabel: string;
    /** The menu's entry that opens the chat at the file's message. */
    readonly gotoLabel: string;
  };
  /** Words on the page that mean the app is asking the person to log in. */
  readonly loginSignals: RegExp;
  /** What this adapter can do. A caller does not try what is false here. */
  readonly capabilities: {
    readonly sendText: boolean;
    readonly sendFile: boolean;
    /** How a new incoming message can be noticed without reading the page: the tab title's unread count, or not at all. */
    readonly incoming: 'tab_title_unread' | 'none';
  };
}

/** What a search box is called in most chat apps (the fallback for a page no adapter describes). */
export const GENERIC_SEARCH_FIELD = /search|find|new chat|start (?:a )?(?:new )?chat|recipient|to:/i;
/** What a login screen says in most chat apps. */
export const GENERIC_LOGIN_SIGNALS = /scan (?:the |this )?qr|log ?in to (?:whatsapp|telegram)|link with phone number|use whatsapp on your phone/i;

export const ADAPTERS: Readonly<Record<ChatAppId, ChatPlatformAdapter>> = {
  whatsapp: {
    id: 'whatsapp',
    name: 'WhatsApp',
    url: 'https://web.whatsapp.com/',
    // (WhatsApp Web's search box has the label "Search or start a new chat" only while it is empty: with something typed in it, the page leaves that
    // label off and the box is known only by the page's own generated id, such as "_r_a_")
    searchField: /search|find|new chat|start (?:a )?(?:new )?chat|recipient|to:|^_r_[a-z0-9]+_$/i,
    composerLabels: ['Type a message', 'Message', 'Write a message'],
    composerInput: [/^type a message to (.+)$/i, /^type to (.+)$/i, /^type a message$/i],
    shareDialog: { title: /^select chats\b/i, searchLabel: 'Search name, number or @username', sendLabel: 'Send', closeLabel: 'Close' },
    // (as found on the real WhatsApp Web, read-only, 27 Oct 2026)
    fileSearch: { openLabel: 'Media', docsTab: 'Docs', searchLabel: /^search by sender, caption or filename/i, closeLabel: 'Close', menuLabel: "Message's context menu", gotoLabel: 'Go to message' },
    sendLabel: 'Send',
    attachLabel: 'Attach',
    loginSignals: /scan (?:the |this )?qr|log ?in to whatsapp|link with phone number|use whatsapp on your phone/i,
    capabilities: { sendText: true, sendFile: true, incoming: 'tab_title_unread' },
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    url: 'https://web.telegram.org/a/',
    searchField: GENERIC_SEARCH_FIELD,
    composerLabels: ['Type a message', 'Message', 'Write a message'],
    sendLabel: 'Send',
    attachLabel: 'Attach',
    loginSignals: /scan (?:the |this )?qr|log ?in to telegram|log in by phone number|sign in to telegram/i,
    capabilities: { sendText: true, sendFile: true, incoming: 'tab_title_unread' },
  },
};

/** What the page's text fields say about a message box: whether there is one, and who the chat is with when it says. Null for an app whose box is not known. */
export interface ComposerReading {
  readonly present: boolean;
  /** Who the open chat is with, as the box itself says ("Type a message to Anna" → "Anna"); null when the box does not say. */
  readonly target: string | null;
}

export function readComposer(adapter: ChatPlatformAdapter | undefined, inputs: readonly string[]): ComposerReading | null {
  const patterns = adapter?.composerInput;
  if (patterns === undefined) return null;
  for (const name of inputs) {
    for (const pattern of patterns) {
      const m = pattern.exec(name.trim());
      if (m !== null) return { present: true, target: typeof m[1] === 'string' && m[1].trim() !== '' ? m[1].trim() : null };
    }
  }
  return { present: false, target: null };
}

/** Is this the app's own "who to send it to" step (see ChatPlatformAdapter.shareDialog)? Looked for in the page's headings and popups. */
export function shareDialogOpen(adapter: ChatPlatformAdapter | undefined, page: { readonly headings: readonly string[]; readonly dialogs: readonly string[] }): boolean {
  const share = adapter?.shareDialog;
  if (share === undefined) return false;
  const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim();
  return page.headings.some((h) => share.title.test(h.trim())) || page.dialogs.some((d) => share.title.test(firstLine(d)));
}

/** The adapter for an app id (as Communication Access names it), or undefined when the app has none. */
export function adapterFor(id: string | null | undefined): ChatPlatformAdapter | undefined {
  return id === 'whatsapp' || id === 'telegram' ? ADAPTERS[id] : undefined;
}
