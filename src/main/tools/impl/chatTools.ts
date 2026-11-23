import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type {
  AttachFileResult,
  BrowserAutomationService,
  BrowserFileAttach,
  BrowserItemClicker,
  BrowserItemLister,
  BrowserKeyPress,
  PageItem,
} from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '@main/browser/errors';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { fileWords, matchDocRows, parseDocRows, readTimeWindow, sayFileFindings } from '@main/chat/chatFiles';
import type { DocRow, FileQuery } from '@main/chat/chatFiles';
import { looksLikeControl, normalizeText, parseChatQuery, phoneEnding, resolveChat, soundsLike } from '@main/chat/contactMatch';
import type { ChatCandidate, ChatMatch } from '@main/chat/contactMatch';
import { countryContext, maskNumber } from '@main/chat/phoneNumbers';
import type { CountryContext, PhoneReading } from '@main/chat/phoneNumbers';
import { maskNumbersIn, readRecipientReference, resolveRecipient } from '@main/chat/recipientResolver';
import type { RecipientCandidate, RecipientReference, RecipientResolution } from '@main/chat/recipientResolver';
import { ADAPTERS, adapterFor, GENERIC_LOGIN_SIGNALS, GENERIC_SEARCH_FIELD, readComposer, shareDialogOpen } from '@main/chat/platformAdapter';
import type { ChatPlatformAdapter } from '@main/chat/platformAdapter';
import type { ChatSession } from '@main/chat/chatSession';
import { permissionRequest } from '@main/permissions/PermissionManager';
import type { CommunicationPolicy } from '@main/privacy/communicationAccess';
import type { KnownFolders } from '@main/security/pathPolicy';
import { checkReadablePath, isExecutablePath } from '@main/security/pathPolicy';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { unavailable } from './browserTools';

/**
 * Working in a chat app the way a person does — find the chat, put the file on it, check, send, check it went — as small
 * general steps over the same browser tools as everywhere else, not one script per app. What is app-specific lives in the
 * page itself (its search box, its attach menu, its Send button); these tools only do the parts the generic ones can't:
 * choosing the right chat locally (so the model is never handed the chat list), putting a file on the page's file picker,
 * saying who it is going to before anything is sent, and checking afterwards that it really went.
 */

const MAX_ATTACH_BYTES = 100 * 1024 * 1024;

// (what an app's search box is called is part of its adapter; this is what is used for a page no adapter describes)
const SEARCH_FIELD = GENERIC_SEARCH_FIELD;
/** A search typed once is not typed again for the same words on the same page within this long: it is read again instead. */
const SEARCH_REUSE_MS = 20_000;
const STATUS_SENT = new Set(['sent', 'delivered', 'read', 'seen']);
const STATUS_PENDING = new Set(['pending', 'sending']);
const STATUS_FAILED = new Set(['failed', 'failed to send', 'not sent', "couldn't send", "couldn't be sent", 'couldnt send', 'undelivered', 'send failed', 'retry', 'tap to retry', 'click to retry']);

const stringArg = (args: ToolArgs, key: string): string | undefined => {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

// ----------------------------------------------------------------------------------------------- what is on the page
function textOf(parts: ReadonlyArray<string | undefined>): string {
  return normalizeText(parts.filter((p): p is string => p !== undefined).join(' '));
}

/**
 * Is this name in the page's title, headings or open dialogs — i.e. in the place a chat's name is shown, not just the list. Never while the app's own
 * "who to send it to" step is open: the names in it are the people to choose from, and say nothing about which chat is open behind it.
 */
function headerMentions(snapshot: PageSnapshot, label: string, confusableWith: readonly string[] = [], adapter?: ChatPlatformAdapter): boolean {
  const want = normalizeText(label);
  if (shareDialogOpen(adapter, snapshot)) return false;
  const text = textOf([snapshot.title, ...snapshot.headings, ...snapshot.dialogs]);
  if (want === '' || !text.includes(want)) return false;
  // "Anna" is in the header of the chat called "Ramesh Anna" too: when the header shows a longer name that contains this one, it is that chat's header.
  return !confusableWith.some((other) => {
    const longer = normalizeText(other);
    return longer !== want && longer.includes(want) && text.includes(longer);
  });
}

/** Who a message box says its chat is with, against the name that was chosen: the whole name, not a part of a longer one ("Anna" is not "Ramesh Anna"). */
function sameTarget(target: string, label: string): boolean {
  const a = normalizeText(target);
  const b = normalizeText(label);
  if (a === b) return true;
  // (a box may cut a long name short with an ellipsis)
  return /…$|\.\.\.$/.test(target.trim()) && a.length >= 3 && b.startsWith(a.replace(/\s*(…|\.\.\.)$/, '').trim());
}

/** What the page's message box names the open chat, as it should be said back (a phone number is shown with all but its last four digits hidden), or null. */
function openedAsLabel(adapter: ChatPlatformAdapter | undefined, page: PageSnapshot): string | null {
  const target = readComposer(adapter, page.inputs)?.target ?? null;
  return target === null ? null : maskNumbersIn(target).slice(0, 80);
}

/** The adapter of the app a chat was opened in (the session holds the app's NAME). */
function adapterByName(name: string | null | undefined): ChatPlatformAdapter | undefined {
  return Object.values(ADAPTERS).find((a) => a.name === name);
}

/**
 * Whether the chat that was chosen is the one open on the page, from what the PAGE shows:
 *   yes     — the message box names this chat ("Type a message to Anna"), or the header shows its name;
 *   wrong   — the message box names a different chat;
 *   no      — this app's message box is known and there is none: no chat is open;
 *   unknown — nothing on the page says (an app whose box and header cannot be read).
 */
type Conversation = 'yes' | 'wrong' | 'no' | 'unknown';
function conversationState(snapshot: PageSnapshot, label: string, confusableWith: readonly string[], adapter: ChatPlatformAdapter | undefined): Conversation {
  const composer = readComposer(adapter, snapshot.inputs);
  if (composer !== null && composer.present && composer.target !== null) return sameTarget(composer.target, label) ? 'yes' : 'wrong';
  if (headerMentions(snapshot, label, confusableWith, adapter)) return 'yes';
  if (composer === null) return 'unknown';
  return composer.present ? 'unknown' : 'no';
}

/** The names of the other chats in the list that contain this chat's name (see headerMentions). */
function confusablesOf(label: string, rows: ReadonlyArray<{ readonly label: string }>): string[] {
  const want = normalizeText(label);
  return [...new Set(rows.map((r) => r.label).filter((l) => normalizeText(l) !== want && normalizeText(l).includes(want)))];
}

/** The end of the phone number shown near a chat's name (its header), or null — never guessed. */
function phoneEndingNear(snapshot: PageSnapshot, label: string): string | null {
  const want = label.toLowerCase();
  for (const source of [...snapshot.headings, snapshot.title, ...snapshot.dialogs, snapshot.visibleText ?? '']) {
    const lower = source.toLowerCase();
    // A number counts only if it sits right after the name (a header's "name, then number"); one further on may be somebody else's.
    for (let at = lower.indexOf(want); at !== -1; at = lower.indexOf(want, at + want.length)) {
      const after = source.slice(at + label.length, at + label.length + 120);
      const number = /\+?\d[\d\s().-]{5,}\d/.exec(after);
      // The number has to follow the name directly (a header's "name, then number") — not after some other text, which may be somebody else's.
      if (number !== null && /^[\s\-–—:·•|,()]*$/.test(after.slice(0, number.index))) {
        const ending = phoneEnding(number[0]);
        if (ending !== null) return ending;
      }
    }
  }
  return null;
}

/** The names in a list, as one comparable string. */
const namesKey = (items: readonly PageItem[]): string => items.map((i) => i.name).join('\u0001');

/**
 * The chat list after a name was typed into the app's search box: read it again and again (each look costs about 10 ms) until it has
 * changed from what it was and then stopped changing, instead of a fixed half-second pause. A search whose results look just like the
 * list before it (one letter, say) is taken as done after about half a second of looking.
 */
async function listWhenSettled(lister: Partial<BrowserItemLister>, sleep: (ms: number) => Promise<void>, before: string): Promise<PageItem[]> {
  const list = async (): Promise<PageItem[]> => (await lister.listItems?.()) ?? [];
  let last = await list();
  let unchanged = 0; // how many looks in a row showed the same list (one is not enough: a list can pass through an empty moment)
  for (let polls = 1; polls < 30; polls += 1) {
    await sleep(100);
    const next = await list();
    unchanged = namesKey(next) === namesKey(last) ? unchanged + 1 : 0;
    last = next;
    if (unchanged >= 2 && (namesKey(next) !== before || polls >= 5)) break;
  }
  return last;
}

/** The look of a chat app's page: ready (a search box to type a name into), asking for a log-in, or not finished loading. */
export function chatAppState(
  snapshot: {
    readonly inputs: readonly string[];
    readonly headings?: readonly string[];
    readonly visibleText?: string;
    readonly buttons?: readonly string[];
    readonly challenge?: { readonly kind: string };
  },
  adapter?: ChatPlatformAdapter,
): 'ready' | 'login' | 'loading' {
  if (snapshot.inputs.some((i) => (adapter?.searchField ?? SEARCH_FIELD).test(i))) return 'ready';
  // (an open chat's message box: the app is there and working, whatever its search box is called at the moment)
  if (readComposer(adapter, snapshot.inputs)?.present === true) return 'ready';
  const words = [snapshot.visibleText ?? '', ...(snapshot.headings ?? []), ...(snapshot.buttons ?? [])].join(' ');
  if (snapshot.challenge?.kind === 'login' || (adapter?.loginSignals ?? GENERIC_LOGIN_SIGNALS).test(words)) return 'login';
  return 'loading';
}

/**
 * The rows of the chat list: a button with no first line of its own is never one (the app's own controls, and the "You" button of WhatsApp Web's left rail).
 * `strict`: also nothing from the page's header — used when a PHONE NUMBER is being looked for, where a button of the app's own top bar ("Meta AI", "Go to
 * Calls", "Invite a friend") must never be taken for the person.
 */
function toCandidates(items: readonly PageItem[], strict = false): Array<ChatCandidate & { readonly item: PageItem }> {
  const out: Array<ChatCandidate & { readonly item: PageItem }> = [];
  for (const item of items) {
    // (the chat list: not the app's menus, not a popup's rows, and never a tick box)
    if (item.region === 'nav' || item.region === 'footer' || item.region === 'dialog' || item.role === 'checkbox') continue;
    // A button that has no first line of its own is a control, never a chat: found on the REAL WhatsApp Web, whose left rail has a button called "You" (the
    // profile), which a search for "You" took for a chat and clicked. A chat is a list row, and a list row has a first line.
    if (item.role === 'button' && item.primary === undefined) continue;
    if (strict && item.region === 'header') continue;
    const label = (item.primary ?? item.name).trim();
    if (label === '' || label.length > 80 || looksLikeControl(label)) continue;
    out.push({ label, item });
  }
  return out;
}

/** The people in an open "who to send it to" popup: its rows (not its tick boxes, its Close or Send, or its section titles), each once. */
function toPickerRows(items: readonly PageItem[]): Array<ChatCandidate & { readonly item: PageItem }> {
  const out: Array<ChatCandidate & { readonly item: PageItem }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.region !== 'dialog' || item.role !== 'button') continue;
    const label = (item.primary ?? item.name).trim();
    if (label === '' || label.length > 80 || looksLikeControl(label)) continue;
    // The same person is listed under "Chats" and again under "Contacts": one row of the same words is one person.
    const key = normalizeText(item.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, item });
  }
  return out;
}

// -------------------------------------------------------------------------------------------------- files on disk
export interface FileAccess {
  stat(path: string): Promise<{ readonly isFile: boolean; readonly isDirectory: boolean; readonly size: number } | null>;
  read(path: string, offset: number, length: number): Promise<Buffer>;
}

const realFiles: FileAccess = {
  async stat(path) {
    try {
      const s = await stat(path);
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
    } catch {
      return null;
    }
  },
  async read(path, offset, length) {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },
};

const MIME: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

export function mimeFor(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// ------------------------------------------------------------------------------------------ the send gate (for clicks)
/**
 * Before a chat message or file goes out, the user is told WHO it is going to — "Found Rahul Sharma, number ending in 432.
 * Send the file "report.pdf" to this chat?" — and has to say yes. A yes given for exactly this file and chat (through
 * attach_file) covers the Send click that follows; any other send asks again.
 */
export interface ChatSendDecision {
  /** Why it needs a yes (null: the user already agreed to exactly this send). */
  readonly reason: string | null;
  /** The question to put to the user, word for word. */
  readonly question: string;
  /**
   * Set when the send is NOT ALLOWED at all (the plugin for this chat app is off, not connected, or has not been given the permission to send): not a
   * question for a yes, a refusal. The person's yes cannot make it allowed — only their change on the Plugins page can.
   */
  readonly blocked?: string;
}

/** Whether the plugin that stands for a chat app may do something that needs this permission: null when it may, otherwise why not (see PluginManager). */
export interface SendPermits {
  permitsApp(app: string, permission: string): string | null;
}

export interface ChatSendGate {
  /** A click on a control that would send, on a chat app's page; null when this is not that (use the ordinary rules). */
  forClick(page: PageSnapshot | null, target: { readonly name: string; readonly role?: string }): ChatSendDecision | null;
  /** Pressing Enter in a message box on a chat app's page. */
  forSubmit(page: PageSnapshot | null, fieldLabel: string): ChatSendDecision | null;
  /** Something was typed in a field of a page: when it is the message box of a chat app, the message is remembered (the question shows it, a yes can send it). */
  typed?(page: PageSnapshot | null, fieldLabel: string, value: string): void;
  /**
   * Even a click that has the user's yes: when the page's header showed the chosen chat's name when it was opened and no longer does, the chat that is
   * open is not the one chosen, and nothing is sent in it. Null when all is as it was (or the header could not be read, so nothing can be said).
   */
  forWrongChat(page: PageSnapshot | null, target: { readonly name: string; readonly role?: string }): ChatSendDecision | null;
  /** The send the user's yes covered has been made: that yes is used up, so the next send asks again. */
  consumed(): void;
}

const BACKING_OUT = /^(cancel|close|discard|remove|delete|dismiss|back|x)$/;

/** Everything a page shows that could name a file (title, headings, buttons, links, popups, the text), as one comparable string. */
function pageText(page: PageSnapshot): string {
  return textOf([page.title, ...page.headings, ...page.links, ...page.buttons, ...page.dialogs, page.visibleText, page.focused]);
}

/** Is this name anywhere on the page as it was looked at? */
function mentions(page: PageSnapshot, name: string): boolean {
  const want = normalizeText(name);
  return want !== '' && pageText(page).includes(want);
}

/**
 * The start of a file's name, without its extension: the first two words, each cut to five letters — what a chat app still shows when it
 * cuts a long name short, even if the cut falls in the middle of a word ("Chaluvagali Raghav…").
 */
function leadWords(name: string): string[] {
  return normalizeText(name.replace(/\.[^./\\]+$/, ''))
    .split(' ')
    .filter((w) => w.length >= 3)
    .slice(0, 2)
    .map((w) => w.slice(0, 5));
}

/** What to ask the page's own search for when the whole name may be cut: the name's first word, or its first two when that is short. */
function leadPhrase(name: string): string {
  const words = normalizeText(name.replace(/\.[^./\\]+$/, '')).split(' ').filter((w) => w.length >= 3);
  const first = words[0];
  return first === undefined ? '' : first.length >= 5 ? first : words.slice(0, 2).join(' ');
}

/**
 * Is this file on the page? Its whole name, or — because a chat app cuts a long name short ("Chaluvagali Raghavendra…") and writes the
 * extension apart or not at all — its first words. Demanding the whole name made a send the user had already agreed to be refused
 * for ever ("I can no longer see the file…") in real use.
 */
function fileShown(page: PageSnapshot, name: string): boolean {
  if (mentions(page, name)) return true;
  const lead = leadWords(name);
  if (lead.length === 0) return false;
  const text = pageText(page);
  return lead.every((w) => text.includes(w));
}

/** The same, but only in the page's popups: is the file's preview still open? */
function previewShows(page: PageSnapshot, name: string): boolean {
  const popups = textOf(page.dialogs);
  const whole = normalizeText(name);
  if (whole !== '' && popups.includes(whole)) return true;
  const lead = leadWords(name);
  return lead.length > 0 && lead.every((w) => popups.includes(w));
}

const SEND_CONTROL = /^(send|send (?:message|now|it|file|files|photo|photos|video|document|attachment)|submit|post)$/;

/**
 * What to say when the chat found is only a likely match (not an exact name, not a whole number): what the match rests on, in the person's terms.
 * ("evidence" is what find_chat / share_file_to_chat reported; "spoken" is what the person said.)
 */
export function weakMatchNote(evidence: string, spoken: string): string {
  switch (evidence) {
    case 'part of the number':
      return 'matched only on part of the number, not the whole number';
    case 'same digits, different country code':
      return 'the same digits as the number you gave, but with a different country code';
    default:
      return `matched only on "${spoken}", not an exact name`;
  }
}

export function describeRecipient(session: ChatSession): { readonly text: string; readonly known: boolean } {
  const chat = session.chat();
  if (chat === null) return { text: "I can't tell who this chat is with", known: false };
  return { text: `Found ${chat.label}${chat.phoneEnding !== undefined ? `, number ending in ${chat.phoneEnding}` : ''}`, known: true };
}

/**
 * Whether the chat that is open is NOT the one that was chosen. Only said when it can be known: the header showed the chosen name when the chat was
 * opened (so this app's header can be read) and it does not show it now. A preview that is open covers the header, and says nothing.
 */
export function openChatIsWrong(session: ChatSession, page: PageSnapshot): boolean {
  const chat = session.chat();
  if (chat === null || page.dialogs.length > 0) return false;
  const adapter = adapterByName(chat.app);
  const composer = readComposer(adapter, page.inputs);
  // The page's own message box says which chat it is open in: when that is not the chosen one (whole name, not a part of a longer one), it is the wrong chat.
  if (composer !== null && composer.present && composer.target !== null) return !sameTarget(composer.target, chat.label) && !(chat.composerAs !== undefined && sameTarget(composer.target, chat.composerAs));
  // No message box at all: the chat that was open has gone (closed, or another screen).
  if (composer !== null && !composer.present) return chat.headerChecked === true;
  if (chat.headerChecked !== true) return false;
  // A chat that was shown open by its message box is not judged by a header that may not be readable.
  if (chat.proof === 'composer') return false;
  return !headerMentions(page, chat.label, chat.confusableWith, adapter);
}

export function createChatSendGate(session: ChatSession, policy: CommunicationPolicy, plugins?: SendPermits): ChatSendGate {
  /** A Send in a chat app is held to the plugin's permission: a file needs "send files", anything else "send text messages". */
  function notPermitted(page: PageSnapshot | null): ChatSendDecision | null {
    if (plugins === undefined || page === null) return null;
    const app = policy.appForUrl(page.url);
    if (app === null) return null;
    const why = plugins.permitsApp(app.id, session.attachment() !== null ? 'files.send' : 'messages.send');
    return why === null ? null : { reason: why, question: why, blocked: why };
  }
  function wrongChat(page: PageSnapshot | null): ChatSendDecision | null {
    if (page === null || policy.appForUrl(page.url) === null || !openChatIsWrong(session, page)) return null;
    const chat = session.chat();
    return { reason: 'the chat that is open is not the one chosen', question: `The chat that is open no longer shows the name ${chat?.label ?? ''}, so nothing is sent in it. Open the right chat again first.` };
  }
  function decide(page: PageSnapshot | null): ChatSendDecision | null {
    if (page === null || policy.appForUrl(page.url) === null) return null; // not a chat app: the ordinary rules apply
    const blocked = notPermitted(page);
    if (blocked !== null) return blocked;
    const wrong = wrongChat(page);
    if (wrong !== null) return wrong;
    const who = describeRecipient(session);
    const chat = session.chat();
    const file = session.attachment();
    // The yes was for a file: it only still counts while that file can be seen waiting on the page (a cancelled preview does not count).
    // If the attach step could only tell that a preview had opened (not read the name), an open popup is the same evidence here.
    const waiting = file === null || fileShown(page, file) || (session.attachedAs() === 'preview_opened' && page.dialogs.length > 0);
    if (chat !== null && waiting && session.isAuthorized(chat.label, file ?? undefined)) return { reason: null, question: '' };
    const typedMessage = file === null ? session.typedMessage() : null;
    const shownMessage = typedMessage === null ? null : typedMessage.length > 160 ? `${typedMessage.slice(0, 157)}…` : typedMessage;
    const what = file === null ? (shownMessage !== null ? `"${shownMessage}"` : 'this message') : waiting ? `the file "${file}"` : null;
    // (a question about a message is remembered: the person's yes is then carried out by the application, not left to the AI to ask the same thing again)
    const askedApp = policy.appForUrl(page.url);
    if (file === null && chat !== null && askedApp !== null) session.askedToSend(chat.label, askedApp.id);
    if (what === null) {
      return {
        reason: 'sending in a chat app',
        question: `${who.text}. I can no longer see the file "${file}" waiting on the page. Send what is on the page to this chat?`,
      };
    }
    return {
      reason: `sending ${what} in a chat app`,
      question: `${who.text}. Send ${what} to this chat?`,
    };
  }
  return {
    forClick(page, target) {
      const name = normalizeText(target.name);
      // Backing out of a preview withdraws the yes that was given for it (before the click, so a failed click only ever errs on the safe side).
      if (page !== null && policy.appForUrl(page.url) !== null && BACKING_OUT.test(name)) session.sendCancelled();
      if (target.role === 'link' || !SEND_CONTROL.test(name)) return null;
      return decide(page);
    },
    forSubmit(page, fieldLabel) {
      const label = normalizeText(fieldLabel);
      // A message box, a reply box or a caption box — never the search box (whose label may well say "chat").
      return !SEARCH_FIELD.test(label) && /\b(message|messages|reply|caption)\b|^(type|write) a\b/.test(label) ? decide(page) : null;
    },
    typed(page, fieldLabel, value) {
      const label = normalizeText(fieldLabel);
      if (page === null || policy.appForUrl(page.url) === null || SEARCH_FIELD.test(label) || !/\b(message|messages|reply|caption)\b|^(type|write) a\b/.test(label)) return;
      session.typed(value);
    },
    forWrongChat(page, target) {
      if (target.role === 'link' || !SEND_CONTROL.test(normalizeText(target.name))) return null;
      // (even a click the person said yes to is refused when the plugin may not send: a yes cannot give a permission)
      return notPermitted(page) ?? wrongChat(page);
    },
    consumed() {
      session.sendMade();
    },
  };
}

// -------------------------------------------------------------------------------------------------------- the tools
/**
 * Where find_chat tells the contact book which chats it saw. It hears only chat NAMES — the rows the app showed in answer to a name
 * the user asked for, and the chat that was opened — never a preview or a message. Whether anything is kept is the book's business
 * (nothing is, until the user said yes).
 */
export interface ChatNameSink {
  /** Remembers these names if the user agreed to that; returns how many were new. */
  learn(appId: string, labels: readonly string[]): number;
  used(appId: string, label: string): void;
  /** Whether the user has agreed to Eya remembering chat names. */
  learning(): boolean;
  /** Of several chats that all fit what was said, the one the user messages by far the most (null when none stands out, or nothing is kept). */
  favourite?(appId: string, labels: readonly string[]): string | null;
  /**
   * After a send was confirmed: when the user has never been asked whether Eya may remember chat names, makes that the question waiting
   * for a yes and returns the words to ask it in; otherwise null. (Remembering names starts only with that yes.)
   */
  offerConsent?(appId: string, label: string): string | null;
}

export interface ChatToolDeps {
  readonly service: BrowserAutomationService & Partial<BrowserItemLister> & Partial<BrowserItemClicker> & Partial<BrowserFileAttach>;
  readonly now?: () => number;
  readonly policy: CommunicationPolicy;
  readonly session: ChatSession;
  readonly folders: KnownFolders;
  readonly files?: FileAccess;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The contact book, to learn names as chats are looked for and opened. Optional. */
  readonly names?: ChatNameSink;
  /** The country a phone number said without its country code belongs to (a two-letter code; India when it is not given). Read each time, so a change in Settings counts at once. */
  readonly country?: () => string | undefined;
}

export function createChatTools(deps: ChatToolDeps): Tool[] {
  const { service, policy, session, folders } = deps;
  const files = deps.files ?? realFiles;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const notChatPage = (url: string): ToolResult => ({
    ok: false,
    summary: 'not a chat app',
    error: `The page that is open (${url || 'no page'}) is not one of the chat apps Communication Access covers, so nothing was done. Open the chat app first (open_website), and only for a chat app the user has allowed.`,
  });

  // ----------------------------------------------------------------------------------------------------- find_chat
  const now = deps.now ?? Date.now;
  const lister = service as Partial<BrowserItemLister>;
  /** What was typed into the app's search box last, and when: the same words are not typed again while the search is still there to be read. */
  let lastSearch: { readonly key: string; readonly url: string; readonly at: number } | null = null;
  /** The sounds-alike look (the first letters of a name, searched) is tried once for a name, not on every call: a loop of calls would flip between the two searches. */
  const soundTried = new Map<string, number>();
  /** How many chats in a row had a header that could not be read (an app whose header Eya cannot read is not waited on for it). */
  let headerUnreadable = 0;

  /**
   * After the chat was opened: does the page's header show its name? A chat that opens a moment after the click has not shown its name yet, so the
   * page is looked at again a few times (each look is about 10 ms) before the header is called unreadable. Never a reason to fail by itself: the
   * header of some apps cannot be read, and then the person is told who it is going to and that this could not be double-checked.
   */
  /**
   * A message box that names the open chat by a PHONE NUMBER ("Type a message to +1 (940) 290-7669") says nothing against the chat that was chosen: found on the
   * real WhatsApp Web, which does this for some saved contacts, so a right chat was refused as "a different chat". What can then be said is read from the page's
   * HEADER: a button there named exactly as the chat is. Returns the number the box names (which it must go on naming) when the header shows the chat, else null.
   * A box that names another NAME is never rescued: that is a different chat.
   */
  async function headerNamesChat(label: string, adapter: ChatPlatformAdapter | undefined, snapshot: PageSnapshot): Promise<string | null> {
    const target = readComposer(adapter, snapshot.inputs)?.target ?? null;
    if (target === null || !/^\+?[\d\s().-]{7,}$/.test(target)) return null;
    try {
      const items = (await lister.listItems?.()) ?? [];
      const want = normalizeText(label);
      return items.some((i) => i.role === 'button' && i.region === 'header' && normalizeText(i.name) === want) ? target : null;
    } catch {
      return null;
    }
  }

  async function confirmOpened(label: string, first: PageSnapshot, confusable: readonly string[], adapter?: ChatPlatformAdapter): Promise<{ readonly checked: boolean; readonly snapshot: PageSnapshot; readonly state: Conversation; readonly composerAs?: string }> {
    let snapshot = first;
    let state = conversationState(snapshot, label, confusable, adapter);
    if (state === 'yes') {
      headerUnreadable = 0;
      return { checked: true, snapshot, state };
    }
    if (state === 'wrong') {
      const as = await headerNamesChat(label, adapter, snapshot);
      if (as !== null) {
        headerUnreadable = 0;
        return { checked: true, snapshot, state: 'yes', composerAs: as };
      }
    }
    // An app whose message box is known (WhatsApp Web) says whether a chat is open, so a click that opened nothing is waited for a little (a chat can take a
    // moment to come up) and then called what it is. An app whose box and header cannot be read is not waited on once it has proved to be one of those.
    const known = readComposer(adapter, snapshot.inputs) !== null;
    const looks = known ? 8 : headerUnreadable >= 2 ? 0 : 4;
    for (let look = 0; look < looks && state !== 'wrong'; look += 1) {
      await sleep(known ? 250 : 200);
      snapshot = await service.inspectPage();
      state = conversationState(snapshot, label, confusable, adapter);
      if (state === 'yes') {
        headerUnreadable = 0;
        return { checked: true, snapshot, state };
      }
      if (state === 'wrong') {
        const as = await headerNamesChat(label, adapter, snapshot);
        if (as !== null) {
          headerUnreadable = 0;
          return { checked: true, snapshot, state: 'yes', composerAs: as };
        }
      }
    }
    if (!known) headerUnreadable += 1;
    return { checked: false, snapshot, state };
  }

  /**
   * Closes the app's "who to send it to" popup when it is open (a file waiting in it is simply not sent): by its own Close, then Escape. Returns the page as it is
   * afterwards. Nothing is sent by this.
   */
  async function dismissPicker(adapter: ChatPlatformAdapter | undefined, page: PageSnapshot): Promise<PageSnapshot> {
    const share = adapter?.shareDialog;
    if (share === undefined || !shareDialogOpen(adapter, page)) return page;
    let now = page;
    try {
      await service.clickOnPage(share.closeLabel);
    } catch {
      // Escape below
    }
    await sleep(300);
    now = await service.inspectPage();
    if (shareDialogOpen(adapter, now)) {
      const presser = service as Partial<BrowserKeyPress>;
      if (typeof presser.pressEscape === 'function') {
        try {
          await presser.pressEscape();
        } catch {
          // nothing more to try
        }
        await sleep(300);
        now = await service.inspectPage();
      }
    }
    session.shareDone();
    return now;
  }

  /**
   * Opens the chat the list row stands for. The row is found again, by its first line, in the page as it is at this moment (see BrowserItemClicker):
   * clicking by the row's whole text needed the preview, the time and the unread count to be what they were when the list was read.
   */
  async function openFound(label: string, item: PageItem, appName: string, how: string, basis: { readonly verified: boolean; readonly evidence: string }, confusable: readonly string[], known?: string, appId?: string): Promise<ToolResult> {
    const clicker = service as Partial<BrowserItemClicker>;
    const adapter = appId !== undefined ? adapterFor(appId) : undefined;
    const click = typeof clicker.clickItem === 'function' ? await clicker.clickItem({ primary: item.primary ?? label, name: item.name }) : await service.clickOnPage(item.name); // opening a chat sends nothing
    if (!click.ok) {
      return { ok: false, summary: 'could not open the chat', error: `I found "${label}" but could not open it${'message' in click ? `: ${click.message}` : ''}.`, data: { status: 'failed', reason: click.reason } };
    }
    lastSearch = null; // opening a chat clears the search: the next search is a new one
    const opened = await confirmOpened(label, click.snapshot, confusable, adapter);
    // A click that was carried out is not a chat that opened: the PAGE has to show it (its message box names the chat, or its header does).
    if (opened.state === 'no') {
      return {
        ok: false,
        summary: 'the chat did not open',
        error: `I clicked "${label}" but the page did not show that chat opening (no message box came up), so nothing was typed or sent. Do not assume it is open.`,
        data: { status: 'not_opened', reason: 'no_conversation_after_click' },
      };
    }
    if (opened.state === 'wrong') {
      return {
        ok: false,
        summary: 'a different chat opened',
        error: `I clicked "${label}" but the page shows a different chat open, so nothing was typed or sent.`,
        data: { status: 'wrong_chat', reason: 'another_conversation_is_open', ...(openedAsLabel(adapter, opened.snapshot) !== null ? { openedAs: openedAsLabel(adapter, opened.snapshot) } : {}) },
      };
    }
    const ending = phoneEndingNear(opened.snapshot, label) ?? known ?? null;
    const composerNamed = readComposer(adapter, opened.snapshot.inputs)?.target != null;
    session.openedChat({ app: appName, label, ...(ending !== null ? { phoneEnding: ending } : {}), ...(opened.composerAs !== undefined ? { composerAs: opened.composerAs } : {}), verified: basis.verified, headerChecked: opened.checked, ...(opened.checked ? { proof: composerNamed ? ('composer' as const) : ('header' as const) } : {}), matchedBy: basis.evidence, ...(confusable.length > 0 ? { confusableWith: confusable } : {}) });
    if (appId !== undefined) deps.names?.used(appId, label);
    session.markBaseline(opened.snapshot.messageStatus ?? []);
    return {
      ok: true,
      summary: `opened the chat with ${label}`,
      data: {
        status: 'opened',
        chat: label,
        app: appName,
        ...(ending !== null ? { numberEndsIn: ending } : {}),
        matchedBy: how,
        verified: basis.verified,
        matchEvidence: basis.evidence,
        headerChecked: opened.checked,
        ...(basis.verified ? {} : { matchNote: `This is a likely match (${basis.evidence}), not an exact name: say exactly who it is when you ask for the go-ahead to send.` }),
        ...(opened.checked ? {} : { note: "The chat is open, but I could not read the name in its header to double-check — say who it is going to when you ask for the go-ahead to send." }),
        next: 'To send a file: attach_file. To send a message: fill_on_page the message box, then click_on_page Send.',
      },
    };
  }

  /**
   * Types the words into the app's search box and reads what it shows once it has settled. The same words, on the same page, are typed ONCE: a
   * second call for them (the page was still loading, a click failed, the task was tried again) reads the search that is already there instead of
   * clearing and retyping it, which made the list flicker, never settle, and sent Eya round the search box again and again.
   */
  async function searchOnce(box: string, typed: string, url: string, strict = false): Promise<Array<ChatCandidate & { readonly item: PageItem }>> {
    const key = normalizeText(typed);
    const same = lastSearch !== null && lastSearch.key === key && lastSearch.url === url && now() - lastSearch.at < SEARCH_REUSE_MS;
    const listBefore = same ? '' : namesKey((await lister.listItems?.()) ?? []);
    if (!same) {
      await service.fillOnPage(box, typed);
      lastSearch = { key, url, at: now() };
    }
    return toCandidates(await listWhenSettled(lister, sleep, listBefore), strict);
  }

  const countryNow = (): CountryContext => countryContext(deps.country?.());

  /** The last three digits of the number a candidate shows, for "number ending in" (never more of it). */
  const endingOf = (c: { readonly shownNumber: string | null }): string | undefined => (c.shownNumber === null ? undefined : c.shownNumber.slice(-3));

  /**
   * What to type into an app's search for a number the person gave. A whole number is searched as its national digits (what every way of saving it contains);
   * if that finds nobody it is searched once more with its country code (see lookForNumber). A part of a number is typed as it was said.
   */
  const digitsToSearch = (phone: PhoneReading, form: 'national' | 'whole'): string =>
    phone.kind === 'international' || phone.kind === 'national' ? (form === 'whole' ? (phone.e164 as string) : (phone.national as string)) : phone.digits;

  /** What the app's search matched on, in the words the person is told when it is only a likely match. */
  function numberEvidence(c: RecipientCandidate): string {
    switch (c.evidence) {
      case 'exact_number':
      case 'app_search_whole_number':
        return c.confidence === 'high' ? 'full phone number' : 'part of the number';
      case 'number_suffix':
        return c.confidence === 'high' ? 'end of the number' : 'part of the number';
      case 'number_other_country':
        return 'same digits, different country code';
      default:
        return 'part of the number';
    }
  }

  type NumberDecision<R> =
    | { readonly kind: 'go'; readonly row: R; readonly verified: boolean; readonly evidence: string; readonly how: string; readonly known?: string }
    | { readonly kind: 'stop'; readonly result: ToolResult };

  /** The people the number could be, as the question to the person (names, and numbers masked), kept as choices that can be picked by their number. */
  function ambiguousFromResolution(resolution: RecipientResolution, how: string): ToolResult {
    const list = resolution.candidates.slice(0, 6);
    const offered = session.offerChoices(list.map((c) => ({ label: c.row.label, ...(endingOf(c) !== undefined ? { phoneEnding: endingOf(c) as string } : {}) })));
    return {
      ok: true,
      summary: `${list.length} chats could be the one`,
      data: {
        status: 'ambiguous',
        // (a chat listed under its phone number is handed back with the number hidden; the choice number still finds the real one)
        candidates: offered.map((o, i) => ({ ...o, label: maskNumbersIn(o.label), ...(list[i]?.masked != null ? { masked: list[i]?.masked } : {}) })),
        matchedBy: how,
        question: 'Read these names (and the masked numbers) to the user and ask which one. Then call this tool again with that choice number. Do not pick one yourself, and never read a whole phone number out.',
      },
    };
  }

  /**
   * Who a phone number (or the end of one) is, among the rows the app showed for it. The decision is the recipient resolver's (recipientResolver.ts); this turns it into
   * what the tools do: go on with one chat (and whether it is an identity or only a likely match), ask which, or say that nobody fits and what is missing.
   */
  function decideByNumber<R extends ChatCandidate & { readonly item: PageItem }>(reference: RecipientReference, rows: readonly R[], searched: boolean, appName: string): NumberDecision<R> {
    const resolution = resolveRecipient(reference, rows, { country: countryNow(), searched });
    const how = searched ? "the app's own search on those digits" : 'the number shown on the chat';
    if ((resolution.status === 'resolved' || resolution.status === 'confirm') && resolution.chosen !== null) {
      const chosen = resolution.chosen;
      const phone = reference.phone;
      const known = endingOf(chosen) ?? (phone !== undefined && phone.national !== undefined ? phone.national.slice(-3) : undefined);
      return { kind: 'go', row: chosen.row as unknown as R, verified: resolution.safeToSend, evidence: numberEvidence(chosen), how, ...(known !== undefined ? { known } : {}) };
    }
    if (resolution.status === 'ambiguous') return { kind: 'stop', result: ambiguousFromResolution(resolution, how) };
    const phone = reference.phone;
    const said =
      resolution.status === 'unreadable' && resolution.question !== null
        ? resolution.question
        : phone !== undefined && phone.e164 !== undefined
          ? `I couldn't find a chat with ${maskNumber(phone.e164)} in ${appName}. If it's a new contact, save the number in your phone and tell me again, or tell me their name.`
          : `I couldn't find a chat in ${appName} whose number has those digits. Tell me the name, or the whole number.`;
    return { kind: 'stop', result: { ok: true, summary: 'no chat found', data: { status: 'none', say: said, hint: 'Nobody fits that number. Say so; ask for the name or the whole number. Never make up a number or a name.', ...(resolution.status === 'unreadable' ? { unreadable: true } : {}) } } };
  }

  /** Searches the app for a number: its national digits first, and — if that shows nobody — once more with the country code. */
  async function lookForNumber<R>(phone: PhoneReading, search: (typed: string) => Promise<R[]>): Promise<R[]> {
    let rows = await search(digitsToSearch(phone, 'national'));
    if (rows.length === 0 && (phone.kind === 'international' || phone.kind === 'national') && phone.e164 !== phone.national) rows = await search(digitsToSearch(phone, 'whole'));
    return rows;
  }

  function ambiguousResult(matches: ReadonlyArray<ChatMatch<ChatCandidate & { readonly item: PageItem }>>, how: string): ToolResult {
    const offered = session.offerChoices(matches.slice(0, 6).map((m) => ({ label: m.candidate.label, ...(m.phoneEnding !== undefined ? { phoneEnding: m.phoneEnding } : {}) })));
    return {
      ok: true,
      summary: `${matches.length} chats could be the one`,
      data: {
        status: 'ambiguous',
        candidates: offered.map((o) => ({ ...o, label: maskNumbersIn(o.label) })),
        matchedBy: how,
        question: 'Read these names (and number endings) to the user and ask which one. Then call find_chat again with that choice number. Do not pick one yourself.',
      },
    };
  }

  const findChat: Tool = {
    schema: {
      name: 'find_chat',
      status: 'Looking for that chat…',
      description:
        "Find and open one person's or group's chat inside a chat app that is open in the user's browser (WhatsApp, Telegram, Instagram…) — by the name the user gave " +
        '(full, first, last or part of it) or by digits of the phone number ("ending 432", "starting 98765"). It types the name into the app\'s own search box, ' +
        'chooses between the results itself, and gives you only the name(s) that matched — never the chat list or any message. One clear match is opened; ' +
        'if several fit it returns them (status "ambiguous") and you must ask the user which, then call again with choice; if none fit it says so. Only works while ' +
        'Communication Access is on for that app. It sends nothing.',
      args: {
        query: { type: 'string', description: 'The name or number digits the user gave, e.g. "Rahul Sharma", "Priya", "number ending 432". Omit when passing choice.' },
        choice: { type: 'number', description: 'The number of a candidate from an earlier "ambiguous" result, after the user chose.' },
        open: { type: 'boolean', description: 'Open the chat when exactly one matches (default true). False only to look.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = stringArg(args, 'query');
      const choice = typeof args['choice'] === 'number' && Number.isFinite(args['choice']) ? Math.trunc(args['choice']) : undefined;
      const shouldOpen = args['open'] !== false;
      if (query === undefined && choice === undefined) return { ok: false, summary: 'no name', error: 'A name or number to look for is required.' };
      if (typeof lister.listItems !== 'function') return { ok: false, summary: 'not available', error: 'Finding a chat is not available in this browser window.' };
      try {
        let before = await service.inspectPage(); // refused here (CommunicationAccessError) when the chat app is switched off
        const app = policy.appForUrl(before.url);
        if (app === null) return notChatPage(before.url);
        const adapter = adapterFor(app.id);
        // A "Select chats" popup left open (by an earlier file) covers the chat list: it is closed first, so that what is typed and clicked is the list.
        if (shareDialogOpen(adapter, before)) before = await dismissPicker(adapter, before);

        if (choice !== undefined) {
          const picked = session.pick(choice);
          if (picked === null) return { ok: false, summary: 'no such choice', error: 'That number is not one of the chats offered. Call find_chat with the name again.' };
          const rows = toCandidates(await lister.listItems());
          const row = rows.find((r) => normalizeText(r.label) === normalizeText(picked.label));
          if (row === undefined) return { ok: false, summary: 'chat not showing', error: `"${picked.label}" is not in the list that is showing now. Call find_chat with the name again.` };
          return await openFound(picked.label, row.item, app.name, 'the choice the user made', { verified: true, evidence: 'the user chose it' }, confusablesOf(picked.label, rows), picked.phoneEnding, app.id);
        }

        // A chat app that is still loading (its list is not there yet), or waiting for a log-in, is not "no such chat": say which, so the
        // caller can wait instead of giving up.
        const state = chatAppState(before, adapter);
        if (state !== 'ready') {
          return state === 'login'
            ? { ok: true, summary: 'log-in needed', data: { status: 'needs_login', hint: 'The chat app is asking the user to log in (a QR code). They must do that themselves; wait for them.' } }
            : { ok: true, summary: 'still loading', data: { status: 'loading', hint: 'The chat app has not finished loading its chats. Wait a few seconds and look again.' } };
        }
        const wanted = query as string;
        const parsed = parseChatQuery(wanted);
        if (parsed.names.length === 0 && parsed.digits.length < 2) {
          return { ok: false, summary: 'no name', error: 'I need a name, or at least two digits of the number, to look for.' };
        }
        // The chat that is already open, asked for by exactly its name, is not searched for or opened again (a task tried again, or a request said twice).
        const openNow = session.chat();
        if (shouldOpen && openNow !== null && parsed.names.length > 0 && normalizeText(openNow.label) === normalizeText(parsed.names.join(' ')) && conversationState(before, openNow.label, openNow.confusableWith ?? [], adapter) === 'yes') {
          // (the delivery marks showing now are what the coming send is compared with, exactly as when the chat is opened)
          session.markBaseline(before.messageStatus ?? []);
          return {
            ok: true,
            summary: `the chat with ${openNow.label} is already open`,
            data: {
              status: 'opened',
              chat: openNow.label,
              app: app.name,
              alreadyOpen: true,
              matchedBy: 'the chat that is already open',
              verified: openNow.verified ?? true,
              matchEvidence: openNow.matchedBy ?? 'already open',
              headerChecked: true,
              ...(openNow.phoneEnding !== undefined ? { numberEndsIn: openNow.phoneEnding } : {}),
              next: 'To send a file: attach_file. To send a message: fill_on_page the message box, then click_on_page Send.',
            },
          };
        }
        // The chat that is already open, whose message box names exactly the number that was asked for ("Type a message to +91 98765 08501"), IS that chat: there is nothing to
        // search for or click. (Someone who has just opened it and says "do it now" must not be sent round the search box again — and a search for a number can show rows that
        // are not chats at all.)
        const askedFor = readRecipientReference(wanted, countryNow());
        if (shouldOpen && askedFor.phone !== undefined && (askedFor.phone.kind === 'international' || askedFor.phone.kind === 'national') && askedFor.phone.national !== undefined) {
          const shown = readComposer(adapter, before.inputs)?.target ?? null;
          const shownDigits = shown === null ? '' : shown.replace(/\D/g, '');
          const national = askedFor.phone.national.replace(/\D/g, '');
          if (shown !== null && national.length >= 8 && shownDigits.length >= national.length && shownDigits.endsWith(national)) {
            session.openedChat({ app: app.name, label: shown, phoneEnding: national.slice(-3), composerAs: shown, verified: true, headerChecked: true, proof: 'composer', matchedBy: 'the number in the open chat' });
            session.markBaseline(before.messageStatus ?? []);
            return {
              ok: true,
              summary: `the chat with ${shown} is already open`,
              data: {
                status: 'opened',
                chat: shown,
                app: app.name,
                alreadyOpen: true,
                matchedBy: 'the chat that is already open',
                verified: true,
                matchEvidence: 'full phone number',
                headerChecked: true,
                numberEndsIn: national.slice(-3),
                next: 'To send a file: attach_file. To send a message: fill_on_page the message box, then click_on_page Send.',
              },
            };
          }
        }
        // Type it into the app's own search box (once) so the list shows what fits; if there is no box, work from what is showing.
        const searchField = adapter?.searchField ?? SEARCH_FIELD;
        const searchBox = before.inputs.find((i) => searchField.test(i));
        // A phone number, or the end of one: read against the person's country, looked for in the app, and decided by the recipient resolver (never a guess).
        const reference = readRecipientReference(wanted, countryNow());
        if (reference.phone !== undefined && reference.kind !== 'name' && reference.kind !== 'context') {
          const phone = reference.phone;
          const found = searchBox !== undefined ? await lookForNumber(phone, (typed) => searchOnce(searchBox, typed, before.url, true)) : toCandidates(await lister.listItems(), true);
          const decision = decideByNumber(reference, found, searchBox !== undefined, app.name);
          if (decision.kind === 'stop') return decision.result;
          if (!shouldOpen) return { ok: true, summary: `found ${decision.row.label}`, data: { status: 'found', chat: decision.row.label, matchedBy: decision.how } };
          return await openFound(decision.row.label, decision.row.item, app.name, decision.how, { verified: decision.verified, evidence: decision.evidence }, [], decision.known, app.id);
        }
        const typed = parsed.names.length > 0 ? parsed.names.join(' ') : parsed.digits;
        let rows = searchBox !== undefined ? await searchOnce(searchBox, typed, before.url) : toCandidates(await lister.listItems());

        if (parsed.names.length === 0) {
          // Digits only: a chat list does not show numbers, so the app's own search did the matching.
          if (rows.length === 0) return { ok: true, summary: 'no chat found', data: { status: 'none', hint: 'No chat matches those digits. Ask the user for the name instead.' } };
          const how = "the app's own search on those digits";
          // (a whole number is an identity; the end of a number, or its start, is only a likely match)
          const basis = parsed.digits.length >= 10 ? { verified: true, evidence: 'full phone number' } : { verified: false, evidence: 'part of the number' };
          // (the last digits that were said are what is shown as "number ending in", as the page's header does not always show a number)
          const said = parsed.digits.length >= 7 ? parsed.digits.slice(-3) : undefined;
          if (rows.length === 1 && shouldOpen) return await openFound((rows[0] as (typeof rows)[number]).label, (rows[0] as (typeof rows)[number]).item, app.name, how, basis, [], said, app.id);
          if (rows.length === 1) return { ok: true, summary: 'one chat matches', data: { status: 'found', chat: (rows[0] as (typeof rows)[number]).label, matchedBy: how } };
          return ambiguousResult(rows.map((r) => ({ candidate: r, strength: 'strong', reason: 'phone number', score: 0, evidence: 'part of the number', verified: false }) as ChatMatch<(typeof rows)[number]>), how);
        }

        let resolution = resolveChat(wanted, rows, { recent: session.recent() });
        if (resolution.kind === 'none' && searchBox !== undefined) {
          // Nothing fits. A search can be answered late (the app asks its server, or it is busy), so look once more before saying so.
          await sleep(400);
          rows = toCandidates(await listWhenSettled(lister, sleep, namesKey([])));
          resolution = resolveChat(wanted, rows, { recent: session.recent() });
        }
        const heard = parsed.names.length === 1 ? (parsed.names[0] as string) : '';
        if (resolution.kind === 'none' && searchBox !== undefined && heard.length >= 3 && (soundTried.get(heard) ?? 0) <= now() - SEARCH_REUSE_MS) {
          soundTried.set(heard, now());
          // A name the speech recogniser spelled by ear ("aka" for the chat called "Akka"): the app's search cannot find a spelling it does
          // not have, so look at everything that starts the same way, and take only a name that SOUNDS like what was said.
          const listBefore = namesKey(await lister.listItems());
          await service.fillOnPage(searchBox, heard.slice(0, 2));
          lastSearch = { key: normalizeText(heard.slice(0, 2)), url: before.url, at: now() };
          const alike = toCandidates(await listWhenSettled(lister, sleep, listBefore)).filter((r) => soundsLike(heard, r.label));
          resolution = resolveChat(heard, alike, { recent: session.recent() });
        }
        if (resolution.kind === 'none') {
          return { ok: true, summary: 'no chat found', data: { status: 'none', hint: 'No chat matches that name. Ask the user for another spelling, or a number to search by. Do not guess.' } };
        }
        // The rows that fit what the user asked for are names worth remembering (only list rows with a title line, never other things on
        // the page); the book keeps them only if the user said yes to that.
        const fitting = resolution.kind === 'ambiguous' ? resolution.matches.map((x) => x.candidate) : [resolution.match.candidate];
        deps.names?.learn(app.id, fitting.filter((c) => c.item.primary !== undefined).map((c) => c.label));
        let usual = false;
        if (resolution.kind === 'ambiguous') {
          // Several chats fit. If one of them is plainly the user's usual (opened far more often than the rest), that is the one; they are
          // still told who it is before anything is sent.
          const favourite = deps.names?.favourite?.(app.id, resolution.matches.map((x) => x.candidate.label)) ?? null;
          const chosen = favourite === null ? undefined : resolution.matches.find((x) => normalizeText(x.candidate.label) === normalizeText(favourite));
          if (chosen === undefined) return ambiguousResult(resolution.matches, 'name');
          resolution = { kind: 'unique', match: chosen };
          usual = true;
        }
        const m = resolution.match;
        const how = usual ? 'name (the one the user messages most)' : resolution.viaRecent === true ? 'name (the one used earlier in this conversation)' : m.strength === 'fuzzy' ? 'a close spelling of the name' : m.reason;
        if (!shouldOpen) return { ok: true, summary: `found ${m.candidate.label}`, data: { status: 'found', chat: m.candidate.label, matchedBy: how } };
        // Only an exact name or a whole number identifies a chat; the user's usual chat, one used earlier, a name that merely contains the words and
        // a close spelling are likely matches, and are said to be when the person is asked to go ahead.
        const basis = usual ? { verified: false, evidence: 'the chat you message most' } : resolution.viaRecent === true ? { verified: false, evidence: 'used earlier in this conversation' } : { verified: m.verified, evidence: m.evidence };
        const result = await openFound(m.candidate.label, m.candidate.item, app.name, how, basis, confusablesOf(m.candidate.label, rows), m.phoneEnding, app.id);
        return m.strength === 'fuzzy' && result.ok ? { ...result, data: { ...result.data, note: 'This was a close spelling, not an exact match: say the name you opened when asking to send.' } } : result;
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        // (what KIND of failure it was is kept, so that it is said and diagnosed as what it was, not as "could not look")
        const code = typeof (err as { code?: unknown }).code === 'string' ? ((err as { code: string }).code) : 'other';
        return { ok: false, summary: 'could not look', error: `I could not look for that chat: ${err instanceof Error ? err.message : String(err)}`, data: { status: 'error', reason: code } };
      }
    },
  };

  // --------------------------------------------------------------------------------------------------- attach_file
  async function confirmAttachment(name: string): Promise<{ readonly shown: 'name_visible' | 'preview_opened'; readonly marks: readonly string[] } | null> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(attempt === 0 ? 250 : 300); // looking is cheap (about 10 ms), so look often; about the same ceiling as before
      const snap = await service.inspectPage();
      const marks = snap.messageStatus ?? [];
      const want = normalizeText(name);
      if (snap.dialogs.some((d) => normalizeText(d).includes(want))) return { shown: 'name_visible', marks };
      const found = await service.findOnPage(name);
      if (found.matches.length > 0 || found.textMatches.length > 0) return { shown: 'name_visible', marks };
      if (snap.dialogs.length > 0) return { shown: 'preview_opened', marks };
    }
    return null;
  }

  /** The checks every file passes before it is handed to a page: allowed place, not a program, a real file, not empty, not too big. */
  async function checkAttachment(raw: string): Promise<{ readonly ok: true; readonly path: string; readonly name: string; readonly size: number } | { readonly ok: false; readonly result: ToolResult }> {
    const checked = checkReadablePath(raw, folders);
    if (!checked.ok) return { ok: false, result: { ok: false, summary: 'not allowed', error: `I won't attach that: ${checked.reason}.` } };
    const path = checked.path;
    const name = basename(path);
    if (isExecutablePath(path)) return { ok: false, result: { ok: false, summary: 'not allowed', error: `"${name}" is a program or script, which I don't send through chat apps.` } };
    const info = await files.stat(path);
    if (info === null) return { ok: false, result: { ok: false, summary: 'file not found', error: `There is no file at that path ("${name}").` } };
    if (info.isDirectory) {
      return { ok: false, result: { ok: false, summary: 'that is a folder', error: `"${name}" is a folder, and a chat app cannot take a folder. Use zip_folder to make a .zip of it first (and tell the user), then attach that.` } };
    }
    if (!info.isFile || info.size <= 0) return { ok: false, result: { ok: false, summary: 'empty file', error: `"${name}" is empty, so there is nothing to send.` } };
    if (info.size > MAX_ATTACH_BYTES) return { ok: false, result: { ok: false, summary: 'too big', error: `"${name}" is ${Math.round(info.size / 1048576)} MB; chat apps take at most about 100 MB.` } };
    return { ok: true, path, name, size: info.size };
  }

  const attachFile: Tool = {
    schema: {
      name: 'attach_file',
      status: 'Attaching the file…',
      description:
        "Put a file from this PC on the open chat app's attach step, so the app shows its preview — it does NOT send it. Call it first WITHOUT confirm: it checks the file and the chat and " +
        'returns the question to ask the user ("Found <name>, number ending in …. Send the file … to this chat?"). Ask exactly that, and only after a clear yes call it again with confirm: true. ' +
        'It then attaches, checks that the app really shows the attachment, and tells you; the following click on the app\'s Send button goes ahead without asking again (that yes covers exactly this ' +
        'file and chat), and you must then call verify_sent. If the page has no file picker yet, open the app\'s attach menu (the paperclip or plus) — never click Document or Photos inside it — and call again. ' +
        'Pass the exact path (from find_file or the user); a folder cannot be attached: zip_folder it first. Works only in a chat app the user has allowed.',
      args: {
        path: { type: 'string', required: true, description: 'The full path of the file on this PC.' },
        confirm: { type: 'boolean', description: 'true ONLY after the user clearly said yes to the question this tool returned.' },
        as: { type: 'string', enum: ['auto', 'document', 'media'], description: 'document = send as a file; media = as a photo/video; auto (default) picks by file type.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const raw = stringArg(args, 'path');
      if (raw === undefined) return { ok: false, summary: 'no file', error: 'The path of the file to attach is required.' };
      const attacher = service as Partial<BrowserFileAttach>;
      if (typeof attacher.attachFile !== 'function') return { ok: false, summary: 'not available', error: "Attaching a file is only possible in the user's own browser (Chrome or Edge with the Eya extension)." };

      const found = await checkAttachment(raw);
      if (!found.ok) return found.result;
      const { path, name } = found;
      const info = { size: found.size };

      try {
        const page = await service.inspectPage();
        const app = policy.appForUrl(page.url);
        if (app === null) return notChatPage(page.url);
        if (openChatIsWrong(session, page)) {
          return { ok: false, summary: 'a different chat is open', error: `The chat that is open no longer shows the name of the chat that was chosen, so nothing was attached. Open the right chat again with find_chat.`, data: { status: 'wrong_chat' } };
        }
        // With no chat open, a file given to the page does not go to a chat: the app opens its own "Select chats" step. That step is share_file_to_chat's.
        const adapterHere = adapterFor(app.id);
        const composerHere = readComposer(adapterHere, page.inputs);
        if (adapterHere?.shareDialog !== undefined && composerHere !== null && !composerHere.present) {
          return {
            ok: false,
            summary: 'no chat is open',
            error: 'No chat is open, so there is no chat to attach the file to (the app would only open its own "Select chats" step). Use share_file_to_chat with the file and the person: it sends the file through that step, with the name or number typed there, and needs no chat opened first. Or open the chat with find_chat first.',
            data: { status: 'no_chat_open', use: 'share_file_to_chat' },
          };
        }
        const who = describeRecipient(session);
        const chat = session.chat();
        // The same file to the same chat before? If it is not known whether that one went, the person is told, and the chat can be looked at (verify_sent,
        // recheck) before anything is attached: a file is never sent again on a guess.
        const earlier = chat === null ? null : session.lastSend(chat.label, name);
        const repeat =
          earlier === null || earlier.status === 'failed'
            ? ''
            : earlier.status === 'sent'
              ? ' This same file was already sent to this chat a little while ago.'
              : ' An earlier send of this same file to this chat was not confirmed either way: it may already be there (verify_sent with recheck true looks in the chat).';
        const question = `${who.text}. Send the file "${name}" to this chat?${repeat}`;

        if (args['confirm'] !== true) {
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `Nothing was attached or sent. Ask the user exactly this and wait for a clear yes: "${question}" Only if they say yes, call attach_file again with confirm: true.`,
            data: { ...permissionRequest('send_file_to_chat', `${name} → ${chat?.label ?? 'this chat'}`, question), question, file: name, sizeBytes: info.size, chatKnown: who.known },
          };
        }

        session.authorize({ chat: chat?.label ?? '', file: name });
        const prefer = args['as'] === 'document' || args['as'] === 'media' ? args['as'] : 'auto';
        const result: AttachFileResult = await attacher.attachFile({ name, mime: mimeFor(name), size: info.size, read: (o, l) => files.read(path, o, l), prefer });
        if (!result.ok) {
          return {
            ok: false,
            summary: result.reason === 'no_file_input' ? 'no file picker yet' : 'could not attach',
            error: result.message,
            data: { status: 'not_attached', reason: result.reason },
          };
        }
        const shown = await confirmAttachment(name);
        if (shown === null) {
          return {
            ok: false,
            summary: 'could not confirm the attachment',
            error: `I gave the page "${name}", but it never showed that it took it (no preview or file name appeared). Do not click Send. Look at the page (inspect_page) and try again, or tell the user.`,
            data: { status: 'not_confirmed', file: name },
          };
        }
        session.attached(name, shown.shown);
        session.markBaseline(shown.marks); // delivery marks that are already there say nothing about this send
        return {
          ok: true,
          summary: `attached ${name} (not sent yet)`,
          data: {
            status: 'attached_not_sent',
            file: name,
            sizeBytes: info.size,
            chat: chat?.label ?? null,
            shownAs: shown.shown,
            next: "It is NOT sent. Click the app's Send button with click_on_page (it goes ahead, the user already said yes), then call verify_sent. Do not say it was sent until verify_sent says so.",
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'could not attach', error: `I could not attach that: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  // --------------------------------------------------------------------------------------------------- verify_sent
  const verifySent: Tool = {
    schema: {
      name: 'verify_sent',
      status: 'Checking it went through…',
      description:
        'After clicking Send in a chat app, check that the message or file REALLY went: the app shows it in the conversation with a delivery mark (sent, delivered, read), and no failure. ' +
        'Clicking Send is not proof. Call it right after the click; it waits up to about eight seconds. Say "sent" only if it returns status "sent"; for "pending", "failed", "unconfirmed" or ' +
        '"not_found", tell the user exactly that. For a message pass its text; for a file it uses the file just attached (or pass name).',
      args: {
        text: { type: 'string', description: 'The message text that was sent (its first words are enough).' },
        name: { type: 'string', description: 'The file name that was sent (default: the file just attached).' },
        recheck: { type: 'boolean', description: 'true to look again at a send whose outcome was not clear: it says whether this very thing is in the chat now, with no new mark required.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const recheck = args['recheck'] === true;
      const text = stringArg(args, 'text');
      const fileName = stringArg(args, 'name') ?? (text === undefined ? (session.lastSent() ?? session.attachment() ?? undefined) : undefined);
      if (text === undefined && fileName === undefined) {
        return { ok: false, summary: 'nothing to check', error: 'Say what was sent: the message text, or the file name.' };
      }
      // (searched for without emoji: the page draws an emoji as a picture, so a message sent as "Hi! 😊 How are you?" is shown as "Hi! How are you?" — the first sixty letters
      // of the plain words are what is looked for; a message that is only emoji is looked for as it is)
      const plain = (fileName ?? (text as string))
        .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Cf}|\p{Variation_Selector}/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      const needle = (fileName ?? (text as string)).slice(0, 60);
      const plainNeedle = (plain.length >= 3 ? plain : needle).slice(0, 60);
      // A delivery mark that was already on screen before the send says nothing about this message: only a mark that is new counts.
      const baseline = recheck ? null : session.baseline();
      const newestNew = (snap: PageSnapshot): string | null => {
        const marks = snap.messageStatus ?? [];
        const unchanged = baseline !== null && marks.length === baseline.length && marks.every((m, i) => m === baseline[i]);
        return marks.length > 0 && !unchanged ? (marks[marks.length - 1] as string) : null;
      };
      // What is known about this send is kept, so that it is looked at (not repeated) the next time the same thing is asked for.
      const sentKey = fileName ?? (text as string);
      const note = (status: 'sent' | 'failed' | 'uncertain'): void => {
        const open = session.chat();
        if (open !== null) session.noteSend(open.label, sentKey, status);
      };
      // Once checked, everything about this send is forgotten — except the marks now on screen, which are what the NEXT send is compared with.
      const finished = (snap: PageSnapshot): void => {
        session.spent();
        session.markBaseline(snap.messageStatus ?? []);
      };
      try {
        let last: PageSnapshot | null = null;
        let sawEvidence = false;
        // Looking costs about 10 ms, so look often: a message usually shows its first delivery mark within a fraction of a second, and
        // waiting 700 ms between looks added most of that to every send. (Same ceiling as before: about eight seconds.)
        for (let attempt = 0; attempt < 32; attempt += 1) {
          if (attempt > 0) await sleep(250);
          const snap = await service.inspectPage();
          last = snap;
          if (policy.appForUrl(snap.url) === null) return notChatPage(snap.url);
          const latest = newestNew(snap);
          if (latest !== null && STATUS_FAILED.has(latest)) {
            finished(snap);
            note('failed');
            return { ok: false, summary: 'it failed to send', error: `The app shows "${latest}" next to the latest message: it did NOT go. Tell the user it failed.`, data: { status: 'failed', mark: latest } };
          }
          const stillInPreview = fileName !== undefined && previewShows(snap, fileName);
          if (stillInPreview) continue; // Send has not gone through yet: the preview is still open
          let found = await service.findOnPage(needle);
          sawEvidence = found.matches.length > 0 || found.textMatches.length > 0;
          if (!sawEvidence && plainNeedle !== needle) {
            // (the page may show the emoji as pictures: the same words without them)
            found = await service.findOnPage(plainNeedle);
            sawEvidence = found.matches.length > 0 || found.textMatches.length > 0;
          }
          if (!sawEvidence && fileName !== undefined && leadPhrase(fileName) !== '') {
            // The sent file's bubble may show a long name cut short: look for the start of it too.
            found = await service.findOnPage(leadPhrase(fileName));
            sawEvidence = found.matches.length > 0 || found.textMatches.length > 0;
          }
          if (sawEvidence && latest !== null && STATUS_SENT.has(latest)) {
            const chatNow = session.chat();
            const app = policy.appForUrl(snap.url);
            note('sent');
            finished(snap);
            const offer = chatNow !== null && app !== null ? (deps.names?.offerConsent?.(app.id, chatNow.label) ?? null) : null;
            return {
              ok: true,
              summary: 'it was sent',
              data: {
                status: 'sent',
                mark: latest,
                ...(fileName !== undefined ? { file: fileName } : {}),
                ...(offer !== null ? { alsoAsk: offer, next: 'Tell the user it was sent. Then ask them exactly what alsoAsk says, and when they answer call quick_command (it reads their answer).' } : {}),
              },
            };
          }
        }
        const latest = last === null ? null : newestNew(last);
        // Not seen to have gone: it may still have, so what is said is uncertain, and the same thing is looked for in the chat before it is sent again.
        note('uncertain');
        if (!sawEvidence) {
          if (recheck) note('failed'); // looked for on purpose, and not in the chat: the earlier send did not go, so sending it is not a repeat
          return {
            ok: false,
            summary: 'not in the chat',
            error: `I do not see ${fileName !== undefined ? `"${fileName}"` : 'that message'} in the conversation after clicking Send, so I cannot say it was sent. Look at the page and tell the user honestly.`,
            data: { status: 'not_found' },
          };
        }
        if (latest !== null && STATUS_PENDING.has(latest)) {
          return { ok: false, summary: 'still sending', error: `It is in the chat but the app still shows "${latest}". It has not been confirmed as sent; say so, and check again in a moment.`, data: { status: 'pending', mark: latest } };
        }
        return {
          ok: false,
          summary: 'could not confirm',
          error: 'It appears in the chat, but no NEW delivery mark (sent, delivered…) has shown up that I can read, so I cannot confirm it was sent. Say exactly that — do not say it was sent.',
          data: { status: 'unconfirmed' },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'could not check', error: `I could not check: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  // ------------------------------------------------------------------------------------------ share_file_to_chat
  /** Looks at the page until it shows the app's "who to send it to" popup (each look costs about 10 ms). Null when it never comes. */
  async function waitForPicker(adapter: ChatPlatformAdapter, attempts = 24): Promise<PageSnapshot | null> {
    for (let i = 0; i < attempts; i += 1) {
      const page = await service.inspectPage();
      if (shareDialogOpen(adapter, page)) return page;
      await sleep(250);
    }
    return null;
  }

  /**
   * Gets the page to the app's home screen — no popup, no chat open — which is where a file given to the page opens the "Select chats" step (with a chat open it
   * would go to THAT chat's own attach step instead). A popup is closed; an open chat is closed with Escape, and if that does not close it, the page is loaded again.
   */
  async function toHomeScreen(adapter: ChatPlatformAdapter, page: PageSnapshot): Promise<{ readonly page: PageSnapshot } | { readonly failed: ToolResult }> {
    let current = await dismissPicker(adapter, page);
    if (shareDialogOpen(adapter, current)) {
      return { failed: { ok: false, summary: 'the picker would not close', error: 'The "Select chats" step is still open and would not close, so nothing was sent.', data: { status: 'picker_stuck' } } };
    }
    const chatOpen = (): boolean => readComposer(adapter, current.inputs)?.present === true;
    if (chatOpen()) {
      const presser = service as Partial<BrowserKeyPress>;
      if (typeof presser.pressEscape === 'function') {
        try {
          await presser.pressEscape();
        } catch {
          // reloaded below
        }
        await sleep(400);
        current = await service.inspectPage();
      }
      if (chatOpen()) {
        // Escape did not close it (an older extension, or the app kept it): loading the page again starts from the home screen.
        try {
          await service.reload();
        } catch {
          // looked at below
        }
        for (let i = 0; i < 40; i += 1) {
          await sleep(500);
          try {
            current = await service.inspectPage();
          } catch {
            continue;
          }
          if (chatAppState(current, adapter) === 'ready' && !chatOpen()) break;
        }
      }
      if (chatOpen()) {
        return { failed: { ok: false, summary: 'a chat stays open', error: 'A chat is open and would not close, so the file was not given to the page (it would go to that chat). Nothing was sent.', data: { status: 'chat_stays_open' } } };
      }
    }
    return { page: current };
  }

  const shareFile: Tool = {
    schema: {
      name: 'share_file_to_chat',
      status: 'Sending the file through the chat picker…',
      description:
        "Send a file to a person through the chat app's own \"Select chats\" step (WhatsApp Web), the way a person does it when they have the file ready: the file is given to the page, the person's name or number " +
        "is typed in that step's own search box, they are ticked, and Send is pressed — no chat has to be opened first (use this, not find_chat + attach_file, to send a file in WhatsApp). " +
        'Pass the file path and the person exactly as the user said them (a name, or a phone number). It answers with one of: "ambiguous" (several people fit: read the names to the user, ask which, then call again with choice); ' +
        '"none" (nobody matches: say so, ask for another spelling or the number, never guess and never make up a number); a question to ask the user word for word (call again with confirm true only after a clear yes, or with cancel true after a no); ' +
        'or the result of sending, checked in the chat afterwards: say it was sent ONLY when status is "sent" (the mark tells how far: sent, delivered or read); for pending, failed, unconfirmed or not_found say exactly that. ' +
        "Pass authorized true when the user's own words asked for this file to go to this person: then, if the person is identified by an exact name or a whole phone number, it is sent at once without asking again; a likely match still asks first. " +
        'Works only in a chat app the user has allowed.',
      args: {
        path: { type: 'string', description: 'The full path of the file on this PC (from find_file or the user).' },
        to: { type: 'string', description: 'The person as the user said it: a name (full, first, last, part) or a phone number.' },
        choice: { type: 'number', description: 'The number of a candidate from an earlier "ambiguous" result, after the user chose.' },
        authorized: { type: 'boolean', description: "true only when the user's own request was to send this file to this person (not your guess)." },
        confirm: { type: 'boolean', description: 'true ONLY after the user clearly said yes to the question this tool returned.' },
        cancel: { type: 'boolean', description: 'true to close the step without sending (the user said no, or changed their mind).' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const fail = (summary: string, error: string, status: string, extra: Record<string, unknown> = {}): ToolResult => ({ ok: false, summary, error, data: { status, ...extra } });
      const attacher = service as Partial<BrowserFileAttach>;
      const clicker = service as Partial<BrowserItemClicker>;
      try {
        const first = await service.inspectPage(); // refused here (CommunicationAccessError) when the chat app is switched off
        const app = policy.appForUrl(first.url);
        if (app === null) return notChatPage(first.url);
        const adapter = adapterFor(app.id);
        const share = adapter?.shareDialog;
        if (adapter === undefined || share === undefined) {
          return fail('not available', `${app.name} has no "Select chats" step that I know how to use. Open the chat with find_chat and use attach_file instead.`, 'not_available');
        }
        if (args['cancel'] === true) {
          await dismissPicker(adapter, first);
          session.shareDone();
          return { ok: true, summary: 'closed the picker', data: { status: 'cancelled', note: 'Nothing was sent.' } };
        }
        const raw = stringArg(args, 'path');
        if (raw === undefined) return fail('no file', 'The path of the file to send is required.', 'no_file');
        if (typeof attacher.attachFile !== 'function' || typeof lister.listItems !== 'function' || typeof clicker.clickItem !== 'function') {
          return fail('not available', "Sending a file through the chat picker is only possible in the user's own browser (Chrome or Edge with the Eya extension).", 'not_available');
        }
        const file = await checkAttachment(raw);
        if (!file.ok) return file.result;
        const to = stringArg(args, 'to');
        const choice = typeof args['choice'] === 'number' && Number.isFinite(args['choice']) ? Math.trunc(args['choice']) : undefined;
        if (to === undefined && choice === undefined) return fail('no one named', 'Say who the file is for: a name or a phone number.', 'no_recipient');
        const appState = chatAppState(first, adapter);
        if (appState === 'login') return { ok: true, summary: 'log-in needed', data: { status: 'needs_login', hint: 'The chat app is asking the user to log in (a QR code). They must do that themselves; wait for them.' } };
        if (appState === 'loading') return { ok: true, summary: 'still loading', data: { status: 'loading', hint: 'The chat app has not finished loading its chats. Wait a few seconds and look again.' } };

        // 1. The file is waiting in the picker (given to the page once; asked again, the same file waiting there is not given again).
        let page = first;
        if (!(shareDialogOpen(adapter, page) && session.queuedShare() === file.name)) {
          const home = await toHomeScreen(adapter, page);
          if ('failed' in home) return home.failed;
          const given = await attacher.attachFile({ name: file.name, mime: mimeFor(file.name), size: file.size, read: (o, l) => files.read(file.path, o, l), prefer: 'document' });
          if (!given.ok) {
            return fail(given.reason === 'no_file_input' ? 'no file picker yet' : 'could not give the file', given.message, 'not_attached', { reason: given.reason });
          }
          session.shareQueued(file.name);
          const shown = await waitForPicker(adapter);
          if (shown === null) {
            session.shareDone();
            return fail('the picker did not open', `I gave the page "${file.name}" but its "Select chats" step never opened, so nothing was sent. Do not click Send; look at the page.`, 'picker_not_shown');
          }
          page = shown;
        }

        // 2. Who. An exact name or a whole number identifies a person; anything else is a likely match, and is said to be one.
        let chosen: { label: string; item: PageItem; verified: boolean; evidence: string; how: string };
        if (choice !== undefined) {
          const picked = session.pick(choice);
          if (picked === null) return fail('no such choice', 'That number is not one of the people offered. Call share_file_to_chat with the name again.', 'no_such_choice');
          const rows = toPickerRows((await lister.listItems()) ?? []);
          const row = rows.find((r) => normalizeText(r.label) === normalizeText(picked.label));
          if (row === undefined) return fail('person not showing', `"${picked.label}" is not in the list that is showing. Call share_file_to_chat with the name again.`, 'person_not_showing');
          chosen = { label: picked.label, item: row.item, verified: true, evidence: 'the user chose it', how: 'the choice the user made' };
        } else {
          const wanted = to as string;
          const parsed = parseChatQuery(wanted);
          if (parsed.names.length === 0 && parsed.digits.length < 2) return fail('no name', 'I need a name, or at least two digits of the number, to look for.', 'no_name');
          const reference = readRecipientReference(wanted, countryNow());
          const numberPhone = reference.kind === 'name' || reference.kind === 'context' ? undefined : reference.phone;
          const typed = numberPhone !== undefined ? digitsToSearch(numberPhone, 'national') : parsed.names.length > 0 ? parsed.names.join(' ') : parsed.digits;
          const listBefore = namesKey((await lister.listItems()) ?? []);
          const filled = await service.fillOnPage(share.searchLabel, typed);
          if (!filled.ok) return fail('could not search', 'I could not type into the picker\'s search box, so nothing was sent.', 'search_failed');
          let rows = toPickerRows(await listWhenSettled(lister, sleep, listBefore));
          if (numberPhone !== undefined) {
            // A phone number: if its national digits show nobody, the number is searched once more with its country code; then the recipient resolver decides.
            if (rows.length === 0 && (numberPhone.kind === 'international' || numberPhone.kind === 'national') && numberPhone.e164 !== numberPhone.national) {
              const again = namesKey((await lister.listItems()) ?? []);
              const refilled = await service.fillOnPage(share.searchLabel, digitsToSearch(numberPhone, 'whole'));
              if (refilled.ok) rows = toPickerRows(await listWhenSettled(lister, sleep, again));
            }
            const decision = decideByNumber(reference, rows, true, adapter?.name ?? 'the app');
            if (decision.kind === 'stop') return decision.result;
            chosen = { label: decision.row.label, item: decision.row.item, verified: decision.verified, evidence: decision.evidence, how: decision.how };
          } else if (parsed.names.length === 0) {
            if (rows.length === 0) return { ok: true, summary: 'no one found', data: { status: 'none', hint: 'Nobody in the picker matches those digits. Ask the user for the name instead. Do not guess or make up a number.' } };
            const basis = parsed.digits.length >= 10 ? { verified: true, evidence: 'full phone number' } : { verified: false, evidence: 'part of the number' };
            if (rows.length > 1) {
              return ambiguousResult(rows.map((r) => ({ candidate: r, strength: 'strong', reason: 'phone number', score: 0, evidence: 'part of the number', verified: false }) as ChatMatch<(typeof rows)[number]>), "the app's own search on those digits");
            }
            const only = rows[0] as (typeof rows)[number];
            chosen = { label: only.label, item: only.item, ...basis, how: "the app's own search on those digits" };
          } else {
            let resolution = resolveChat(wanted, rows, { recent: session.recent() });
            if (resolution.kind === 'none') {
              // (a search can be answered late: looked at once more before saying there is nobody)
              await sleep(400);
              rows = toPickerRows(await listWhenSettled(lister, sleep, namesKey([])));
              resolution = resolveChat(wanted, rows, { recent: session.recent() });
            }
            if (resolution.kind === 'none') {
              return { ok: true, summary: 'no one found', data: { status: 'none', hint: 'Nobody in the picker matches that name. Say so; ask for another spelling or the number. Do not guess, and never make up a phone number.' } };
            }
            if (resolution.kind === 'ambiguous') return ambiguousResult(resolution.matches, 'name');
            const m = resolution.match;
            chosen = {
              label: m.candidate.label,
              item: m.candidate.item,
              verified: m.verified && resolution.viaRecent !== true,
              evidence: resolution.viaRecent === true ? 'used earlier in this conversation' : m.evidence,
              how: m.reason,
            };
          }
        }
        const isChosen = (name: string): boolean => {
          const n = normalizeText(name);
          const l = normalizeText(chosen.label);
          return n === l || n.startsWith(`${l} `);
        };
        const pickerNow = async (): Promise<{ readonly ticked: PageItem[]; readonly sendShowing: boolean }> => {
          const items = (await lister.listItems?.()) ?? [];
          return { ticked: items.filter((i) => i.role === 'checkbox' && i.region === 'dialog' && i.checked === true), sendShowing: items.some((i) => i.region === 'dialog' && i.role === 'button' && normalizeText(i.name) === normalizeText(share.sendLabel)) };
        };
        const tickedNow = async (): Promise<PageItem[]> => (await pickerNow()).ticked;

        // 3. Tick that person, and nobody else (the page is looked at: a click that was made is not a person who is ticked). The picker's Send only shows once
        // somebody is ticked, so a Send showing while the person listed is not ticked means somebody else (out of sight, filtered out by the search) is.
        const start = await pickerNow();
        const already = start.ticked;
        if (already.some((t) => !isChosen(t.name)) || (start.sendShowing && already.length === 0)) {
          await dismissPicker(adapter, page);
          return fail('someone else was ticked', 'Another person was already ticked in the picker, so nothing was sent and the picker was closed. Start again.', 'stale_selection');
        }
        if (already.length === 0) {
          const settledOn = async (): Promise<PageItem[]> => {
            for (let i = 0; i < 4; i += 1) {
              await sleep(150);
              const t = await tickedNow();
              if (t.length > 0) return t;
            }
            return [];
          };
          await clicker.clickItem({ primary: chosen.item.primary ?? chosen.label, name: chosen.item.name, region: 'dialog' });
          let ticked = await settledOn();
          if (ticked.length === 0) {
            // The row itself did not tick: its own tick box is what is pressed.
            await clicker.clickItem({ primary: chosen.label, region: 'dialog', role: 'checkbox' });
            ticked = await settledOn();
          }
          // (the same person can be listed twice, under "Chats" and under "Contacts": every tick box that is ticked must be theirs, and one at least)
          if (!(ticked.length > 0 && ticked.every((t) => isChosen(t.name)))) {
            await dismissPicker(adapter, page);
            return fail('could not tick the person', `I could not tick ${chosen.label} in the picker (${ticked.length === 0 ? "nobody got ticked" : "someone else got ticked"}), so nothing was sent and the picker was closed.`, 'not_selected');
          }
        }

        // 4. Who it goes to, and whether the person has to say yes: an exact name or a whole number, asked for in so many words by the user, goes straight away.
        const earlier = session.lastSend(chosen.label, file.name);
        const repeat =
          earlier === null || earlier.status === 'failed'
            ? ''
            : earlier.status === 'sent'
              ? ' This same file was already sent to this person a little while ago.'
              : ' An earlier send of this same file to this person was not confirmed either way: it may already be in their chat.';
        const unsure = chosen.verified ? '' : ` (${weakMatchNote(chosen.evidence, to ?? chosen.label)})`;
        const question = `Found ${chosen.label}${unsure}. Send the file "${file.name}" to ${chosen.label}?${repeat}`;
        const goAhead = args['confirm'] === true || (args['authorized'] === true && chosen.verified && repeat === '');
        if (!goAhead) {
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `Nothing was sent; ${chosen.label} is ticked in the picker. Ask the user exactly this and wait for a clear yes: "${question}" Only if they say yes, call share_file_to_chat again with confirm: true (the same file and person). If they say no, call it with cancel: true.`,
            data: { ...permissionRequest('send_file_to_chat', `${file.name} → ${chosen.label}`, question), status: 'ready_to_send', question, file: file.name, recipient: chosen.label, verified: chosen.verified, evidence: chosen.evidence },
          };
        }

        // 5. Send. What is known is kept BEFORE the click (it was begun), so a result that is not clear is looked at, never sent again on a guess.
        session.noteSend(chosen.label, file.name, 'attempted');
        const pressed = await service.clickOnPage(share.sendLabel);
        if (!pressed.ok) {
          session.noteSend(chosen.label, file.name, 'failed');
          return fail('could not press Send', `I could not press Send in the picker, so the file was not sent to ${chosen.label}.`, 'send_failed');
        }
        session.shareDone();

        // 6. The app opens the chat of the person it was sent to: waited for, named by the page itself, and then looked at for the file and its delivery mark.
        let after: PageSnapshot = pressed.snapshot;
        for (let i = 0; i < 24; i += 1) {
          if (!shareDialogOpen(adapter, after) && readComposer(adapter, after.inputs)?.present === true) break;
          await sleep(300);
          after = await service.inspectPage();
        }
        const conversation = conversationState(after, chosen.label, [], adapter);
        session.openedChat({ app: app.name, label: chosen.label, verified: chosen.verified, headerChecked: conversation === 'yes', ...(conversation === 'yes' ? { proof: 'composer' as const } : {}), matchedBy: chosen.evidence });
        // (the marks showing when that chat comes up are what a mark that appears afterwards is told apart from)
        session.markBaseline(after.messageStatus ?? []);
        if (appStillPicker(adapter, after)) {
          session.noteSend(chosen.label, file.name, 'uncertain');
          return fail('the picker is still open', `I pressed Send, but the picker is still open, so I cannot say the file went to ${chosen.label}. I will not send it again without looking at the chat first.`, 'send_not_seen', { recipient: chosen.label });
        }
        if (conversation === 'wrong') {
          session.noteSend(chosen.label, file.name, 'uncertain');
          return fail('a different chat opened', 'After Send the app opened a different chat from the one chosen, so I cannot say who has the file. Look at the page and tell the user honestly.', 'wrong_chat', { recipient: chosen.label });
        }
        const checked = await verifySent.execute({ name: file.name });
        return { ...checked, data: { ...(checked.data ?? {}), recipient: chosen.label, verifiedRecipient: chosen.verified, via: 'select_chats', ...(conversation === 'yes' ? {} : { note: "The chat that opened did not show the person's name in its message box, so who it is open with could not be double-checked." }) } };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'other';
        return { ok: false, summary: 'could not send', error: `I could not send that: ${err instanceof Error ? err.message : String(err)}`, data: { status: 'error', reason: code } };
      }
    },
  };

  function appStillPicker(adapter: ChatPlatformAdapter, page: PageSnapshot): boolean {
    return shareDialogOpen(adapter, page);
  }

  // ------------------------------------------------------------------------------------------------ learn_chat_names
  const MAX_LEARN_AT_ONCE = 60;
  const learnChatNames: Tool = {
    schema: {
      name: 'learn_chat_names',
      status: 'Remembering the chat names…',
      description:
        'Remember the NAMES of the chats showing in the open chat app (names only — never a message, preview, number or picture) so chats can be found instantly later. ' +
        'Use it ONLY when the user asked Eya to remember or learn their contacts or chat names. It works only after the user has agreed to Eya remembering chat names ' +
        '(they say so to Eya, or turn it on in Settings); no tool can turn that on, so if it says they have not agreed, tell them to say "remember my WhatsApp contacts". ' +
        'Returns how many names were new — not the names.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const names = deps.names;
      if (names === undefined || !names.learning()) {
        return {
          ok: false,
          summary: 'not agreed',
          error: 'The user has not agreed to Eya remembering chat names, so nothing was read. Tell them they can say "remember my WhatsApp contacts" to allow it.',
        };
      }
      const lister = service as Partial<BrowserItemLister>;
      if (typeof lister.listItems !== 'function') return { ok: false, summary: 'not available', error: 'Reading the chat list is not available in this browser window.' };
      try {
        const page = await service.inspectPage(); // refused here (CommunicationAccessError) when the chat app is switched off
        const app = policy.appForUrl(page.url);
        if (app === null) return notChatPage(page.url);
        // An earlier search leaves the list showing only its results: empty the search box so the whole list is what is read. (Best
        // effort — typing nothing in a search box harms nothing, and if it cannot be done the list is read as it is.)
        const searchBox = page.inputs.find((i) => SEARCH_FIELD.test(i));
        if (searchBox !== undefined) {
          try {
            await service.fillOnPage(searchBox, '');
            await sleep(400);
          } catch {
            // read what is showing
          }
        }
        // Only list rows with a title line, and only names that read as names; the book checks again and keeps nothing else.
        const labels = toCandidates(await lister.listItems())
          .filter((c) => c.item.primary !== undefined)
          .map((c) => c.label)
          .slice(0, MAX_LEARN_AT_ONCE);
        const added = names.learn(app.id, labels);
        return { ok: true, summary: `learned ${added} chat name${added === 1 ? '' : 's'}`, data: { status: 'learned', app: app.name, appId: app.id, learned: added, seen: labels.length } };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'could not read', error: `I could not read the chat names: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  // ---------------------------------------------------------------------------------------------------- find_chat_files
  const rowsKey = (rows: readonly DocRow[]): string => rows.map((r) => `${r.file}\u0001${r.whenText}\u0001${r.sender}`).join('\u0002');
  const MAX_LIST_SLICES = 4;

  /** The text of the whole page (a few slices), read through. */
  async function pageTextRead(): Promise<string> {
    let text = '';
    let offset: number | undefined;
    for (let slice = 0; slice < MAX_LIST_SLICES; slice += 1) {
      const read = await service.readPage(offset);
      text += `${read.text}\n`;
      if (read.nextOffset === null) break;
      offset = read.nextOffset;
    }
    return text;
  }

  /**
   * The document rows the list shows once it has settled: read again and again (each look is cheap) until two looks in a row agree. The list's own search
   * answers late and not always completely, so what it shows is only ever a starting point: the rows are judged here.
   */
  async function docRowsWhenSettled(): Promise<DocRow[]> {
    let last = parseDocRows(await pageTextRead(), new Date(now()));
    let unchanged = 0;
    for (let polls = 1; polls < 24 && unchanged < 2; polls += 1) {
      await sleep(150);
      const next = parseDocRows(await pageTextRead(), new Date(now()));
      unchanged = rowsKey(next) === rowsKey(last) ? unchanged + 1 : 0;
      last = next;
    }
    return last;
  }

  /** Looks (a few times) for the app's file list being open: its own search box is there only while it is. */
  async function fileListOpen(search: RegExp): Promise<PageSnapshot | null> {
    for (let look = 0; look < 14; look += 1) {
      const page = await service.inspectPage();
      if (page.inputs.some((i) => search.test(i.trim()))) return page;
      await sleep(200);
    }
    return null;
  }

  /** Closes the file list again (best effort: closing a list changes nothing in any chat). */
  async function closeFileList(cfg: NonNullable<ChatPlatformAdapter['fileSearch']>): Promise<void> {
    try {
      await service.clickOnPage(cfg.closeLabel);
    } catch {
      // left open: harmless
    }
  }

  const findChatFiles: Tool = {
    schema: {
      name: 'find_chat_files',
      status: 'Looking for that file in the chats…',
      description:
        "Find a file (document) that was sent in WhatsApp — one the user sent to someone, or someone sent them — and say where it is: its name, who sent it, when, and (for one file) which chat it is in. " +
        "It reads WhatsApp Web's own list of documents from all chats and judges the rows itself; it never hands you the list or any message. " +
        'Give the words of the file name ("resume", "bail petition"), and/or when ("last week", "yesterday", "in October", "3 days ago"), and/or who ("from Anna"), and direction "sent" for a file the user sent. ' +
        'When exactly one file fits, it opens that chat on the file (read-only: nothing is sent, changed or deleted). Only works while Communication Access is on for WhatsApp and the plugin may find files. ' +
        'If it finds several, tell the user and ask for more of the name or the day; never guess.',
      args: {
        file: { type: 'string', description: 'Words of the file name or what it is, e.g. "resume pdf", "fee receipt". Omit when the user gave only a time or a person.' },
        when: { type: 'string', description: 'When it was sent, in the user\'s words: "last week", "yesterday", "in October", "on 21/10/2026", "3 days ago".' },
        from: { type: 'string', description: 'The person who sent it, when the user said (a file the user received).' },
        direction: { type: 'string', enum: ['sent', 'received', 'any'], description: '"sent" = a file the user sent; "received" = one sent to the user; "any" (default).' },
        open: { type: 'boolean', description: 'Open the chat on the file when exactly one fits (default true). False only to look.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const lister = service as Partial<BrowserItemLister>;
      if (typeof lister.listItems !== 'function') return { ok: false, summary: 'not available', error: 'Finding a file in the chats is only possible in the user\'s own browser (Chrome or Edge with the Eya extension).' };
      const fileText = stringArg(args, 'file') ?? '';
      const whenText = stringArg(args, 'when');
      const fromText = stringArg(args, 'from');
      const direction = args['direction'] === 'sent' || args['direction'] === 'received' ? (args['direction'] as 'sent' | 'received') : 'any';
      const shouldOpen = args['open'] !== false;
      const asOf = new Date(now());
      const window = whenText !== undefined ? readTimeWindow(whenText, asOf) : null;
      if (whenText !== undefined && window === null) return { ok: false, summary: 'time not understood', error: `I could not tell when "${whenText}" is. Ask the user for a day, "last week", or a month.` };
      const words = fileWords(fileText);
      if (words.length === 0 && window === null && fromText === undefined && direction === 'any') {
        return { ok: false, summary: 'nothing to look for', error: 'I need some words of the file name, a time ("last week"), or a person, to look for the file.' };
      }
      try {
        const before = await service.inspectPage(); // refused here (CommunicationAccessError) when the chat app is switched off
        const app = policy.appForUrl(before.url);
        if (app === null) return notChatPage(before.url);
        const adapter = adapterFor(app.id);
        const cfg = adapter?.fileSearch;
        if (cfg === undefined) return { ok: true, summary: 'not supported', data: { status: 'unsupported', say: `I can only look for files in WhatsApp for now, not in ${app.name}.` } };
        const state = chatAppState(before, adapter);
        if (state !== 'ready') {
          return state === 'login'
            ? { ok: true, summary: 'log-in needed', data: { status: 'needs_login', say: `${app.name} is asking you to log in with a QR code. Scan it with your phone and ask me again.` } }
            : { ok: true, summary: 'still loading', data: { status: 'loading', say: `${app.name} has not finished loading its chats. Give it a few seconds and ask me again.` } };
        }
        // An open "Select chats" popup covers the page: close it first (nothing in it is sent).
        if (shareDialogOpen(adapter, before)) await dismissPicker(adapter, before);

        const typedWord = (): string | undefined => (fromText !== undefined && words.length === 0 ? fromText.split(/\s+/)[0] : [...words].sort((a, b) => b.length - a.length).find((w) => !/^(pdf|docx?|xlsx?|pptx?|txt|csv|zip|rar|apk)$/.test(w)));
        const open = async (): Promise<PageSnapshot | null> => {
          const already = before.inputs.some((i) => cfg.searchLabel.test(i.trim()));
          if (!already) {
            const click = await service.clickOnPage(cfg.openLabel);
            if (!click.ok) return null;
          }
          const page = await fileListOpen(cfg.searchLabel);
          if (page === null) return null;
          const tab = await service.clickOnPage(cfg.docsTab);
          return tab.ok ? page : null;
        };
        let page = await open();
        if (page === null) return { ok: false, summary: 'could not open the list', error: `I could not open ${app.name}'s list of documents, so I could not look. Nothing was changed.`, data: { status: 'error', reason: 'list_not_open' } };

        const query: FileQuery = { words, ...(fromText !== undefined ? { sender: fromText } : {}), direction, window };
        let searched = false;
        const term = typedWord();
        const box = page.inputs.find((i) => cfg.searchLabel.test(i.trim()));
        if (term !== undefined && box !== undefined) {
          await service.fillOnPage(box, term);
          searched = true;
        }
        let rows = await docRowsWhenSettled();
        let found = matchDocRows(rows, query);
        if (found.matches.length === 0 && searched) {
          // The list's own search is unreliable (it answers late, and not always with everything): look at the whole list instead, and judge the rows here.
          await closeFileList(cfg);
          await sleep(300);
          page = await open();
          if (page === null) return { ok: false, summary: 'could not open the list', error: `I could not open ${app.name}'s list of documents again, so I could not look any further.`, data: { status: 'error', reason: 'list_not_open' } };
          rows = await docRowsWhenSettled();
          found = matchDocRows(rows, query);
        }

        const dated = rows.filter((r) => r.when !== null);
        const oldestRow = dated.length === 0 ? null : dated.reduce((a, b) => ((a.when as Date).getTime() <= (b.when as Date).getTime() ? a : b));
        const reachedBack = window === null || (oldestRow !== null && (oldestRow.when as Date).getTime() <= window.from.getTime());
        const files = [...found.matches].sort((a, b) => (b.when?.getTime() ?? 0) - (a.when?.getTime() ?? 0));

        // One file: the chat it is in is found out by opening the chat at its message (read-only: only "Go to message" is ever pressed).
        let chat: string | null = null;
        let notLocated: 'copies' | 'no_menu' | 'no_chat' | null = null;
        let copies = files.length === 1 ? rows.filter((r) => normalizeText(r.file) === normalizeText((files[0] as DocRow).file)).length : 0;
        if (files.length === 1 && shouldOpen && copies <= 1) {
          const only = files[0] as DocRow;
          // The list is narrowed to this one file, so that ONE row (and one menu button) is left to choose; if it cannot be narrowed to exactly it, nothing is guessed.
          const listBox = (await service.inspectPage()).inputs.find((i) => cfg.searchLabel.test(i.trim()));
          if (listBox !== undefined) await service.fillOnPage(listBox, only.file);
          const narrowed = await docRowsWhenSettled();
          const same = narrowed.filter((r) => normalizeText(r.file) === normalizeText(only.file));
          copies = Math.max(copies, same.length);
          if (same.length > 1) notLocated = 'copies';
          else if (same.length === 0 || narrowed.length !== 1) notLocated = 'no_menu';
          else {
            // (on the real page the row's menu button is named only "Message's context menu", and sits in the list's own panel)
            const clicker = service as Partial<BrowserItemClicker>;
            const menu =
              typeof clicker.clickItem === 'function'
                ? await clicker.clickItem({ name: cfg.menuLabel, region: 'dialog', role: 'button' })
                : await service.clickOnPage(cfg.menuLabel);
            const entries = menu.ok ? ((await lister.listItems()) ?? []) : [];
            // Only an entry named exactly "Go to message" is ever pressed (the same menu holds Forward, Star and Delete).
            const goto = entries.find((i) => normalizeText(i.name) === normalizeText(cfg.gotoLabel));
            if (goto === undefined) {
              notLocated = 'no_menu';
              try {
                await (service as Partial<BrowserKeyPress>).pressEscape?.();
              } catch {
                // the menu closes by itself
              }
            } else {
              // (a chat that is already open names itself in the message box until the new one replaces it, so the name read first is not taken for the answer)
              const earlier = readComposer(adapter, (await service.inspectPage()).inputs)?.target ?? null;
              const go = await service.clickOnPage(goto.name);
              if (!go.ok) notLocated = 'no_menu';
              else {
                let opened = await service.inspectPage();
                for (let look = 0; look < 10; look += 1) {
                  await sleep(250);
                  opened = await service.inspectPage();
                  const now = readComposer(adapter, opened.inputs);
                  if (now?.present === true && now.target !== null && now.target !== earlier) break;
                }
                // the list's panel may still cover the page: closed, so that what is looked for is the chat's own message
                if (opened.inputs.some((i) => cfg.searchLabel.test(i.trim()))) {
                  await closeFileList(cfg);
                  await sleep(300);
                  opened = await service.inspectPage();
                }
                const target = readComposer(adapter, opened.inputs)?.target ?? null;
                let seen = false;
                try {
                  const looked = await service.findOnPage(only.file);
                  seen = looked.textMatches.length > 0 || looked.matches.length > 0;
                } catch {
                  seen = false;
                }
                // the chat is named only when the page shows it: the message box names a chat that is not the one that was open before, or the file's message is in view
                if (target !== null && (target !== earlier || seen)) chat = maskNumbersIn(target).slice(0, 80);
                else notLocated = 'no_chat';
              }
            }
          }
        } else if (files.length === 1 && shouldOpen) {
          notLocated = 'copies';
        }
        if (chat === null) await closeFileList(cfg); // the list is left open only when its chat was opened from it (the app closes it then)

        const say = sayFileFindings({ appName: app.name, files, asked: words.join(' '), window, chat, notLocated, copies, reachedBack, oldest: oldestRow?.whenText ?? null, undated: found.undated });
        return {
          ok: true,
          summary: files.length === 0 ? 'no file found' : files.length === 1 ? 'found the file' : `found ${files.length} files`,
          data: {
            status: files.length === 0 ? 'none' : 'found',
            say,
            count: files.length,
            scanned: rows.length,
            reachedBack,
            ...(window !== null ? { window: window.label } : {}),
            files: files.slice(0, 5).map((f) => ({ file: f.file, type: f.type, size: f.size, sentBy: f.mine ? 'you' : f.sender, when: f.whenText })),
            ...(chat !== null ? { chat, located: true } : { located: false }),
            ...(notLocated !== null ? { notLocated } : {}),
          },
        };
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        const code = typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : 'other';
        return { ok: false, summary: 'could not look', error: `I could not look for that file: ${err instanceof Error ? err.message : String(err)}`, data: { status: 'error', reason: code } };
      }
    },
  };

  return [findChat, attachFile, shareFile, verifySent, learnChatNames, findChatFiles];
}

/**
 * Whether the chat with this name is the one OPEN on the page, from what the page itself shows (its message box names the chat, or its header does):
 *   yes — shown open · wrong — the message box names a different chat · no — no chat is open · unknown — the page does not say.
 * The chat that find_chat opened is remembered with how its message box names it (a chat the page writes as a phone number is still that chat).
 */
export function chatOpenState(session: ChatSession, page: PageSnapshot, label: string): Conversation {
  const chat = session.chat();
  const same = chat !== null && normalizeText(chat.label) === normalizeText(label);
  const adapter = adapterByName(chat?.app) ?? ADAPTERS.whatsapp;
  const composer = readComposer(adapter, page.inputs);
  if (composer !== null && composer.present && composer.target !== null) {
    const as = same ? chat.composerAs : undefined;
    return sameTarget(composer.target, label) || (as !== undefined && sameTarget(composer.target, as)) ? 'yes' : 'wrong';
  }
  return conversationState(page, label, same ? (chat.confusableWith ?? []) : [], adapter);
}
