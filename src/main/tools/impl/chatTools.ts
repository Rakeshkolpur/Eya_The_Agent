import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type {
  AttachFileResult,
  BrowserAutomationService,
  BrowserFileAttach,
  BrowserItemLister,
  PageItem,
} from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '@main/browser/errors';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { looksLikeControl, normalizeText, parseChatQuery, phoneEnding, resolveChat, soundsLike } from '@main/chat/contactMatch';
import type { ChatCandidate, ChatMatch } from '@main/chat/contactMatch';
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

const SEARCH_FIELD = /search|find|new chat|start (?:a )?(?:new )?chat|recipient|to:/i;
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

/** Is this name in the page's title, headings or open dialogs — i.e. in the place a chat's name is shown, not just the list. */
function headerMentions(snapshot: PageSnapshot, label: string): boolean {
  const want = normalizeText(label);
  return want !== '' && textOf([snapshot.title, ...snapshot.headings, ...snapshot.dialogs]).includes(want);
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
export function chatAppState(snapshot: {
  readonly inputs: readonly string[];
  readonly headings?: readonly string[];
  readonly visibleText?: string;
  readonly buttons?: readonly string[];
  readonly challenge?: { readonly kind: string };
}): 'ready' | 'login' | 'loading' {
  if (snapshot.inputs.some((i) => SEARCH_FIELD.test(i))) return 'ready';
  const words = [snapshot.visibleText ?? '', ...(snapshot.headings ?? []), ...(snapshot.buttons ?? [])].join(' ');
  if (snapshot.challenge?.kind === 'login' || /scan (?:the |this )?qr|log ?in to (?:whatsapp|telegram)|link with phone number|use whatsapp on your phone/i.test(words)) return 'login';
  return 'loading';
}

function toCandidates(items: readonly PageItem[]): Array<ChatCandidate & { readonly item: PageItem }> {
  const out: Array<ChatCandidate & { readonly item: PageItem }> = [];
  for (const item of items) {
    if (item.region === 'nav' || item.region === 'footer') continue;
    const label = (item.primary ?? item.name).trim();
    if (label === '' || label.length > 80 || looksLikeControl(label)) continue;
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
}

export interface ChatSendGate {
  /** A click on a control that would send, on a chat app's page; null when this is not that (use the ordinary rules). */
  forClick(page: PageSnapshot | null, target: { readonly name: string; readonly role?: string }): ChatSendDecision | null;
  /** Pressing Enter in a message box on a chat app's page. */
  forSubmit(page: PageSnapshot | null, fieldLabel: string): ChatSendDecision | null;
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

export function describeRecipient(session: ChatSession): { readonly text: string; readonly known: boolean } {
  const chat = session.chat();
  if (chat === null) return { text: "I can't tell who this chat is with", known: false };
  return { text: `Found ${chat.label}${chat.phoneEnding !== undefined ? `, number ending in ${chat.phoneEnding}` : ''}`, known: true };
}

export function createChatSendGate(session: ChatSession, policy: CommunicationPolicy): ChatSendGate {
  function decide(page: PageSnapshot | null): ChatSendDecision | null {
    if (page === null || policy.appForUrl(page.url) === null) return null; // not a chat app: the ordinary rules apply
    const who = describeRecipient(session);
    const chat = session.chat();
    const file = session.attachment();
    // The yes was for a file: it only still counts while that file can be seen waiting on the page (a cancelled preview does not count).
    // If the attach step could only tell that a preview had opened (not read the name), an open popup is the same evidence here.
    const waiting = file === null || fileShown(page, file) || (session.attachedAs() === 'preview_opened' && page.dialogs.length > 0);
    if (chat !== null && waiting && session.isAuthorized(chat.label, file ?? undefined)) return { reason: null, question: '' };
    const what = file === null ? 'this message' : waiting ? `the file "${file}"` : null;
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
  readonly service: BrowserAutomationService & Partial<BrowserItemLister> & Partial<BrowserFileAttach>;
  readonly policy: CommunicationPolicy;
  readonly session: ChatSession;
  readonly folders: KnownFolders;
  readonly files?: FileAccess;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The contact book, to learn names as chats are looked for and opened. Optional. */
  readonly names?: ChatNameSink;
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
  async function openFound(label: string, itemName: string, appName: string, how: string, known?: string, appId?: string): Promise<ToolResult> {
    const click = await service.clickOnPage(itemName); // opening a chat sends nothing
    if (!click.ok) {
      return { ok: false, summary: 'could not open the chat', error: `I found "${label}" but could not open it${'message' in click ? `: ${click.message}` : ''}.` };
    }
    const ending = phoneEndingNear(click.snapshot, label) ?? known ?? null;
    session.openedChat({ app: appName, label, ...(ending !== null ? { phoneEnding: ending } : {}) });
    if (appId !== undefined) deps.names?.used(appId, label);
    session.markBaseline(click.snapshot.messageStatus ?? []);
    const confirmed = headerMentions(click.snapshot, label);
    return {
      ok: true,
      summary: `opened the chat with ${label}`,
      data: {
        status: 'opened',
        chat: label,
        app: appName,
        ...(ending !== null ? { numberEndsIn: ending } : {}),
        matchedBy: how,
        headerChecked: confirmed,
        ...(confirmed ? {} : { note: "The chat is open, but I could not read the name in its header to double-check — say who it is going to when you ask for the go-ahead to send." }),
        next: 'To send a file: attach_file. To send a message: fill_on_page the message box, then click_on_page Send.',
      },
    };
  }

  function ambiguousResult(matches: ReadonlyArray<ChatMatch<ChatCandidate & { readonly item: PageItem }>>, how: string): ToolResult {
    const offered = session.offerChoices(matches.slice(0, 6).map((m) => ({ label: m.candidate.label, ...(m.phoneEnding !== undefined ? { phoneEnding: m.phoneEnding } : {}) })));
    return {
      ok: true,
      summary: `${matches.length} chats could be the one`,
      data: {
        status: 'ambiguous',
        candidates: offered,
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
      const lister = service as Partial<BrowserItemLister>;
      if (typeof lister.listItems !== 'function') return { ok: false, summary: 'not available', error: 'Finding a chat is not available in this browser window.' };
      try {
        const before = await service.inspectPage(); // refused here (CommunicationAccessError) when the chat app is switched off
        const app = policy.appForUrl(before.url);
        if (app === null) return notChatPage(before.url);

        if (choice !== undefined) {
          const picked = session.pick(choice);
          if (picked === null) return { ok: false, summary: 'no such choice', error: 'That number is not one of the chats offered. Call find_chat with the name again.' };
          const rows = toCandidates(await lister.listItems());
          const row = rows.find((r) => normalizeText(r.label) === normalizeText(picked.label));
          if (row === undefined) return { ok: false, summary: 'chat not showing', error: `"${picked.label}" is not in the list that is showing now. Call find_chat with the name again.` };
          return await openFound(picked.label, row.item.name, app.name, 'the choice the user made', picked.phoneEnding, app.id);
        }

        // A chat app that is still loading (its list is not there yet), or waiting for a log-in, is not "no such chat": say which, so the
        // caller can wait instead of giving up.
        const state = chatAppState(before);
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
        // Type it into the app's own search box so the list shows what fits; if there is no box, work from what is showing.
        const searchBox = before.inputs.find((i) => SEARCH_FIELD.test(i));
        let rows: ReturnType<typeof toCandidates>;
        if (searchBox !== undefined) {
          const listBefore = namesKey(await lister.listItems());
          await service.fillOnPage(searchBox, parsed.names.length > 0 ? parsed.names.join(' ') : parsed.digits);
          rows = toCandidates(await listWhenSettled(lister, sleep, listBefore));
        } else {
          rows = toCandidates(await lister.listItems());
        }

        if (parsed.names.length === 0) {
          // Digits only: a chat list does not show numbers, so the app's own search did the matching.
          if (rows.length === 0) return { ok: true, summary: 'no chat found', data: { status: 'none', hint: 'No chat matches those digits. Ask the user for the name instead.' } };
          const how = "the app's own search on those digits";
          if (rows.length === 1 && shouldOpen) return await openFound((rows[0] as (typeof rows)[number]).label, (rows[0] as (typeof rows)[number]).item.name, app.name, how, undefined, app.id);
          if (rows.length === 1) return { ok: true, summary: 'one chat matches', data: { status: 'found', chat: (rows[0] as (typeof rows)[number]).label, matchedBy: how } };
          return ambiguousResult(rows.map((r) => ({ candidate: r, strength: 'strong', reason: 'phone number', score: 0 }) as ChatMatch<(typeof rows)[number]>), how);
        }

        let resolution = resolveChat(wanted, rows, { recent: session.recent() });
        if (resolution.kind === 'none' && searchBox !== undefined) {
          // Nothing fits. A search can be answered late (the app asks its server, or it is busy), so look once more before saying so.
          await sleep(400);
          rows = toCandidates(await listWhenSettled(lister, sleep, namesKey([])));
          resolution = resolveChat(wanted, rows, { recent: session.recent() });
        }
        const heard = parsed.names.length === 1 ? (parsed.names[0] as string) : '';
        if (resolution.kind === 'none' && searchBox !== undefined && heard.length >= 3) {
          // A name the speech recogniser spelled by ear ("aka" for the chat called "Akka"): the app's search cannot find a spelling it does
          // not have, so look at everything that starts the same way, and take only a name that SOUNDS like what was said.
          const listBefore = namesKey(await lister.listItems());
          await service.fillOnPage(searchBox, heard.slice(0, 2));
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
        const result = await openFound(m.candidate.label, m.candidate.item.name, app.name, how, m.phoneEnding, app.id);
        return m.strength === 'fuzzy' && result.ok ? { ...result, data: { ...result.data, note: 'This was a close spelling, not an exact match: say the name you opened when asking to send.' } } : result;
      } catch (err) {
        if (err instanceof BrowserUnavailableError) return unavailable(err);
        return { ok: false, summary: 'could not look', error: `I could not look for that chat: ${err instanceof Error ? err.message : String(err)}` };
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

      const checked = checkReadablePath(raw, folders);
      if (!checked.ok) return { ok: false, summary: 'not allowed', error: `I won't attach that: ${checked.reason}.` };
      const path = checked.path;
      const name = basename(path);
      if (isExecutablePath(path)) return { ok: false, summary: 'not allowed', error: `"${name}" is a program or script, which I don't send through chat apps.` };
      const info = await files.stat(path);
      if (info === null) return { ok: false, summary: 'file not found', error: `There is no file at that path ("${name}").` };
      if (info.isDirectory) {
        return { ok: false, summary: 'that is a folder', error: `"${name}" is a folder, and a chat app cannot take a folder. Use zip_folder to make a .zip of it first (and tell the user), then attach that.` };
      }
      if (!info.isFile || info.size <= 0) return { ok: false, summary: 'empty file', error: `"${name}" is empty, so there is nothing to send.` };
      if (info.size > MAX_ATTACH_BYTES) return { ok: false, summary: 'too big', error: `"${name}" is ${Math.round(info.size / 1048576)} MB; chat apps take at most about 100 MB.` };

      try {
        const page = await service.inspectPage();
        const app = policy.appForUrl(page.url);
        if (app === null) return notChatPage(page.url);
        const who = describeRecipient(session);
        const chat = session.chat();
        const question = `${who.text}. Send the file "${name}" to this chat?`;

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
      },
    },
    async execute(args): Promise<ToolResult> {
      const text = stringArg(args, 'text');
      const fileName = stringArg(args, 'name') ?? (text === undefined ? (session.lastSent() ?? session.attachment() ?? undefined) : undefined);
      if (text === undefined && fileName === undefined) {
        return { ok: false, summary: 'nothing to check', error: 'Say what was sent: the message text, or the file name.' };
      }
      const needle = (fileName ?? (text as string)).slice(0, 60);
      // A delivery mark that was already on screen before the send says nothing about this message: only a mark that is new counts.
      const baseline = session.baseline();
      const newestNew = (snap: PageSnapshot): string | null => {
        const marks = snap.messageStatus ?? [];
        const unchanged = baseline !== null && marks.length === baseline.length && marks.every((m, i) => m === baseline[i]);
        return marks.length > 0 && !unchanged ? (marks[marks.length - 1] as string) : null;
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
            return { ok: false, summary: 'it failed to send', error: `The app shows "${latest}" next to the latest message: it did NOT go. Tell the user it failed.`, data: { status: 'failed', mark: latest } };
          }
          const stillInPreview = fileName !== undefined && previewShows(snap, fileName);
          if (stillInPreview) continue; // Send has not gone through yet: the preview is still open
          let found = await service.findOnPage(needle);
          sawEvidence = found.matches.length > 0 || found.textMatches.length > 0;
          if (!sawEvidence && fileName !== undefined && leadPhrase(fileName) !== '') {
            // The sent file's bubble may show a long name cut short: look for the start of it too.
            found = await service.findOnPage(leadPhrase(fileName));
            sawEvidence = found.matches.length > 0 || found.textMatches.length > 0;
          }
          if (sawEvidence && latest !== null && STATUS_SENT.has(latest)) {
            const chatNow = session.chat();
            const app = policy.appForUrl(snap.url);
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
        if (!sawEvidence) {
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

  return [findChat, attachFile, verifySent, learnChatNames];
}
