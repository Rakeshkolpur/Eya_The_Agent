import { rootLogger } from '@main/logging/logger';
import type { ChatSession } from '@main/chat/chatSession';
import type { ContactBook } from '@main/chat/ContactBook';
import { normalizeText, resolveChat } from '@main/chat/contactMatch';
import type { CommunicationApp, CommunicationPolicy } from '@main/privacy/communicationAccess';
import { describeRecipient } from '@main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { CHAT_APPS, parseChatIntent, parseYesNo } from './chatIntents';
import type { ChatAppId, ChatIntent } from './chatIntents';
import { namesABrowser } from './localIntents';
import type { LocalCommandResult } from './LocalCommands';

const log = rootLogger.child('chatcommands');

/**
 * Messaging by name without asking the model: "message Ravi that I'll be late", "send good morning to Amma on WhatsApp", "open
 * Priya's chat", "remember my WhatsApp contacts". The steps are the ones the model would take, run in a fixed order through the SAME
 * tools and so the same rules — Communication Access, the page checks, and above all the question before anything is sent:
 *
 *   find the chat  ->  type the message in its box (NOT sent)  ->  ask "Found Ravi Kumar, number ending in 432. Send …?"  ->
 *   only on a clear yes: click Send  ->  check it really went.
 *
 * What the saved chat names add is speed and fewer wrong turns: "Ravi" is turned into the exact chat name before the app is
 * searched, "mom" can mean Amma, and two Ravis are asked about right away. It never sends on its own, never acts on always-on
 * listening (a "yes" heard from a room or a video is not a yes), and a question left unanswered lapses after two minutes.
 */

/** What "the latest pdf" or "my resume" is, found on this PC for sending (see LocalCommands.locateFile). */
export type FileLocation =
  | { readonly kind: 'one'; readonly path: string; readonly name: string }
  | { readonly kind: 'several'; readonly names: readonly string[]; readonly total: number };

export interface ChatCommandsDeps {
  readonly tools: { invoke(name: string, args: ToolArgs): Promise<ToolResult> };
  readonly contacts: ContactBook;
  readonly policy: CommunicationPolicy;
  readonly session: ChatSession;
  /** Finds the file a request means, from the in-memory index. Without it, sending a file is left to the model. */
  readonly files?: { locate(words: string): Promise<FileLocation | null> };
  /** True while a connected browser's extension is an older one that does not support quick chat actions (it works, but each step is slow). */
  readonly extensionIsOld?: () => boolean;
  /** The file Eya just found or opened for the user (whoever found it), for "send it to Uber". */
  readonly lastFile?: () => { readonly path: string; readonly name: string } | null;
  /** Whether one of the user's browsers has a chat app open right now (so "send it to Uber" can only mean a chat). */
  readonly chatAppOpen?: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times to look for the chat once the chat app has just been opened (its list takes a moment to appear). */
  readonly loadAttempts?: number;
}

interface Option {
  readonly label: string;
  /** find_chat's own number for it, when the options came from the app rather than from the saved names. */
  readonly choice?: number;
  readonly ending?: string;
}

interface FileToSend {
  readonly path: string;
  readonly name: string;
}

type Pending =
  | { readonly kind: 'send'; readonly app: ChatAppId; readonly label: string; readonly text: string; readonly spokenName: string }
  | { readonly kind: 'send_file'; readonly app: ChatAppId; readonly label: string; readonly spokenName: string; readonly file: FileToSend }
  | { readonly kind: 'which'; readonly app: ChatAppId; readonly text: string | null; readonly file?: FileToSend; readonly spokenName: string; readonly options: readonly Option[] }
  | { readonly kind: 'consent'; readonly app: ChatAppId; readonly label: string; readonly spokenName: string };

// A question left unanswered lapses after ten minutes (it used to be two: a slow page can use up two minutes before the question is even asked).
const PENDING_MS = 10 * 60_000;
const BOX_LABELS = ['Type a message', 'Message', 'Write a message'];
// How long to wait before each look for the chat once the chat app has just been opened. The first is short: when the user already has
// the app open in a tab, it is ready at once; a page that is still loading is looked at again, a little less often each time, for as long
// as the page says it is still loading (a slow connection can take a minute or more), up to LOAD_BUDGET_MS.
const LOAD_WAITS_MS = [300, 700, 1000, 1500];
const LOAD_STEP_MS = 2000;
const LOAD_BUDGET_MS = 90_000;
/** Looks at a page that does NOT say it is loading, and has no such chat, before believing there is none (the old fixed wait). */
const QUIET_LOOKS = 5;
// "the second one", "3rd": an ordinal word anywhere in a short reply. (A bare "one" is deliberately not here: in "the second one" it
// is the wrong word to read.)
const ORDINALS: Readonly<Record<string, number>> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3 };
// "2", "number two", "option 3": the number is the whole reply.
const NUMBER_REPLY = /^(?:(?:number|option|choice|no)\s+)?(1|one|2|two|3|three|4|four)$/;
const NUMBER_INDEX: Readonly<Record<string, number>> = { '1': 0, one: 0, '2': 1, two: 1, '3': 2, three: 2, '4': 3, four: 3 };

const result = (spoken: string, ok: boolean, intent: string, tools: readonly string[] = []): LocalCommandResult => ({ spoken, ok, intent, tools, refs: [] });

/** A name as it should be read aloud. */
const sayable = (name: string): string => name.replace(/_+/g, ' ').trim();

export class ChatCommands {
  private pending: (Pending & { readonly at: number }) | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;

  constructor(private readonly deps: ChatCommandsDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.attempts = deps.loadAttempts ?? LOAD_WAITS_MS.length + Math.ceil((LOAD_BUDGET_MS - LOAD_WAITS_MS.reduce((a, b) => a + b, 0)) / LOAD_STEP_MS);
  }

  /** Forgets any question waiting for an answer (Chats were switched off, say). */
  reset(): void {
    this.pending = null;
  }

  /**
   * Carries the request out if it is a chat request this layer knows (or an answer to the question it just asked), or returns null so
   * the model takes it as before. `live` is always-on listening: nothing is started from it and no question is answered by it.
   */
  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    if (options.live === true) return null;
    try {
      const waiting = this.waiting();
      if (waiting !== null) {
        const answered = await this.answer(waiting, text);
        if (answered !== undefined) return this.withExtensionHint(answered);
        this.pending = null; // not an answer: the question lapses and this is a new request
      }
      // "... on WhatsApp in Edge": the fast path opens the chat app in the standard browser (Chrome), so a request that names a browser
      // goes to the model, which opens the page in the one they asked for.
      if (namesABrowser(text)) return null;
      const intent = parseChatIntent(text);
      if (intent === null) return null;
      const started = Date.now();
      const done = await this.run(intent);
      log.info('chat command', { kind: intent.kind, handled: done !== null, ok: done?.ok, ms: Date.now() - started });
      return this.withExtensionHint(done);
    } catch (err) {
      // A failure here must never stop Eya answering: let the model have it.
      log.warn('chat command failed; passing it on', { err: String(err) });
      this.pending = null;
      return null;
    }
  }

  /**
   * A send went through some other way (the model's own steps, in a live conversation): if the user was never asked about remembering chat
   * names, that question is now the one waiting for a yes, and these are the words to ask it in. Null when it is not needed.
   */
  offerConsent(app: string, label: string): string | null {
    const id = (Object.keys(CHAT_APPS) as ChatAppId[]).find((x) => x === app);
    if (id === undefined || this.deps.contacts.learning() !== 'unasked' || this.pending !== null) return null;
    this.ask({ kind: 'consent', app: id, label, spokenName: label });
    return `I can remember the names in your ${CHAT_APPS[id].name} so I find chats instantly next time — names only, kept on this PC, never messages. Want that? Say yes or no.`;
  }

  private toldAboutExtension = false;

  /**
   * Once, after a chat step that went through (never on a question the user has to answer), says why chats are slower than they could be
   * when the browser's Eya extension is the older one: it works, but waits on every step. A reload of the extension fixes it.
   */
  private withExtensionHint(done: LocalCommandResult | null): LocalCommandResult | null {
    if (done === null || !done.ok || this.toldAboutExtension || this.pending !== null || this.deps.extensionIsOld?.() !== true) return done;
    if (done.intent !== 'chat_send' && done.intent !== 'chat_open') return done;
    this.toldAboutExtension = true;
    return { ...done, spoken: `${done.spoken} By the way, chats are slower than they need to be because your browser still has the older Eya extension. Reload it once on the extensions page, the circular arrow on its card, and they'll be much faster.` };
  }

  private waiting(): Pending | null {
    if (this.pending === null) return null;
    if (this.now() - this.pending.at > PENDING_MS) {
      this.pending = null;
      return null;
    }
    return this.pending;
  }

  private ask(pending: Pending): void {
    this.pending = { ...pending, at: this.now() };
  }

  // ------------------------------------------------------------------------------- the apps and the rules
  private appObject(app: ChatAppId): CommunicationApp | undefined {
    return this.deps.policy.apps().find((a) => a.id === app);
  }

  /** The app a request is about: the one named, else the chat app already in use, else WhatsApp. */
  private appFor(named: ChatAppId | null): ChatAppId {
    if (named !== null) return named;
    const inUse = this.deps.session.chat()?.app;
    const match = (Object.keys(CHAT_APPS) as ChatAppId[]).find((id) => CHAT_APPS[id].name === inUse);
    return match ?? 'whatsapp';
  }

  /** Null when Eya may work in this app; otherwise what to say (Chats are the user's switch, never a tool's). */
  private refusal(app: ChatAppId): LocalCommandResult | null {
    const object = this.appObject(app);
    if (object !== undefined && this.deps.policy.allowed(object)) return null;
    return result(`Chats are off for ${CHAT_APPS[app].name}. Turn Chats on in Eya's panel, then ask me again.`, false, 'chat_off');
  }

  // --------------------------------------------------------------------------------------------- requests
  private async run(intent: ChatIntent): Promise<LocalCommandResult | null> {
    switch (intent.kind) {
      case 'message':
      case 'message_unsplit':
        return this.message(intent);
      case 'open_chat':
        return this.openChatOnly(intent.app, intent.name);
      case 'send_file':
        return this.prepareFile(intent);
      case 'alias':
        return this.alias(intent);
      case 'learn':
        return this.learn(intent.app);
      case 'forget':
        return this.forget(intent.app);
      case 'stop_learning':
        this.deps.contacts.setLearning('off');
        return result("Okay. I won't keep any chat names, and I've forgotten the ones I had.", true, 'chat_names');
      case 'count':
        return this.count();
    }
  }

  /** "message Ravi that I'll be late" and its other shapes. */
  private async message(intent: Extract<ChatIntent, { kind: 'message' | 'message_unsplit' }>): Promise<LocalCommandResult | null> {
    const app = this.appFor(intent.app);
    const refused = this.refusal(app);
    if (refused !== null) return refused;

    let name: string;
    let text: string;
    if (intent.kind === 'message') {
      name = intent.name;
      text = intent.text;
      // A split at a word like "that" can be wrong ("message Ravi I think that is fine"): if that name is nobody I know but the whole
      // thing begins with somebody I do know, split there instead.
      if (intent.rest !== undefined && this.deps.contacts.resolve(app, name).kind === 'none') {
        const redone = this.splitWithNames(app, intent.rest);
        if (redone !== null) ({ name, text } = redone);
      }
    } else {
      const split = this.splitWithNames(app, intent.rest);
      if (split === null) return null; // cannot tell where the name ends: the model can ask
      ({ name, text } = split);
    }
    return this.prepare(app, name, text);
  }

  /** The longest start of `rest` that is clearly one of the saved chats, and the message after it. */
  private splitWithNames(app: ChatAppId, rest: string): { name: string; text: string } | null {
    const words = rest.trim().split(/\s+/);
    for (let k = Math.min(4, words.length - 1); k >= 1; k -= 1) {
      const head = words.slice(0, k).join(' ');
      if (this.deps.contacts.resolve(app, head).kind !== 'none') return { name: head, text: words.slice(k).join(' ') };
    }
    return null;
  }

  /**
   * What to search the app for, or the people to ask about first. The saved names only ever WIDEN or CONFIRM, never narrow: they are
   * what Eya has learned, not the user's whole address book, so "Rahul" matching one saved Rahul does not mean there is only one
   * Rahul. A full name, or what the user has called someone before (and confirmed), is searched as the exact chat; two saved people
   * who fit are asked about at once; and anything else goes to the app's own search, which sees everyone.
   */
  private target(app: ChatAppId, spokenName: string): { readonly query: string } | { readonly ask: readonly Option[] } {
    const resolved = this.deps.contacts.resolve(app, spokenName);
    if (resolved.kind === 'ambiguous') return { ask: resolved.contacts.map((c) => ({ label: c.name })) };
    if (resolved.kind === 'unique' && (resolved.via !== 'name' || normalizeText(resolved.contact.name) === normalizeText(spokenName))) {
      return { query: resolved.contact.name };
    }
    return { query: spokenName };
  }

  /** Finds the chat and puts the message in its box, then asks. */
  private async prepare(app: ChatAppId, spokenName: string, text: string): Promise<LocalCommandResult | null> {
    const target = this.target(app, spokenName);
    if ('ask' in target) return this.askWhich(app, spokenName, text, target.ask);
    const opened = await this.openChat(app, { query: target.query });
    return this.afterOpen(app, spokenName, text, opened);
  }

  /** "send the latest pdf to Akka": find the file, find the chat, and ask — nothing is attached or sent until the user says yes. */
  private async prepareFile(intent: Extract<ChatIntent, { kind: 'send_file' }>): Promise<LocalCommandResult | null> {
    const app = this.appFor(intent.app);
    // No app named: this could be any app or an e-mail ("send the report to my boss"). Only a name Eya knows as a chat, a chat already
    // in use, or a chat app open in the browser makes it a chat request; anything else is for the model.
    if (
      intent.app === null &&
      this.deps.session.chat() === null &&
      this.deps.contacts.resolve(app, intent.name).kind === 'none' &&
      this.deps.chatAppOpen?.() !== true
    ) {
      return null;
    }
    let file: FileToSend;
    if (intent.file === null) {
      // "send it to Uber": the file that was just found, by Eya's own search or by the model's.
      const last = this.deps.lastFile?.() ?? null;
      if (last === null) return null; // nothing was found: the model can ask which file
      file = last;
    } else {
      const files = this.deps.files;
      if (files === undefined) return null;
      const refusedEarly = this.refusal(app);
      if (refusedEarly !== null) return refusedEarly;
      const located = await files.locate(intent.file);
      if (located === null) return null; // not in the quick index (another drive, a name not known yet): the model's own search takes over
      if (located.kind === 'several') {
        const names = located.names.map(sayable);
        const list = names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
        return result(`I found ${located.total} files that fit: ${list}. Say the exact file name and I'll send it.`, true, 'chat_file');
      }
      file = { path: located.path, name: located.name };
    }
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const target = this.target(app, intent.name);
    if ('ask' in target) return this.askWhich(app, intent.name, null, target.ask, file);
    return this.afterOpen(app, intent.name, null, await this.openChat(app, { query: target.query }), file);
  }

  private async afterOpen(app: ChatAppId, spokenName: string, text: string | null, opened: Opened, file?: FileToSend): Promise<LocalCommandResult | null> {
    const tools = ['find_chat'];
    switch (opened.kind) {
      case 'unavailable':
        return null; // no browser of the user's is connected: the model knows how to help with that (connect_chrome), so it takes over
      case 'slow': {
        const name = CHAT_APPS[app].name;
        return {
          ...result(`${name} is taking a long time to load, probably a slow connection. I'll keep trying and tell you as soon as the chat is ready.`, false, 'chat_message', tools),
          pending: { kind: 'retry', why: `${name} is still loading`, retryAfterMs: 15_000 },
        };
      }
      case 'login': {
        const name = CHAT_APPS[app].name;
        return {
          ...result(`${name} is asking you to log in, with a QR code. Scan it with your phone and I'll carry on by myself.`, false, 'chat_message', tools),
          pending: { kind: 'needs_you', why: `log in to ${name}`, watch: 'browser' },
        };
      }
      case 'ambiguous':
        return this.askWhich(app, spokenName, text, opened.options, file);
      case 'none':
        return result(`I couldn't find a chat called ${spokenName} in ${CHAT_APPS[app].name}. Try the name as it's saved there.`, false, 'chat_message', tools);
      case 'failed':
        log.warn('could not open the chat', { why: opened.why });
        return result(opened.say, false, 'chat_message', tools);
      case 'opened':
        break;
    }
    if (file !== undefined) {
      // Who it goes to is said before anything is attached; the yes that follows covers exactly this file and this chat.
      this.ask({ kind: 'send_file', app, label: opened.label, spokenName, file });
      const who = describeRecipient(this.deps.session);
      return result(`${who.known ? who.text : `Found ${sayable(opened.label)}`}. Send the file "${sayable(file.name)}"?`, true, 'chat_file', tools);
    }
    if (text === null) {
      return result(`Opened the chat with ${sayable(opened.label)}.`, true, 'chat_open', tools);
    }
    // Type it in the message box. Nothing is sent by this.
    let typed = false;
    for (const label of BOX_LABELS) {
      const filled = await this.deps.tools.invoke('fill_on_page', { label, value: text });
      if (filled.ok) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      return result(`I opened the chat with ${sayable(opened.label)} but couldn't find the message box, so nothing was typed or sent.`, false, 'chat_message', [...tools, 'fill_on_page']);
    }
    this.ask({ kind: 'send', app, label: opened.label, text, spokenName });
    const who = describeRecipient(this.deps.session);
    const shown = text.length > 160 ? `${text.slice(0, 157)}…` : text;
    return result(`${who.known ? who.text : `Found ${sayable(opened.label)}`}. Send "${shown}"?`, true, 'chat_message', [...tools, 'fill_on_page']);
  }

  private askWhich(app: ChatAppId, spokenName: string, text: string | null, options: readonly Option[], file?: FileToSend): LocalCommandResult {
    const shown = options.slice(0, 6);
    this.ask({ kind: 'which', app, text, ...(file !== undefined ? { file } : {}), spokenName, options: shown });
    const list = shown.map((o) => `${sayable(o.label)}${o.ending !== undefined ? `, number ending in ${o.ending}` : ''}`);
    const said = list.length === 2 ? `${list[0]} or ${list[1]}` : `${list.slice(0, -1).join('; ')}; or ${list[list.length - 1]}`;
    return result(`Which one: ${said}?`, true, 'chat_which', ['find_chat']);
  }

  // ---------------------------------------------------------------------------------- opening a chat
  /** Opens the chat app if it is not the page in front, then finds the chat. */
  private async openChat(app: ChatAppId, args: ToolArgs): Promise<Opened> {
    let found = await this.deps.tools.invoke('find_chat', args);
    if (browserMissing(found)) return { kind: 'unavailable' };
    const justOpened = found.summary === 'not a chat app';
    if (justOpened) {
      const opened = await this.deps.tools.invoke('open_website', { url: CHAT_APPS[app].url });
      if (browserMissing(opened)) return { kind: 'unavailable' };
      if (!opened.ok) return { kind: 'failed', say: `I couldn't open ${CHAT_APPS[app].name}.`, why: opened.error ?? opened.summary };
    }
    // The page may need a moment — on a slow connection, a long one — before its chat list is there to search. Keep looking for as long
    // as it says it is still loading, and a few looks more when it has just been opened and shows nothing yet; stop at once for a log-in.
    const status = (r: ToolResult): unknown => r.data?.['status'];
    const stillLoading = (r: ToolResult): boolean => r.summary === 'not a chat app' || status(r) === 'loading';
    if (stillLoading(found) || (justOpened && status(found) === 'none')) {
      let quiet = 0;
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        await this.sleep(LOAD_WAITS_MS[attempt] ?? LOAD_STEP_MS);
        found = await this.deps.tools.invoke('find_chat', args);
        if (browserMissing(found)) return { kind: 'unavailable' };
        if (status(found) === 'needs_login') return { kind: 'login' };
        if (!stillLoading(found)) {
          // Not loading any more. A page that has only just been opened can say "none" before its list is filled in: look a few more times.
          if (status(found) === 'none' && justOpened && (quiet += 1) < QUIET_LOOKS) continue;
          break;
        }
      }
    }
    if (status(found) === 'needs_login') return { kind: 'login' };
    if (stillLoading(found)) return { kind: 'slow' };
    return this.readFound(found);
  }

  private readFound(found: ToolResult): Opened {
    const data = found.data ?? {};
    if (browserMissing(found)) return { kind: 'unavailable' };
    if (!found.ok) return { kind: 'failed', say: "I couldn't look for that chat just now, so nothing was typed or sent.", why: found.error ?? found.summary };
    switch (data['status']) {
      case 'opened':
        return {
          kind: 'opened',
          label: typeof data['chat'] === 'string' ? data['chat'] : 'the chat',
          ...(typeof data['numberEndsIn'] === 'string' ? { ending: data['numberEndsIn'] } : {}),
        };
      case 'ambiguous': {
        const list = Array.isArray(data['candidates']) ? (data['candidates'] as Array<{ choice?: unknown; label?: unknown; phoneEnding?: unknown }>) : [];
        const options: Option[] = list.flatMap((c) =>
          typeof c.label === 'string'
            ? [{ label: c.label, ...(typeof c.choice === 'number' ? { choice: c.choice } : {}), ...(typeof c.phoneEnding === 'string' ? { ending: c.phoneEnding } : {}) }]
            : [],
        );
        return options.length > 0 ? { kind: 'ambiguous', options } : { kind: 'none' };
      }
      case 'none':
        return { kind: 'none' };
      default:
        return { kind: 'failed', say: 'I found the chat but could not open it, so nothing was typed or sent.', why: String(data['status'] ?? found.summary) };
    }
  }

  private async openChatOnly(named: ChatAppId | null, spokenName: string): Promise<LocalCommandResult | null> {
    const app = this.appFor(named);
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const target = this.target(app, spokenName);
    if ('ask' in target) return this.askWhich(app, spokenName, null, target.ask);
    const opened = await this.openChat(app, { query: target.query });
    return this.afterOpen(app, spokenName, null, opened);
  }

  // ------------------------------------------------------------------------------ answers to a question
  /** The reply to the question just asked. `undefined` means it was not an answer (so it is a new request). */
  private async answer(pending: Pending, reply: string): Promise<LocalCommandResult | undefined> {
    if (pending.kind === 'which') return this.answerWhich(pending, reply);
    const yn = parseYesNo(reply);
    if (yn === null) return undefined;
    this.pending = null;
    if (pending.kind === 'send') {
      if (yn === 'no') {
        this.deps.session.sendCancelled();
        return result("Okay, I won't send it. The message is still typed in the box if you want it.", true, 'chat_cancel');
      }
      return this.send(pending);
    }
    if (pending.kind === 'send_file') {
      if (yn === 'no') return result("Okay, I won't send it. Nothing was attached.", true, 'chat_cancel');
      return this.sendFileNow(pending);
    }
    // consent to remember chat names
    const { contacts } = this.deps;
    if (yn === 'no') {
      contacts.setLearning('off');
      return result("Okay, I won't keep any chat names.", true, 'chat_names');
    }
    contacts.setLearning('on');
    this.remember(pending.app, pending.label, pending.spokenName);
    return result("Okay. I'll remember chat names from now on — names only, on this PC, never messages. You can see and remove them in Memory.", true, 'chat_names');
  }

  private async answerWhich(pending: Extract<Pending, { kind: 'which' }>, reply: string): Promise<LocalCommandResult | undefined> {
    const picked = this.pick(pending.options, reply);
    if (picked === 'unclear') {
      this.ask(pending); // still waiting
      return result(`I'm not sure which. Say the number, or more of the name.`, true, 'chat_which', ['find_chat']);
    }
    if (picked === null) return undefined;
    this.pending = null;
    const opened: Opened =
      picked.choice !== undefined
        ? this.readFound(await this.deps.tools.invoke('find_chat', { choice: picked.choice }))
        : await this.openChat(pending.app, { query: picked.label });
    return (await this.afterOpen(pending.app, pending.spokenName, pending.text, opened, pending.file)) ?? undefined;
  }

  /** Which option a reply chooses: "the second one", "2", "Ravi Teja", "Teja". Null if it is not a choice at all. */
  private pick(options: readonly Option[], reply: string): Option | null | 'unclear' {
    const plain = normalizeText(reply);
    if (plain === '') return null;
    const words = plain.split(' ');
    if (words.length <= 4) {
      for (const word of words) {
        const index = ORDINALS[word];
        if (index !== undefined && options[index] !== undefined) return options[index] ?? null;
      }
      const numbered = NUMBER_REPLY.exec(plain);
      const picked = numbered?.[1] === undefined ? undefined : options[NUMBER_INDEX[numbered[1]] ?? -1];
      if (picked !== undefined) return picked;
      if (words.includes('last')) return options[options.length - 1] ?? null;
    }
    const byName = resolveChat(reply, options.map((o) => ({ label: o.label, option: o })));
    if (byName.kind === 'unique') return byName.match.candidate.option;
    if (byName.kind === 'ambiguous') return 'unclear';
    return null;
  }

  // ------------------------------------------------------------------------------------ sending
  /** The user said yes: press Send and check that it really went. */
  private async send(p: Extract<Pending, { kind: 'send' }>): Promise<LocalCommandResult> {
    const tools = ['click_on_page'];
    const click = await this.deps.tools.invoke('click_on_page', { text: 'Send', confirm: true });
    if (!click.ok) {
      log.warn('could not press Send', { why: click.error ?? click.summary });
      return result(`I couldn't press Send, so nothing was sent to ${sayable(p.label)}.`, false, 'chat_send', tools);
    }
    const checked = await this.deps.tools.invoke('verify_sent', { text: p.text });
    tools.push('verify_sent');
    return this.reportSend(p, checked, tools);
  }

  /** The user said yes to a file: put it on the chat's attach step (opening the app's attach menu if it needs that), press Send, check it went. */
  private async sendFileNow(p: Extract<Pending, { kind: 'send_file' }>): Promise<LocalCommandResult> {
    const { tools } = this.deps;
    const used = ['attach_file'];
    const give = (): Promise<ToolResult> => tools.invoke('attach_file', { path: p.file.path, confirm: true });
    let attached = await give();
    if (!attached.ok && attached.summary === 'no file picker yet') {
      // Chat apps keep their file inputs hidden until the attach menu has been opened (the tool says so). Open it — nothing is chosen or sent by that.
      const opened = await tools.invoke('click_on_page', { text: 'Attach' });
      used.push('click_on_page');
      if (opened.ok) attached = await give();
    }
    if (browserMissing(attached)) return result("I lost the connection to your browser, so nothing was sent.", false, 'chat_send', used);
    if (!attached.ok || attached.data?.['status'] !== 'attached_not_sent') {
      log.warn('could not attach the file', { why: attached.error ?? attached.summary });
      return result(`I couldn't put "${sayable(p.file.name)}" on the chat with ${sayable(p.label)}, so nothing was sent.`, false, 'chat_send', used);
    }
    const click = await tools.invoke('click_on_page', { text: 'Send', confirm: true });
    used.push('click_on_page');
    if (!click.ok) {
      log.warn('could not press Send for the file', { why: click.error ?? click.summary });
      return result(`The file is waiting in the chat with ${sayable(p.label)}, but I couldn't press Send, so it was not sent.`, false, 'chat_send', used);
    }
    const checked = await tools.invoke('verify_sent', { name: p.file.name });
    used.push('verify_sent');
    return this.reportSend({ app: p.app, label: p.label, spokenName: p.spokenName }, checked, used, p.file.name);
  }

  /** What to tell the user after Send was pressed and verify_sent looked: only "sent" is said when the app really showed it went. */
  private reportSend(p: { readonly app: ChatAppId; readonly label: string; readonly spokenName: string }, checked: ToolResult, tools: string[], file?: string): LocalCommandResult {
    const status = checked.data?.['status'];
    if (status === 'sent') {
      this.remember(p.app, p.label, p.spokenName);
      let spoken = file === undefined ? `Sent to ${sayable(p.label)}.` : `Sent "${sayable(file)}" to ${sayable(p.label)}.`;
      if (this.deps.contacts.learning() === 'unasked') {
        spoken += ` By the way, I can remember the names in your ${CHAT_APPS[p.app].name} so I find chats instantly next time — names only, kept on this PC, never messages. Want that? Say yes or no.`;
        this.ask({ kind: 'consent', app: p.app, label: p.label, spokenName: p.spokenName });
      }
      return result(spoken, true, 'chat_send', tools);
    }
    if (status === 'failed') return result(`It failed to send to ${sayable(p.label)}.`, false, 'chat_send', tools);
    if (status === 'pending') return result(`It's in the chat with ${sayable(p.label)}, but the app still shows it as sending, so I can't say it went yet.`, false, 'chat_send', tools);
    log.info('send not confirmed', { status });
    if (status === 'not_found') return result(`I pressed Send, but I can't see ${file === undefined ? 'the message' : 'the file'} in the chat with ${sayable(p.label)}, so I can't say it was sent.`, false, 'chat_send', tools);
    return result(`It's in the chat with ${sayable(p.label)}, but the app hasn't shown that it was sent yet, so I can't confirm it.`, false, 'chat_send', tools);
  }

  /** After a confirmed send: this chat is one the user uses, and what they called it is what it means from now on. */
  private remember(app: ChatAppId, label: string, spokenName: string): void {
    const { contacts } = this.deps;
    contacts.used(app, label);
    if (normalizeText(spokenName) !== normalizeText(label)) contacts.addAlias(app, label, spokenName);
  }

  // ------------------------------------------------------------------------------ chat names
  /**
   * "When I say akka I mean Lakshmi Akka" / "call this chat akka": what the user calls someone, kept so that the word goes straight to
   * that chat. The user's own asking is the yes to Eya keeping it (names only, on this PC); no page is touched.
   */
  private alias(intent: Extract<ChatIntent, { kind: 'alias' }>): LocalCommandResult {
    const app = this.appFor(intent.app);
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const { contacts, session } = this.deps;
    let label: string;
    if (intent.name === null) {
      const open = session.chat();
      if (open === null) return result(`I don't know which chat is open. Say "open" and the chat's name first, then tell me what to call it.`, false, 'chat_alias');
      label = open.label;
    } else {
      // "Lakshmi" may be a part of a chat Eya already knows by its full name: use the full one.
      const known = contacts.resolve(app, intent.name);
      label = known.kind === 'unique' ? known.contact.name : intent.name;
    }
    if (!contacts.setAlias(app, label, intent.alias)) {
      return result(`I couldn't keep that: "${intent.alias}" has to be a different name from "${sayable(label)}".`, false, 'chat_alias');
    }
    return result(`Okay. When you say ${intent.alias}, I'll open ${sayable(label)} in ${CHAT_APPS[app].name}. I only keep names, on this PC.`, true, 'chat_alias');
  }

  private async learn(named: ChatAppId | null): Promise<LocalCommandResult> {
    const app = this.appFor(named);
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const { contacts, tools } = this.deps;
    // Asking Eya to remember them is the yes.
    if (contacts.learning() !== 'on') contacts.setLearning('on');
    const couldntReach = (): LocalCommandResult =>
      result(`Okay, I'll remember chat names from now on. I couldn't reach ${CHAT_APPS[app].name} in your browser just now — open it there and ask me again.`, true, 'chat_names');
    let read = await tools.invoke('learn_chat_names', {});
    if (browserMissing(read)) return couldntReach();
    if (read.summary === 'not a chat app') {
      const opened = await tools.invoke('open_website', { url: CHAT_APPS[app].url });
      if (browserMissing(opened)) return couldntReach();
      if (!opened.ok) return result(`I couldn't open ${CHAT_APPS[app].name}.`, false, 'chat_names');
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        await this.sleep(LOAD_WAITS_MS[Math.min(attempt, LOAD_WAITS_MS.length - 1)] ?? 2000);
        read = await tools.invoke('learn_chat_names', {});
        if (read.summary !== 'not a chat app' && Number(read.data?.['seen'] ?? 0) > 0) break;
      }
    }
    if (!read.ok) {
      log.warn('could not read the chat names', { why: read.error ?? read.summary });
      return result("I couldn't read the chat names just now.", false, 'chat_names', ['learn_chat_names']);
    }
    const id = typeof read.data?.['appId'] === 'string' ? read.data['appId'] : app;
    const total = contacts.countFor(id);
    if (total === 0) {
      return result(`I'll remember chat names from now on, but I couldn't read any from ${CHAT_APPS[app].name} just yet — try again once your chats have loaded.`, true, 'chat_names', ['learn_chat_names']);
    }
    const sample = contacts.list(id, 3).map((c) => sayable(c.name));
    const examples = sample.length === 0 ? '' : ` — like ${sample.length === 1 ? sample[0] : `${sample.slice(0, -1).join(', ')} and ${sample[sample.length - 1]}`}`;
    return result(
      `Okay, I'll remember chat names from now on. I know ${total} so far${examples}. I'll add more as you message people, and you can see or remove them in Memory.`,
      true,
      'chat_names',
      ['learn_chat_names'],
    );
  }

  private forget(named: ChatAppId | null): LocalCommandResult {
    const { contacts } = this.deps;
    const n = named === null ? contacts.forgetAll() : contacts.forgetApp(named);
    return result(n === 0 ? "I don't have any chat names saved." : `Done. I forgot ${n} chat name${n === 1 ? '' : 's'}.`, true, 'chat_names');
  }

  private count(): LocalCommandResult {
    const { contacts } = this.deps;
    const n = contacts.count();
    if (contacts.learning() !== 'on') return result(`I'm not remembering chat names. Say "remember my WhatsApp contacts" if you'd like me to.`, true, 'chat_names');
    return result(n === 0 ? "I'm set to remember chat names, but I don't know any yet." : `I know ${n} chat name${n === 1 ? '' : 's'}. You can see or remove them in Memory.`, true, 'chat_names');
  }
}

type Opened =
  | { readonly kind: 'opened'; readonly label: string; readonly ending?: string }
  | { readonly kind: 'ambiguous'; readonly options: readonly Option[] }
  | { readonly kind: 'none' }
  /** None of the user's browsers is connected to Eya: nothing was done, and the model can help connect one. */
  | { readonly kind: 'unavailable' }
  /** The chat app is still loading after a long wait (a slow connection): the task is kept and carried on by itself. */
  | { readonly kind: 'slow' }
  /** The chat app is asking the user to log in (the QR code): they have to do that themselves. */
  | { readonly kind: 'login' }
  | { readonly kind: 'failed'; readonly say: string; readonly why: string };

/** A tool's way of saying "no browser of the user's is reachable" (its text is for the model, so it is never read out). */
function browserMissing(r: ToolResult): boolean {
  return r.data?.['browserUnavailable'] === true;
}
