import { rootLogger } from '@main/logging/logger';
import type { ChatSession } from '@main/chat/chatSession';
import type { ContactBook } from '@main/chat/ContactBook';
import { ChatTask } from '@main/chat/chatTask';
import type { ChatTaskObserver, FailureCategory, TaskAction } from '@main/chat/chatTask';
import { statusWord } from '@main/chat/chatDiagnostics';
import type { ChatDiagnostics } from '@main/chat/chatDiagnostics';
import { normalizeText, resolveChat } from '@main/chat/contactMatch';
import { phoneDigits, splitPhone } from '@main/chat/phone';
import { countryContext } from '@main/chat/phoneNumbers';
import type { CountryContext } from '@main/chat/phoneNumbers';
import { ADAPTERS } from '@main/chat/platformAdapter';
import { maskNumbersIn, readRecipientReference, resolveByContext } from '@main/chat/recipientResolver';
import type { RecentRecipient } from '@main/chat/recipientResolver';
import type { CommunicationApp, CommunicationPolicy } from '@main/privacy/communicationAccess';
import { describeRecipient, weakMatchNote } from '@main/tools/impl/chatTools';
import type { ToolArgs, ToolResult } from '@main/tools/types';
import { autoLimitsSaid } from '@main/livechat/auto';
import type { LiveChatRequest, LiveChatResult, LiveChatView } from '@shared/liveChat';
import { CHAT_APPS, cleanMessageText, isContinuation, isImpatientYes, isLiveRetry, looksLikeEdit, parseChatIntent, parseRelay, parseYesNo } from './chatIntents';
import { needsRefining } from './messageRefine';
import { RELATION_LABEL, relationFrom } from '@main/livechat/style';
import type { LiveRelation } from '@shared/liveChat';
import type { RefineInput } from './messageRefine';
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

// (phone numbers in the words a person says them: shared with the request parser)
export { phoneDigits, splitPhone } from '@main/chat/phone';

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
  /** Whether the chat app is installed on this PC as a program of its own, not just a web page. */
  readonly installedApp?: (app: ChatAppId) => boolean;
  /** Opens the installed app's own link (whatsapp://send?phone=…&text=…), so its window comes up with the chat and the message ready. */
  readonly openAppLink?: (url: string) => Promise<boolean>;
  /** True while a connected browser's extension is an older one that does not support quick chat actions (it works, but each step is slow). */
  readonly extensionIsOld?: () => boolean;
  /** The Live Chat Companion, for "start live chat with Rahul" and the like: the person's own words are how a chat is confirmed or chosen there. */
  readonly liveChat?: { handle(request: LiveChatRequest): Promise<LiveChatResult>; view(): LiveChatView };
  /** The file Eya just found or opened for the user (whoever found it), for "send it to Uber". */
  readonly lastFile?: () => { readonly path: string; readonly name: string } | null;
  /** Whether one of the user's browsers has a chat app open right now (so "send it to Uber" can only mean a chat). */
  readonly chatAppOpen?: () => boolean;
  /** Writes the message properly from what the person said to tell (see messageRefine.ts): a readable message even when no AI answers. Without it the words are typed as said. */
  readonly refine?: (input: RefineInput) => Promise<string>;
  /** Who each person is to the person (asked once before a live chat; remembered): without it no question is asked and Eya is natural and polite. */
  readonly relations?: { get(name: string): LiveRelation | null; set(name: string, relation: LiveRelation): void };
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How many times to look for the chat once the chat app has just been opened (its list takes a moment to appear). */
  readonly loadAttempts?: number;
  /** Where the privacy-safe account of each task's steps goes (states, durations, outcomes: never a name, a number or a message). */
  readonly diagnostics?: ChatDiagnostics;
  /**
   * Whether a browser with the Eya extension is connected, so that a chat can be worked in the app's web page (where Eya can look, type and check).
   * When it is, a request that needs the app WORKED IN goes there even if the installed program is on this PC: Eya cannot type in the installed
   * program, so using it for a message meant "press Enter yourself" and no check that anything went.
   */
  readonly browserReady?: () => boolean;
  /**
   * When a message or file goes without asking again. 'unless_verified' (the default): the person's own request to send is the instruction, and once the page
   * has shown that the open chat is that person's (an exact name or a whole number, named by the page's own message box) nothing more is asked; a likely match,
   * a chat the page did not confirm and a send like an earlier one are still asked about. 'always': every send asks first.
   */
  readonly confirmSends?: 'always' | 'unless_verified';
  /**
   * How a file reaches the person in an app that has a "Select chats" step. 'picker' (the default): through that step, with no chat opened first.
   * 'chat': the older way — open the chat, attach the file in it, press Send.
   */
  readonly fileRoute?: 'picker' | 'chat';
  /** The country a phone number said without its country code belongs to (a two-letter code; India when it is not given). Read each time, so a change in Settings counts at once. */
  readonly country?: () => string | undefined;
  /**
   * Keeps each request as a task through the plugin that stands for its app (what it settled on, what was seen to happen, where it stands), as it happens.
   * Without it the requests behave exactly as before and nothing is kept.
   */
  readonly journal?: ChatTaskObserver;
  /** May the plugin for this chat app do something needing this permission? Null when it may, otherwise why not (said to the person as it is). */
  readonly permits?: (app: ChatAppId, permission: string) => string | null;
}

interface Option {
  readonly label: string;
  /** find_chat's own number for it, when the options came from the app rather than from the saved names. */
  readonly choice?: number;
  readonly ending?: string;
  /** The number the chat shows, with all but its last four digits hidden (a whole number is never read out). */
  readonly masked?: string;
}

interface FileToSend {
  readonly path: string;
  readonly name: string;
}

type Pending =
  | { readonly kind: 'send'; readonly app: ChatAppId; readonly label: string; readonly text: string; readonly spokenName: string; readonly task?: ChatTask; readonly refined?: { readonly original: string } }
  | { readonly kind: 'send_file'; readonly app: ChatAppId; readonly label: string; readonly spokenName: string; readonly file: FileToSend; readonly task?: ChatTask; readonly via?: 'share' }
  | { readonly kind: 'which'; readonly app: ChatAppId; readonly text: string | null; readonly file?: FileToSend; readonly spokenName: string; readonly options: readonly Option[]; readonly task?: ChatTask; readonly via?: 'share' }
  | { readonly kind: 'consent'; readonly app: ChatAppId; readonly label: string; readonly spokenName: string }
  /** "Who is she to you?" (asked before a live chat starts; the live chat starts with the answer). */
  | { readonly kind: 'live_relation'; readonly intent: Extract<ChatIntent, { kind: 'live_chat' }>; readonly name: string }
  /** The question that switches automatic replies on for the live chat that is running: only the person's own yes does it. */
  | { readonly kind: 'live_auto'; readonly label: string }
  /** "him" or "the person I messaged yesterday" was read as these people: one is said back for a yes, several are asked about. The request goes on with the chosen one. */
  | { readonly kind: 'recipient'; readonly app: ChatAppId; readonly intent: ChatIntent; readonly phrase: string; readonly options: readonly Option[] };

// A question left unanswered lapses after ten minutes (it used to be two: a slow page can use up two minutes before the question is even asked).
const PENDING_MS = 10 * 60_000;
/** "reply: …" (without "her") is taken for an answer to the live chat only this soon after the other person had something for the person. */
const RELAY_WINDOW_MS = 30 * 60_000;
/** The file extensions that a bare kind of file ("this pdf", "the photo") can mean. A kind not listed here ("file", "report") can be anything. */
const KIND_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  pdf: ['.pdf'],
  pdfs: ['.pdf'],
  doc: ['.doc', '.docx'],
  docx: ['.docx'],
  document: ['.doc', '.docx', '.pdf', '.txt'],
  photo: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  picture: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  pic: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  image: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
  screenshot: ['.jpg', '.jpeg', '.png'],
  video: ['.mp4', '.mov'],
};
/** A send of the very same thing to the very same chat this recently is said to be a repeat when the person is asked to go ahead. */
const REPEAT_NOTE_MS = 3 * 60_000;
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

/** What a code from the browser layer means, in words a person can use (never what was on the page). */
function browserReasonWords(code: string): string {
  switch (code) {
    case 'timeout':
      return 'the browser did not answer in time';
    case 'not_connected':
      return 'the browser is not connected to Eya';
    case 'extension_error':
      return 'the browser extension reported a problem';
    case 'ambiguous':
      return 'more than one browser is connected';
    case 'open_website':
      return "the page wouldn't open";
    case 'no_file_input':
      return 'the page has no place to put a file';
    case 'type_not_accepted':
      return "the page doesn't take that kind of file";
    default:
      return 'something went wrong in the browser';
  }
}

/** A name as it should be read aloud. */
const sayable = (name: string): string => name.replace(/_+/g, ' ').trim();

export class ChatCommands {
  private pending: (Pending & { readonly at: number }) | null = null;
  /** The message Eya wrote from what the person said (and what they said), so that the question that follows shows it and the person's own request does not stand for their yes to it. */
  private refined: { readonly text: string; readonly original: string } | null = null;
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
    this.lastTask = null;
    this.retry = null;
    this.lastLive = null;
    this.liveFollow = null;
  }

  /**
   * The request that could not be carried out (a page still loading, a browser not reachable yet, a click that opened nothing): "ok", "do it now", "send na",
   * "try again" take it up again where it stopped, with the recipient and the words it already had, instead of being heard as a new request with nothing in it.
   * It lives here, not in an AI's conversation, so it is the same whichever AI answers (or when none can).
   */
  private retry: { readonly intent: ChatIntent; readonly at: number } | null = null;

  /** The last live chat asked for — who, what for, and what the person said about her knowing — so "do live chat now go" after a failed start means that one. */
  private lastLive: { readonly name: string | null; readonly purpose: string; readonly opening: boolean; readonly aware: boolean; readonly unaware: boolean; readonly at: number } | null = null;
  /** What to do once the live chat that was just started is the confirmed chat: switch automatic replies on (she knows) or ask the one question. */
  private liveFollow: { readonly aware: boolean; readonly unaware: boolean; readonly opening: boolean; readonly at: number } | null = null;

  // ------------------------------------------------------------------------------------------------ tasks and their steps
  /** The request now under way (or the one just finished), so that the same request said again is taken up where it was and not begun anew. */
  private lastTask: ChatTask | null = null;

  /**
   * A request becomes a task: the app, what is to be done, who it is for and what is to be sent, all fixed BEFORE anything is clicked. The same request
   * again while the earlier one is not over (a retry after a slow page, or the person saying it twice) is that same task, with what it had already
   * established, not a new beginning.
   */
  private begin(app: ChatAppId, action: TaskAction, spokenName: string, contentKey: string | null): ChatTask {
    const fresh = new ChatTask(app, action, { query: spokenName, isNumber: readRecipientReference(spokenName, this.country()).phone !== undefined }, contentKey, this.deps.diagnostics, this.now, this.deps.journal);
    const last = this.lastTask;
    if (last !== null && !last.finished && last.signature === fresh.signature && this.now() - last.startedAt < PENDING_MS) {
      last.resumed += 1;
      return last;
    }
    this.lastTask = fresh;
    fresh.enter('RESOLVE_RECIPIENT');
    return fresh;
  }

  /** One tool call, timed and noted (how long, whether it worked, its status in a word: never what was in it). */
  /** The country a number said without its country code belongs to (Settings; India until another is chosen). */
  private country(): CountryContext {
    return countryContext(this.deps.country?.());
  }

  /** The chats used in this conversation, and in the saved history when the person let Eya keep chat names, with when (names and times only). */
  private recents(app: ChatAppId): RecentRecipient[] {
    const appName = CHAT_APPS[app].name;
    const now: RecentRecipient[] = this.deps.session.recentRecipients().filter((r) => r.app === null || r.app === appName).map((r) => ({ label: r.label, at: r.at, session: true }));
    let saved: RecentRecipient[] = [];
    try {
      saved = this.deps.contacts.recentUses(app).map((u) => ({ label: u.name, at: u.at }));
    } catch {
      saved = [];
    }
    return [...now, ...saved];
  }

  /**
   * Before anything is begun: a recipient that is a reference to the conversation ("him", "the last person I messaged", "the same person I messaged yesterday") is turned
   * into WHO — from who was used and when — and said back for a yes (a reference is never an identity by itself); several people are asked about. A number with
   * more digits than any phone number has is said so. Null when the recipient is a name or a number to look for: the request goes on as it is.
   */
  private recipientStep(app: ChatAppId, intent: ChatIntent, spoken: string): { readonly done: LocalCommandResult | null } | null {
    const reference = readRecipientReference(spoken, this.country());
    if (reference.phone?.kind === 'unclear' && reference.phone.digits.length > 15) {
      return { done: result('That has more digits than a phone number has. Could you say the number again?', true, 'chat_which') };
    }
    if (reference.kind !== 'context') return null;
    const resolution = resolveByContext(reference, { recents: this.recents(app), now: this.now() });
    const phrase = sayable(spoken);
    if (resolution.status === 'confirm' && resolution.chosen !== null) {
      this.ask({ kind: 'recipient', app, intent, phrase, options: [{ label: resolution.chosen.row.label }] });
      return { done: result(`${resolution.question ?? `By "${phrase}" do you mean ${sayable(resolution.chosen.row.label)}?`} Say yes and I'll go on.`, true, 'chat_which') };
    }
    if (resolution.status === 'ambiguous') {
      const options = resolution.candidates.slice(0, 6).map((c) => ({ label: c.row.label }));
      this.ask({ kind: 'recipient', app, intent, phrase, options });
      return { done: result(`${resolution.question ?? 'Which one?'}`, true, 'chat_which') };
    }
    // Nobody is known. With a pronoun the AI, which has the whole conversation, may know who is meant: it is left to it. Anything else needs one focused question.
    if (reference.context?.kind === 'pronoun') return { done: null };
    return { done: result(`I don't know who you mean by "${phrase}" — I only know the chats I opened for you. Who should I send it to? Tell me their name or number.`, true, 'chat_which') };
  }

  /** The answer to "By him do you mean Anna?" (yes, no) or "Which one: Anna or Ravi?" (the person chosen): the request goes on with that person, as if they had been named. */
  private async answerRecipient(p: Extract<Pending, { kind: 'recipient' }>, reply: string): Promise<LocalCommandResult | undefined> {
    const only = p.options.length === 1 ? p.options[0] : undefined;
    let label: string;
    if (only !== undefined) {
      const yn = parseYesNo(reply);
      if (yn === null) return undefined;
      this.pending = null;
      if (yn === 'no') return result('Okay. Who should I send it to? Tell me their name or number.', true, 'chat_which');
      label = only.label;
    } else {
      const picked = this.pick(p.options, reply);
      if (picked === 'unclear') {
        this.ask(p); // still waiting
        return result("I'm not sure which. Say the number, or more of the name.", true, 'chat_which');
      }
      if (picked === null) return undefined;
      this.pending = null;
      label = picked.label;
    }
    return (await this.run(withRecipient(p.intent, label))) ?? undefined;
  }

  private async call(task: ChatTask | undefined, name: string, args: ToolArgs): Promise<ToolResult> {
    const startedAt = Date.now();
    const out = await this.deps.tools.invoke(name, args);
    task?.observed(name, Date.now() - startedAt, out.ok, statusWord(out));
    return out;
  }

  /** The words that say who the message or file is going to, and how sure Eya is of it (a likely match is said to be one). */
  private recipientLine(opened: Extract<Opened, { readonly kind: 'opened' }>, spokenName: string): string {
    const who = describeRecipient(this.deps.session);
    const base = who.known ? who.text : `Found ${sayable(opened.label)}`;
    const notes: string[] = [];
    if (!opened.verified) notes.push(weakMatchNote(opened.evidence, sayable(spokenName)));
    if (!opened.headerChecked) notes.push("I couldn't read the chat's header to double-check it");
    return notes.length === 0 ? base : `${base} (${notes.join('; ')})`;
  }

  /**
   * Before something is prepared for a chat: has this very thing been sent to it already? Never found out by sending it again.
   *  - Begun but not seen either way (uncertain): the chat is looked at first. If it is there, nothing is sent again and the person is told.
   *  - Seen to have gone a moment ago: it is said when they are asked to go ahead, so a "yes" is an informed one.
   * Returns the answer to give instead of going on, a note to add to the question, or nothing.
   */
  private async priorSend(task: ChatTask, label: string, key: string, kind: 'text' | 'file'): Promise<{ readonly stop: LocalCommandResult } | { readonly note: string } | null> {
    const prior = this.deps.session.lastSend(label, key);
    if (prior === null || prior.status === 'failed') return null;
    const what = kind === 'file' ? 'file' : 'message';
    if (prior.status === 'sent') {
      const seconds = Math.max(1, Math.round((this.now() - prior.at) / 1000));
      return this.now() - prior.at <= REPEAT_NOTE_MS ? { note: `I already sent this ${what} here ${seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`} ago` } : null;
    }
    // attempted / uncertain: look in the chat before anything is sent again
    const look = await this.call(task, 'verify_sent', kind === 'file' ? { name: key, recheck: true } : { text: key, recheck: true });
    const status = look.data?.['status'];
    const chat = sayable(label);
    if (status === 'sent') {
      task.sendSeen();
      task.complete();
      return { stop: result(`That ${what} is already in the chat with ${chat} and shows as sent, so I did not send it again.`, true, 'chat_send', ['verify_sent']) };
    }
    if (status === 'pending') {
      task.stepFailed('verify_sent', 'send_uncertain', 'the chat shows it as still sending');
      return { stop: result(`That ${what} is already in the chat with ${chat}, but the app still shows it as sending, so I did not send it again. Check in a moment.`, true, 'chat_send', ['verify_sent']) };
    }
    if (status === 'unconfirmed') return { note: `This ${what} is already in the chat with ${chat}, though the app has not shown that it was sent` };
    return null; // not in the chat: it never got there, so preparing it again is not a repeat
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
      } else {
        // A send the AI asked about ("Send \"…\" to this chat?") and the person answered: the application carries the yes out, and never leaves it to be asked again.
        const asked = this.deps.session.askedSend();
        const appId = asked === null ? undefined : (Object.keys(CHAT_APPS) as ChatAppId[]).find((x) => x === asked.app);
        if (asked !== null && appId !== undefined) {
          const yn = parseYesNo(text) ?? (isImpatientYes(text) ? 'yes' : null);
          if (yn === 'yes') return this.withExtensionHint(await this.send({ kind: 'send', app: appId, label: asked.label, text: asked.text, spokenName: asked.label }));
          if (yn === 'no') {
            this.deps.session.sendCancelled();
            return result("Okay, I won't send it. The message is still typed in the box if you want it.", true, 'chat_cancel');
          }
        }
      }
      // "... on WhatsApp in Edge": the fast path opens the chat app in the standard browser (Chrome), so a request that names a browser
      // goes to the model, which opens the page in the one they asked for.
      if (namesABrowser(text)) return null;
      // The person answering the other person in a live chat that is running ("tell her I will call at 6"): sent there, in their own words.
      const relayed = await this.relayToLive(text);
      if (relayed !== null) return this.withExtensionHint(relayed);
      // "ok", "do it now", "go and do what I said": about the request that did not finish — taken up again, with everything it had.
      const resumed = this.retry !== null && this.now() - this.retry.at < PENDING_MS && isContinuation(text) ? this.retry.intent : null;
      // "I opened that chat, you can do now" after a live chat that could not start (or is still asking which chat): the same live chat request again, with the last person named.
      const intent = resumed ?? (this.liveRetryNow(text) ? ({ kind: 'live_chat', app: null, action: 'start' } as const) : parseChatIntent(text));
      if (intent === null) return null;
      const started = Date.now();
      const done = await this.run(intent);
      this.rememberForRetry(intent, done);
      log.info('chat command', { kind: intent.kind, handled: done !== null, ok: done?.ok, resumed: resumed !== null, ms: Date.now() - started });
      return this.withExtensionHint(done);
    } catch (err) {
      // A failure here must never stop Eya answering: let the model have it.
      log.warn('chat command failed; passing it on', { err: String(err) });
      this.pending = null;
      return null;
    }
  }

  /** Is this the person saying "now it is ready, do it" about the live chat that has not started — and is there a live chat request to do again? */
  private liveRetryNow(text: string): boolean {
    const last = this.lastLive;
    const live = this.deps.liveChat;
    if (last === null || last.name === null || live === undefined || this.now() - last.at >= PENDING_MS || !isLiveRetry(text)) return false;
    const v = live.view();
    // (not while one is running: then "ok now go" is not about starting one; but one that is only asking which chat is replaced by the new try)
    return !v.active || (v.state === 'WAITING_FOR_USER' && (v.choices.length > 0 || v.confirmChat !== null));
  }

  /** A request that did not finish is kept to be taken up again; one that did (or is waiting on a question) is not. */
  private rememberForRetry(intent: ChatIntent, done: LocalCommandResult | null): void {
    const sends = intent.kind === 'message' || intent.kind === 'message_unsplit' || intent.kind === 'send_file' || intent.kind === 'open_chat' || (intent.kind === 'live_chat' && intent.action === 'start');
    this.retry = sends && (done === null || !done.ok) ? { intent, at: this.now() } : null;
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
    // (the task, if there is one, is now waiting for the person: that is what its record says until they answer)
    if (pending.kind === 'send') pending.task?.waiting(`Send the message to ${pending.label}?`);
    else if (pending.kind === 'send_file') pending.task?.waiting(`Send "${pending.file.name}" to ${pending.label}?`);
    else if (pending.kind === 'which') pending.task?.waiting('Which one did you mean?');
  }

  /** The reason (in words for the person) when a plugin tool was refused because the plugin cannot be used right now; null for any other result. */
  private blocked(r: ToolResult): string | null {
    return r.data?.['pluginBlocked'] === true && typeof r.data['forPerson'] === 'string' ? r.data['forPerson'] : null;
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
      case 'find_files':
        return this.findFiles(intent);
      case 'live_chat':
        return this.liveChat(intent);
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
      const split = this.splitWithNames(app, intent.rest) ?? splitPhone(intent.rest, this.country());
      if (split === null) return null; // cannot tell where the name ends: the model can ask
      ({ name, text } = split);
      // (what was said inside quotation marks is the message without them: "hello" is sent as hello)
      text = cleanMessageText(text) ?? text;
    }
    // What was said is a note about what to tell them ("Rakesh told me he will call u night…"), not the message: it is written properly, shown, and sent only on a yes.
    if (this.deps.refine !== undefined && needsRefining(text)) {
      const original = text;
      const better = await this.deps.refine({ text });
      if (better !== original) {
        text = better;
        this.refined = { text, original };
      }
    }
    const step = this.recipientStep(app, { kind: 'message', app: intent.app, name, text }, name);
    if (step !== null) return step.done;
    return this.prepare(app, name, text, this.begin(app, 'message', name, text));
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
    // A phone number, or the end of one, is looked for as the number (the chat tools read it against the person's country): never among the saved names.
    if (readRecipientReference(spokenName, this.country()).phone !== undefined) return { query: spokenName };
    const resolved = this.deps.contacts.resolve(app, spokenName);
    if (resolved.kind === 'ambiguous') return { ask: resolved.contacts.map((c) => ({ label: c.name })) };
    if (resolved.kind === 'unique' && (resolved.via !== 'name' || normalizeText(resolved.contact.name) === normalizeText(spokenName))) {
      return { query: resolved.contact.name };
    }
    return { query: spokenName };
  }

  /** Finds the chat and puts the message in its box, then asks. */
  private async prepare(app: ChatAppId, spokenName: string, text: string, task: ChatTask): Promise<LocalCommandResult | null> {
    // The installed app only when there is no browser to work in the web page with: it is opened with the message ready for that exact number, and the
    // person presses Enter (Eya cannot type in it or see whether it went). With a browser ready the web page does all of it, and checks.
    const viaApp = await this.viaInstalledApp(app, spokenName, text);
    if (viaApp !== null) return viaApp;
    const target = this.target(app, spokenName);
    if ('ask' in target) return this.askWhich(app, spokenName, text, target.ask, undefined, task);
    const opened = await this.openChat(app, { query: target.query }, task);
    return this.withAppNote(app, spokenName, await this.afterOpen(app, spokenName, text, opened, undefined, task));
  }

  private toldAboutInstalledApp = false;

  private hasInstalledApp(app: ChatAppId): boolean {
    try {
      return this.deps.installedApp?.(app) === true;
    } catch {
      return false;
    }
  }

  /**
   * The installed app (WhatsApp for Windows) cannot be read or typed in by Eya: Windows shows nothing of its inside to other programs. What
   * it does have is its own link: with a phone number the app is opened on that chat with the message already in the box, and the person
   * presses Enter. Nothing is pressed for them, and nothing is claimed sent: Eya cannot see it.
   */
  private async viaInstalledApp(app: ChatAppId, spokenName: string, text: string): Promise<LocalCommandResult | null> {
    if (app !== 'whatsapp' || !this.hasInstalledApp(app) || this.deps.openAppLink === undefined) return null;
    // A browser with the extension is connected: the web page is where a message can be typed, sent and checked, so that is where it is done.
    if (this.deps.browserReady?.() === true) return null;
    const number = phoneDigits(spokenName, this.country()); // a whole number that is valid in the person's country (or written with its own code); nothing else
    if (number === null) return null;
    // (opening WhatsApp with a message ready is still using WhatsApp for a message: the plugin's permission holds here too)
    const notAllowed = this.deps.permits?.(app, 'messages.send') ?? null;
    if (notAllowed !== null) return result(`${notAllowed} Nothing was opened.`, false, 'chat_message');
    const opened = await this.deps.openAppLink(`whatsapp://send?phone=${number}&text=${encodeURIComponent(text)}`).catch(() => false);
    if (!opened) return null; // the app would not open: the web page does it
    return result(
      `WhatsApp is installed on this PC, so I opened it with your message ready for +${number}. Check the number, then press Enter in WhatsApp to send it. I can't see inside the installed app, so I can't send it or confirm it for you.`,
      true,
      'chat_open',
    );
  }

  /**
   * Once: says that the installed app was looked for first and why the web page is used instead (a name cannot be typed into the app). Only when it is true and
   * of use: not when a number was already given (the advice is to give one), and not when a browser is connected (the web page is then how every chat is
   * worked in, number or name, so there is nothing to explain and the installed program is not an option the person is missing).
   */
  private withAppNote(app: ChatAppId, spokenName: string, done: LocalCommandResult | null): LocalCommandResult | null {
    if (done === null || this.toldAboutInstalledApp || app !== 'whatsapp' || !this.hasInstalledApp(app)) return done;
    if (this.deps.browserReady?.() === true || readRecipientReference(spokenName, this.country()).phone !== undefined) return done;
    this.toldAboutInstalledApp = true;
    return { ...done, spoken: `WhatsApp is installed on this PC, but I can't type inside the installed app, so I'm using WhatsApp Web. (Give me the person's number instead of the name and I'll open the installed app with the message ready.) ${done.spoken}` };
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
    const step = this.recipientStep(app, intent, intent.name);
    if (step !== null) return step.done;
    const task = this.begin(app, 'file', intent.name, intent.file ?? 'the file just found');
    task.enter('RESOLVE_FILE');
    let file: FileToSend;
    if (intent.file === null || intent.deictic === true) {
      // "send it to Uber", "send this PDF to Anna": the file that was just found or opened, by Eya's own search or by the model's.
      const last = this.deps.lastFile?.() ?? null;
      if (last === null) {
        if (intent.deictic !== true) return null; // nothing was found: the model can ask which file
        task.stepFailed('resolve_file', 'file_not_found', 'no file is in view to mean by "this"');
        return result(`Which ${intent.fileType !== undefined && intent.fileType !== 'file' ? intent.fileType.toUpperCase() : 'file'} do you mean? Tell me its name, or open it first and I'll send that one.`, true, 'chat_file');
      }
      // "this PDF" with a Word file in view is not that file: ask rather than send a different kind of file than the one named.
      const kinds = intent.fileType === undefined ? undefined : KIND_EXTENSIONS[intent.fileType.toLowerCase()];
      if (kinds !== undefined && !kinds.some((ext) => last.name.toLowerCase().endsWith(ext))) {
        task.stepFailed('resolve_file', 'file_not_found', 'the file in view is not of the kind named');
        return result(`The file I have in view is "${sayable(last.name)}", which isn't a ${intent.fileType?.toUpperCase() ?? 'file'}. Which one do you mean? Tell me its name.`, true, 'chat_file');
      }
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
    // (the file is settled on: the task keeps its name, so the record says which file and not the words it was asked for in)
    task.fileChosen(file.name, intent.file === null || intent.deictic === true ? 'the file just found or opened' : 'found on this PC');
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const target = this.target(app, intent.name);
    if ('ask' in target) return this.askWhich(app, intent.name, null, target.ask, file, task, this.usesPicker(app) ? 'share' : undefined);
    // An app with a "Select chats" step (WhatsApp Web) takes the file there: no chat is opened first, the name or number is typed in the step itself.
    if (this.usesPicker(app)) return this.shareFile(app, intent.name, target.query, file, task);
    return this.afterOpen(app, intent.name, null, await this.openChat(app, { query: target.query }, task), file, task);
  }

  // ------------------------------------------------------------------------------ a file through "Select chats"
  private usesPicker(app: ChatAppId): boolean {
    return ADAPTERS[app].shareDialog !== undefined && this.deps.fileRoute !== 'chat';
  }

  /** Calls a chat tool, opening the chat app first if the page in front is not it, and waiting (as long as the page says it is loading) until it can be worked in. */
  private async callWhenReady(
    app: ChatAppId,
    tool: string,
    args: ToolArgs,
    task: ChatTask,
  ): Promise<{ readonly kind: 'result'; readonly result: ToolResult } | { readonly kind: 'unavailable' } | { readonly kind: 'login' } | { readonly kind: 'slow' } | { readonly kind: 'blocked'; readonly say: string }> {
    let found = await this.call(task, tool, args);
    if (browserMissing(found)) return { kind: 'unavailable' };
    const stopped = this.blocked(found);
    if (stopped !== null) return { kind: 'blocked', say: stopped };
    const justOpened = found.summary === 'not a chat app';
    if (justOpened) {
      task.enter('OPEN_PLATFORM');
      const opened = await this.call(task, 'open_website', { url: ADAPTERS[app].url });
      if (browserMissing(opened)) return { kind: 'unavailable' };
      if (!opened.ok) return { kind: 'result', result: { ok: false, summary: 'could not open', error: opened.error ?? opened.summary, data: { status: 'error', reason: 'open_website' } } };
    }
    const status = (r: ToolResult): unknown => r.data?.['status'];
    const stillLoading = (r: ToolResult): boolean => r.summary === 'not a chat app' || status(r) === 'loading';
    if (stillLoading(found) || justOpened) {
      for (let attempt = 0; attempt < this.attempts; attempt += 1) {
        await this.sleep(LOAD_WAITS_MS[attempt] ?? LOAD_STEP_MS);
        found = await this.call(task, tool, args);
        if (browserMissing(found)) return { kind: 'unavailable' };
        if (status(found) === 'needs_login') return { kind: 'login' };
        if (!stillLoading(found)) break;
      }
    }
    if (status(found) === 'needs_login') return { kind: 'login' };
    if (stillLoading(found)) return { kind: 'slow' };
    return { kind: 'result', result: found };
  }

  /**
   * Sends a file through the chat app's own "Select chats" step: the file is given to the page, the name or number is typed in the step's search box, the person
   * is ticked, and — when the person's own request was to send it and the page identifies them exactly — Send is pressed; the chat that opens is then looked at for the
   * file and its delivery mark. Nothing is sent without that identification: a likely match or a doubtful earlier send is asked about first.
   */
  private async shareFile(app: ChatAppId, spokenName: string, query: string, file: FileToSend, task: ChatTask, choice?: number): Promise<LocalCommandResult | null> {
    task.enter('INSPECT_BROWSER');
    const args: ToolArgs = { path: file.path, authorized: true, ...(choice !== undefined ? { choice } : { to: query }) };
    const ready = await this.callWhenReady(app, 'share_file_to_chat', args, task);
    const name = CHAT_APPS[app].name;
    switch (ready.kind) {
      case 'blocked':
        task.fail('plugin_blocked', ready.say);
        return result(`${ready.say} Nothing was sent.`, false, 'chat_file', ['share_file_to_chat']);
      case 'unavailable':
        task.stepFailed('share_file_to_chat', 'browser_unavailable', 'no browser of the user is connected');
        return null; // the model knows how to help with that (connect_chrome)
      case 'slow':
        task.stepFailed('share_file_to_chat', 'page_slow', 'the chat app has not finished loading; the request is kept and tried again');
        return {
          ...result(`${name} is taking a long time to load, probably a slow connection. I'll keep trying and tell you as soon as it's ready.`, false, 'chat_file', ['share_file_to_chat']),
          pending: { kind: 'retry', why: `${name} is still loading`, retryAfterMs: 15_000 },
        };
      case 'login':
        task.stepFailed('share_file_to_chat', 'login_needed', 'waiting for the person to scan the QR code');
        return {
          ...result(`${name} is asking you to log in, with a QR code. Scan it with your phone and I'll carry on by myself.`, false, 'chat_file', ['share_file_to_chat']),
          pending: { kind: 'needs_you', why: `log in to ${name}`, watch: 'browser' },
        };
      case 'result':
        return this.afterShare(app, spokenName, file, ready.result, task);
    }
  }

  /** What to do with what the "Select chats" step answered (see share_file_to_chat): ask, say nobody was found, report the send, or take the other way. */
  private async afterShare(app: ChatAppId, spokenName: string, file: FileToSend, r: ToolResult, task: ChatTask): Promise<LocalCommandResult | null> {
    const tools = ['share_file_to_chat'];
    const data = r.data ?? {};
    const status = String(data['status'] ?? '');
    const recipient = typeof data['recipient'] === 'string' ? data['recipient'] : spokenName;
    const name = CHAT_APPS[app].name;
    if (browserMissing(r)) {
      task.fail('browser_unavailable', 'the browser dropped out before the file was sent');
      return result('I lost the connection to your browser, so nothing was sent.', false, 'chat_file', tools);
    }
    if (data['communicationAccess'] === 'off') {
      task.fail('chats_off', 'Communication Access is off for this app');
      return result(`Chats are off for ${name}. Turn Chats on in Eya's panel, then ask me again.`, false, 'chat_off', tools);
    }
    switch (status) {
      case 'sent':
      case 'pending':
      case 'failed':
      case 'unconfirmed':
      case 'not_found':
      case 'send_not_seen': {
        task.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
        task.enter('SEND');
        task.sendBegan();
        task.chose({ label: recipient, evidence: data['verifiedRecipient'] === true ? 'exact name' : 'a match', verified: data['verifiedRecipient'] === true, headerChecked: true });
        return this.reportSend({ app, label: recipient, spokenName }, status === 'send_not_seen' ? { ...r, data: { ...data, status: 'not_found' } } : r, tools, file.name, task);
      }
      case 'ambiguous': {
        task.enter('AWAIT_RECIPIENT_CLARIFICATION');
        const list = Array.isArray(data['candidates']) ? (data['candidates'] as Array<{ choice?: unknown; label?: unknown; phoneEnding?: unknown; masked?: unknown }>) : [];
        const options: Option[] = list.flatMap((c) =>
          typeof c.label === 'string'
            ? [{ label: c.label, ...(typeof c.choice === 'number' ? { choice: c.choice } : {}), ...(typeof c.phoneEnding === 'string' ? { ending: c.phoneEnding } : {}), ...(typeof c.masked === 'string' ? { masked: c.masked } : {}) }]
            : [],
        );
        return options.length > 0 ? this.askWhich(app, spokenName, null, options, file, task, 'share') : this.shareGaveUp(app, spokenName, task);
      }
      case 'ready_to_send': {
        // Somebody is ticked in the step, and nothing has been sent: a likely match, or a send like one begun earlier, is asked about first.
        task.chose({ label: recipient, evidence: String(data['evidence'] ?? 'a match'), verified: data['verified'] === true, headerChecked: false });
        task.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
        this.ask({ kind: 'send_file', app, label: recipient, spokenName, file, task, via: 'share' });
        return result(String(data['question'] ?? `Found ${recipient}. Send the file "${sayable(file.name)}"?`), true, 'chat_file', tools);
      }
      case 'none': {
        task.fail('chat_not_found', 'nobody in the chat picker fits the name: ask for another spelling or the number');
        await this.call(task, 'share_file_to_chat', { cancel: true });
        const said = typeof data['say'] === 'string' ? data['say'] : `I couldn't find anyone called ${spokenName} in ${name}. Tell me the name as it's saved there, or give me the number.`;
        return result(`${said} Nothing was sent.`, false, 'chat_file', tools);
      }
      case 'wrong_chat': {
        task.fail('wrong_chat', 'a different chat is open from the one chosen: nothing was sent');
        return result(`${name} showed a different chat from the one chosen, so I stopped and nothing was sent. Look at the chat and tell me what to do.`, false, 'chat_file', tools);
      }
      case 'not_attached':
      case 'not_available': {
        // The page would not take the file at its home screen (no file picker there, or an app without the step): the other way, through the chat itself.
        if (task.tryAgain('attach')) {
          const target = this.target(app, spokenName);
          if (!('ask' in target)) return this.afterOpen(app, spokenName, null, await this.openChat(app, { query: target.query }, task), file, task);
        }
        return this.shareGaveUp(app, spokenName, task);
      }
      case 'stale_selection':
      case 'not_selected':
      case 'picker_not_shown':
      case 'picker_stuck':
      case 'chat_stays_open': {
        // Something about the page's own step was not as expected: looked at again once, from the start, before giving up.
        if (task.tryAgain('share')) return this.shareFile(app, spokenName, spokenName, file, task);
        return this.shareGaveUp(app, spokenName, task);
      }
      default:
        return this.shareGaveUp(app, spokenName, task, typeof data['reason'] === 'string' ? data['reason'] : undefined);
    }
  }

  private shareGaveUp(app: ChatAppId, spokenName: string, task: ChatTask, reason?: string): LocalCommandResult {
    task.fail('attach_failed', `the chat picker did not work${reason !== undefined ? ` (${reason})` : ""}`);
    return result(
      `I couldn't send that through ${CHAT_APPS[app].name} just now${reason !== undefined ? ` (${browserReasonWords(reason)})` : ""}, so nothing was sent to ${sayable(spokenName)}. Say it again when you're ready and I'll start over.`,
      false,
      'chat_file',
      ['share_file_to_chat'],
    );
  }

  /** The user said yes to a file waiting in the "Select chats" step: Send is pressed there, and the chat that opens is checked. */
  private async shareFileNow(p: Extract<Pending, { kind: 'send_file' }>): Promise<LocalCommandResult> {
    const task = p.task;
    task?.enter('VERIFY_PREPARATION');
    const out = await this.call(task, 'share_file_to_chat', { path: p.file.path, to: p.label, confirm: true });
    if (task === undefined) return (await this.afterShareNoTask(p, out)) ?? result("I couldn't send that, so nothing was sent.", false, 'chat_file', ['share_file_to_chat']);
    return (await this.afterShare(p.app, p.spokenName, p.file, out, task)) ?? result('I lost the connection to your browser, so nothing was sent.', false, 'chat_file', ['share_file_to_chat']);
  }

  private async afterShareNoTask(p: Extract<Pending, { kind: 'send_file' }>, out: ToolResult): Promise<LocalCommandResult | null> {
    return this.afterShare(p.app, p.spokenName, p.file, out, this.begin(p.app, 'file', p.spokenName, p.file.name));
  }

  private async afterOpen(app: ChatAppId, spokenName: string, text: string | null, opened: Opened, file?: FileToSend, task?: ChatTask): Promise<LocalCommandResult | null> {
    const tools = ['find_chat'];
    const t = task ?? this.begin(app, file !== undefined ? 'file' : text !== null ? 'message' : 'open', spokenName, file?.name ?? text);
    switch (opened.kind) {
      case 'blocked':
        t.fail('plugin_blocked', opened.say);
        return result(`${opened.say} Nothing was sent.`, false, 'chat_message', tools);
      case 'unavailable':
        t.stepFailed('find_chat', 'browser_unavailable', 'no browser of the user is connected');
        return null; // no browser of the user's is connected: the model knows how to help with that (connect_chrome), so it takes over
      case 'slow': {
        const name = CHAT_APPS[app].name;
        t.stepFailed('find_chat', 'page_slow', 'the chat app has not finished loading; the request is kept and tried again');
        return {
          ...result(`${name} is taking a long time to load, probably a slow connection. I'll keep trying and tell you as soon as the chat is ready.`, false, 'chat_message', tools),
          pending: { kind: 'retry', why: `${name} is still loading`, retryAfterMs: 15_000 },
        };
      }
      case 'login': {
        const name = CHAT_APPS[app].name;
        t.stepFailed('find_chat', 'login_needed', 'waiting for the person to scan the QR code');
        return {
          ...result(`${name} is asking you to log in, with a QR code. Scan it with your phone and I'll carry on by myself.`, false, 'chat_message', tools),
          pending: { kind: 'needs_you', why: `log in to ${name}`, watch: 'browser' },
        };
      }
      case 'ambiguous':
        t.enter('AWAIT_RECIPIENT_CLARIFICATION');
        return this.askWhich(app, spokenName, text, opened.options, file, t);
      case 'none':
        t.fail('chat_not_found', 'no chat fits the name: ask for another spelling or the number');
        return result(opened.say ?? `I couldn't find a chat called ${spokenName} in ${CHAT_APPS[app].name}. Try the name as it's saved there.`, false, 'chat_message', tools);
      case 'failed':
        log.warn('could not open the chat', { why: opened.why });
        t.fail('open_failed', 'the chat was found but would not open');
        return result(opened.say, false, 'chat_message', tools);
      case 'opened':
        break;
    }
    // Who was chosen, and on what evidence: an exact name or a whole number is an identity; anything else is a likely match, and is said to be one.
    t.chose({ label: opened.label, evidence: opened.evidence, verified: opened.verified, headerChecked: opened.headerChecked });
    t.enter('OPEN_CONVERSATION');
    if (opened.headerChecked) t.enter('VERIFY_CONVERSATION');

    if (file !== undefined) {
      // Has this very file been sent to this chat already? Looked at, never found out by sending it again.
      const prior = await this.priorSend(t, opened.label, file.name, 'file');
      if (prior !== null && 'stop' in prior) return prior.stop;
      // Who it goes to is said before anything is attached; the yes that follows covers exactly this file and this chat — unless the person's own request
      // was to send it and the page has shown that this is the person (see coveredByRequest), when there is nothing left to ask.
      t.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
      const toSend = { kind: 'send_file' as const, app, label: opened.label, spokenName, file, task: t };
      if (this.coveredByRequest(opened, prior)) return this.sendFileNow(toSend);
      this.ask(toSend);
      const repeat = prior !== null && 'note' in prior ? ` ${prior.note}.` : '';
      return result(`${this.recipientLine(opened, spokenName)}.${repeat} Send the file "${sayable(file.name)}"?`, true, 'chat_file', tools);
    }
    if (text === null) {
      t.complete();
      return result(`Opened the chat with ${sayable(opened.label)}.`, true, 'chat_open', tools);
    }
    const prior = await this.priorSend(t, opened.label, text, 'text');
    if (prior !== null && 'stop' in prior) return prior.stop;
    // A plugin that may not send text messages is found out BEFORE anything is typed, so no message is left sitting in the box.
    const notAllowed = this.deps.permits?.(app, 'messages.send') ?? null;
    if (notAllowed !== null) {
      t.fail('plugin_blocked', notAllowed);
      return result(`${notAllowed} Nothing was typed or sent.`, false, 'chat_message', tools);
    }
    // Type it in the message box. Nothing is sent by this.
    t.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
    let typed = false;
    for (const label of ADAPTERS[app].composerLabels) {
      const filled = await this.call(t, 'fill_on_page', { label, value: text });
      if (filled.ok) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      t.fail('composer_missing', 'the message box was not found in the open chat');
      return result(`I opened the chat with ${sayable(opened.label)} but couldn't find the message box, so nothing was typed or sent.`, false, 'chat_message', [...tools, 'fill_on_page']);
    }
    t.enter('VERIFY_PREPARATION');
    const wasRefined = this.refined !== null && this.refined.text === text;
    const toSend = { kind: 'send' as const, app, label: opened.label, text, spokenName, task: t, ...(wasRefined && this.refined !== null ? { refined: { original: this.refined.original } } : {}) };
    // "Send 'where are u' to Anna" IS the instruction to send it: once the page has shown that the chat open is Anna's, the message is sent, not asked about again. (Not when Eya wrote the
    // message herself from a note: the person has not seen those words, so they are shown and a yes is waited for.)
    if (!wasRefined && this.coveredByRequest(opened, prior)) return this.send(toSend);
    this.ask(toSend);
    const shown = text.length > 300 ? `${text.slice(0, 297)}…` : text;
    const repeat = prior !== null && 'note' in prior ? ` ${prior.note}.` : '';
    if (wasRefined) return result(`${this.recipientLine(opened, spokenName)}.${repeat} I wrote it like this: "${shown}" Send it? Say yes to send, or tell me what to change.`, true, 'chat_message', [...tools, 'fill_on_page']);
    return result(`${this.recipientLine(opened, spokenName)}.${repeat} Send "${shown}"?`, true, 'chat_message', [...tools, 'fill_on_page']);
  }

  /**
   * Does the person's own request already cover this send? A request to send a message or a file to someone IS the instruction to send it. Once the page has shown
   * that the chat that is open is that person's — an exact name or a whole number (or the person's own choice among several), and the page's message box or header
   * named it — nothing is left to ask. A likely match, a chat the page did not confirm, and a send like one made or begun a moment ago are still asked about first.
   */
  private coveredByRequest(opened: Extract<Opened, { readonly kind: 'opened' }>, prior: { readonly stop: LocalCommandResult } | { readonly note: string } | null): boolean {
    return this.deps.confirmSends !== 'always' && opened.verified && opened.headerChecked && prior === null;
  }

  private askWhich(app: ChatAppId, spokenName: string, text: string | null, options: readonly Option[], file?: FileToSend, task?: ChatTask, via?: 'share'): LocalCommandResult {
    const shown = options.slice(0, 6);
    this.ask({ kind: 'which', app, text, ...(file !== undefined ? { file } : {}), spokenName, options: shown, ...(task !== undefined ? { task } : {}), ...(via !== undefined ? { via } : {}) });
    // (a chat listed under its phone number is read out with the number hidden down to its last four digits, never whole)
    const list = shown.map((o) => {
      const said = sayable(maskNumbersIn(o.label));
      const hidden = said.includes('•');
      return `${said}${o.masked !== undefined && !hidden ? ` (${o.masked})` : o.ending !== undefined && !hidden ? `, number ending in ${o.ending}` : ''}`;
    });
    const said = list.length === 2 ? `${list[0]} or ${list[1]}` : `${list.slice(0, -1).join('; ')}; or ${list[list.length - 1]}`;
    return result(`Which one: ${said}?`, true, 'chat_which', ['find_chat']);
  }

  // ---------------------------------------------------------------------------------- opening a chat
  /**
   * Opens the chat app if it is not the page in front, then finds the chat. Each call to find_chat reads the page as it is: the search is typed once
   * (see find_chat), so looking again while the page loads, or after a click that did not open the chat, never types it again.
   */
  private async openChat(app: ChatAppId, args: ToolArgs, task?: ChatTask): Promise<Opened> {
    task?.enter('INSPECT_BROWSER');
    let found = await this.call(task, 'find_chat', args);
    if (browserMissing(found)) return { kind: 'unavailable' };
    const stopped = this.blocked(found);
    if (stopped !== null) return { kind: 'blocked', say: stopped };
    const justOpened = found.summary === 'not a chat app';
    if (justOpened) {
      task?.enter('OPEN_PLATFORM');
      const opened = await this.call(task, 'open_website', { url: ADAPTERS[app].url });
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
        found = await this.call(task, 'find_chat', args);
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
    // The page is ready (a search box to type in) and the search was carried out: those steps happened, whatever the search found.
    if (['opened', 'ambiguous', 'none'].includes(String(status(found)))) {
      task?.enter('CHECK_LOGIN');
      task?.enter('SEARCH_CONTACT');
      task?.enter('EVALUATE_MATCHES');
    }
    // A click that did not open the chat: the page is looked at again ONCE (the row is found again in the page as it is now), not clicked on the old look.
    if (!found.ok && (found.summary === 'could not open the chat' || found.summary === 'the chat did not open') && (task === undefined || task.tryAgain('open_conversation'))) {
      found = await this.call(task, 'find_chat', args);
      if (browserMissing(found)) return { kind: 'unavailable' };
    }
    return this.readFound(found);
  }

  private readFound(found: ToolResult): Opened {
    const data = found.data ?? {};
    if (browserMissing(found)) return { kind: 'unavailable' };
    if (data['communicationAccess'] === 'off') return { kind: 'failed', say: "Chats are off for this app. Turn Chats on in Eya's panel, then ask me again.", why: 'communication_access_off' };
    if (data['status'] === 'not_opened') {
      return { kind: 'failed', say: "I clicked the chat but WhatsApp didn't open it (no message box came up), so nothing was typed or sent. Say it again and I'll try once more.", why: 'not_opened' };
    }
    if (data['status'] === 'wrong_chat') {
      const openedAs = typeof data['openedAs'] === 'string' ? data['openedAs'] : null;
      return { kind: 'failed', say: `A different chat opened from the one I clicked${openedAs !== null ? ` (WhatsApp's message box names it "${openedAs}")` : ''}, so nothing was typed or sent.`, why: 'wrong_chat' };
    }
    // The chat WAS found and clicked, and the page would not take the click: said as that, not as "something went wrong in the browser".
    if (data['status'] === 'failed') {
      const why = data['reason'] === 'not_found' ? 'it was no longer on the page when I clicked' : "the page wouldn't take the click";
      return { kind: 'failed', say: `I found the chat, but couldn't open it (${why}), so nothing was typed or sent. Say it again and I'll try once more.`, why: 'open_failed' };
    }
    if (!found.ok) {
      const reason = typeof data['reason'] === 'string' ? data['reason'] : undefined;
      return { kind: 'failed', say: `I couldn't look for that chat just now${reason !== undefined ? ` (${browserReasonWords(reason)})` : ""}, so nothing was typed or sent.`, why: found.error ?? found.summary };
    }
    switch (data['status']) {
      case 'opened':
        return {
          kind: 'opened',
          label: typeof data['chat'] === 'string' ? data['chat'] : 'the chat',
          ...(typeof data['numberEndsIn'] === 'string' ? { ending: data['numberEndsIn'] } : {}),
          verified: data['verified'] === true,
          evidence: typeof data['matchEvidence'] === 'string' ? data['matchEvidence'] : 'a match',
          headerChecked: data['headerChecked'] === true,
        };
      case 'ambiguous': {
        const list = Array.isArray(data['candidates']) ? (data['candidates'] as Array<{ choice?: unknown; label?: unknown; phoneEnding?: unknown; masked?: unknown }>) : [];
        const options: Option[] = list.flatMap((c) =>
          typeof c.label === 'string'
            ? [{ label: c.label, ...(typeof c.choice === 'number' ? { choice: c.choice } : {}), ...(typeof c.phoneEnding === 'string' ? { ending: c.phoneEnding } : {}), ...(typeof c.masked === 'string' ? { masked: c.masked } : {}) }]
            : [],
        );
        return options.length > 0 ? { kind: 'ambiguous', options } : { kind: 'none' };
      }
      case 'none':
        return { kind: 'none', ...(typeof data['say'] === 'string' ? { say: data['say'] } : {}) };
      default:
        return { kind: 'failed', say: 'I found the chat but could not open it, so nothing was typed or sent.', why: String(data['status'] ?? found.summary) };
    }
  }

  private async openChatOnly(named: ChatAppId | null, spokenName: string): Promise<LocalCommandResult | null> {
    const app = this.appFor(named);
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const step = this.recipientStep(app, { kind: 'open_chat', app: named, name: spokenName }, spokenName);
    if (step !== null) return step.done;
    const task = this.begin(app, 'open', spokenName, null);
    const target = this.target(app, spokenName);
    if ('ask' in target) return this.askWhich(app, spokenName, null, target.ask, undefined, task);
    const opened = await this.openChat(app, { query: target.query }, task);
    return this.afterOpen(app, spokenName, null, opened, undefined, task);
  }

  // ------------------------------------------------------------------------------------------------- the live chat companion
  /**
   * "Start live chat with Rahul", "stop live chat", "pause/resume live chat", "confirm live chat". The Live Chat Companion itself decides everything (it checks the
   * plugin's permission and Communication Access, opens the chat through the same tools, and never sends on its own); this only carries the person's words to it.
   */
  private async liveChat(intent: Extract<ChatIntent, { kind: 'live_chat' }>): Promise<LocalCommandResult | null> {
    const live = this.deps.liveChat;
    if (live === undefined) return null;
    const app = this.appFor(intent.app);
    if (app !== 'whatsapp') return result('The live chat works with WhatsApp only for now.', false, 'chat_live');
    let request: LiveChatRequest;
    switch (intent.action) {
      case 'start': {
        // "do live chat now go", said straight after an earlier request that named her: that one (what was said about her carries over only when this one names nobody).
        const last = this.lastLive !== null && this.now() - this.lastLive.at < PENDING_MS ? this.lastLive : null;
        // (also when the earlier request named nobody and this one does: "do live chat, make her happy" … "ok with 9361113900")
        const carried = last !== null && (intent.name === undefined || last.name === null) ? last : null;
        const name = intent.name ?? last?.name ?? null;
        const purpose = intent.purpose ?? carried?.purpose ?? '';
        const opening = intent.opening === true || carried?.opening === true;
        const unaware = intent.unaware === true || carried?.unaware === true;
        const aware = !unaware && (intent.aware === true || carried?.aware === true);
        this.lastLive = { name, purpose, opening, aware, unaware, at: this.now() };
        if (name === null) return result('Who should I do the live chat with? Tell me her name or her phone number, for example "do live chat with 9361113900", and I will use what you just told me.', true, 'chat_live');
        this.liveFollow = { aware, unaware, opening, at: this.now() };
        // ("knows": what the person SAID in this request about her — that she knows, or that she does not; nothing said is nothing. The one Enable live chat switch is the standing yes when nothing was said.)
        // Who the other person is decides how Eya sounds (a friend, a partner, a sir, family, a client): it is read from what was said, or remembered from last time, or ASKED — once, before
        // the live chat starts, and then remembered.
        const said = intent.relation ?? relationFrom(purpose);
        const relation = said ?? this.deps.relations?.get(name) ?? null;
        if (said !== null && said !== undefined) this.deps.relations?.set(name, said);
        if (relation === null && this.deps.relations !== undefined) {
          this.ask({ kind: 'live_relation', intent, name });
          return result(`Who is ${maskNumbersIn(name)} to you? Say friend, family, sir or boss, partner (girlfriend, wife, husband…), client, or other. I'll chat the way that fits, short and natural like a real person, and not in a big paragraph.`, true, 'chat_live');
        }
        request = { kind: 'start', name, ...(intent.mode !== undefined ? { mode: intent.mode } : {}), ...(purpose !== '' ? { purpose } : {}), ...(opening ? { opening: true } : {}), ...(aware ? { knows: true } : unaware ? { knows: false } : {}), ...(relation !== null ? { relation } : {}) };
        break;
      }
      case 'stop':
        request = intent.all === true ? { kind: 'stop', all: true } : { kind: 'stop' };
        break;
      case 'pause':
        request = { kind: 'pause' };
        break;
      case 'resume':
        request = { kind: 'resume' };
        break;
      case 'confirm':
        request = { kind: 'confirm_chat' };
        break;
      case 'choose':
        if (intent.choice === undefined) return null;
        request = { kind: 'choose', choice: intent.choice };
        break;
      case 'auto': {
        const v = live.view();
        if (!v.active) return null; // no live chat running: not about one, so the model can have it
        return this.askLiveAuto(v);
      }
      case 'status': {
        const v = live.view();
        return result(v.active ? `The live chat with ${sayable(v.chat ?? 'a chat')} is ${v.state.toLowerCase().replace(/_/g, ' ')}${v.draft !== null ? ', and a reply is waiting for you' : ''}.` : 'There is no live chat running.', true, 'chat_live', ['live_chat']);
      }
    }
    const done = await live.handle(request);
    const waiting = done.view.state === 'WAITING_FOR_USER' ? (done.view.choices.length > 0 ? ` Options: ${done.view.choices.map((c) => `${c.choice}. ${sayable(c.label)}`).join(', ')}. Say "live chat option" and the number, or choose on the Live chat page.` : done.view.confirmChat !== null ? ' Say "confirm live chat" if that is the right chat, or confirm it on the Live chat page.' : '') : '';
    if (intent.action === 'start' && !done.ok) {
      this.liveFollow = null;
      return result(`${done.message}${this.liveStartHelp(done)}`, false, 'chat_live', ['live_chat']);
    }
    // What the person said about the other person (that she knows it is Eya), and that they asked Eya to write first, is acted on as soon as the chat is the confirmed one —
    // never before, and never for anyone but the chat the person chose.
    if ((intent.action === 'start' || intent.action === 'confirm' || intent.action === 'choose') && done.ok) {
      const followed = await this.liveFollowUp(done);
      if (followed !== null) return followed;
    }
    // "…and reply automatically": the question that switches it on is asked as soon as the chat is the confirmed one (never switched on by those words alone)
    if (intent.autoAsked === true && done.ok) {
      if (done.view.state === 'ACTIVE' && done.view.verified) return this.askLiveAuto(done.view, done.message);
      return result(`${done.message}${waiting} When the chat is confirmed, say "turn on auto reply" and I will ask you the one question that switches it on.`, done.ok, 'chat_live', ['live_chat']);
    }
    return result(`${done.message}${waiting}`, done.ok, 'chat_live', ['live_chat']);
  }

  /**
   * "Tell her I will call at 6": the person's own words, sent to the person in the live chat as their message (see LiveChatController.relay: every send check still applies).
   * Only while a live chat is running; "reply: …" (no "her") only soon after the other person had something for them. Said back as what was sent, or as why not.
   */
  private async relayToLive(text: string): Promise<LocalCommandResult | null> {
    const live = this.deps.liveChat;
    if (live === undefined) return null;
    const v = live.view();
    if (!v.active) return null; // no live chat running: these words are not about one, and the model (or a message to somebody) has them, as before
    const relay = parseRelay(text);
    if (relay === null) return null;
    const recent = v.forYou.some((n) => this.now() - n.at < RELAY_WINDOW_MS);
    if (relay.to === undefined && !recent) return null; // ("reply: …" with nothing to reply to)
    const who = sayable(v.chat ?? 'the chat');
    const done = await live.handle({ kind: 'relay', text: relay.text });
    const owner = v.enable.ownerName;
    const sent = owner !== '' ? `${owner} says: ${relay.text}` : relay.text;
    return result(done.ok ? (v.mode === 'draft' ? done.message : `Done. I told ${who}: "${sent}".`) : done.message, done.ok, 'chat_live', ['live_chat']);
  }

  /** What to do next when a live chat could not start for a reason the person can fix (the plugin's permission, the browser extension, Chats): said as steps, never as a refusal. */
  private liveStartHelp(done: LiveChatResult): string {
    const name = this.lastLive?.name;
    const again = name !== undefined && name !== null ? ` Then say "do live chat now go" and I will start it with ${maskNumbersIn(name)}.` : ' Then tell me again who it is for.';
    // (one switch for all of it: WhatsApp allowed in Eya and the plugin's find / live-chat / send permissions — and only the person's own click on the page can turn it on)
    if (/Live chat companion|Plugins page|Chats are switched off|permission/i.test(done.message)) return ' To allow it, open Live chat in Eya and switch on "Enable live chat": one switch that allows everything the live chat needs (I cannot switch it on for you).' + again;
    return '';
  }

  /** The start of a live chat has been confirmed as the right chat: switch automatic replies on if the person said the other person knows, otherwise ask the one question. */
  private async liveFollowUp(done: LiveChatResult): Promise<LocalCommandResult | null> {
    const follow = this.liveFollow;
    const live = this.deps.liveChat;
    if (follow === null || live === undefined || this.now() - follow.at > PENDING_MS) return null;
    // (running: also while the first message is being written or a reply is on its way; not yet: a chat that still has to be confirmed or chosen, asked again when it is)
    if (!done.view.verified || !['ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'SENDING', 'VERIFYING'].includes(done.view.state)) return null;
    this.liveFollow = null;
    const who = sayable(done.view.chat ?? 'the chat');
    const lead = `Live chat is on with ${who}.`;
    const auto = done.view.auto;
    if (auto !== null) {
      // Automatic replies started when the chat was confirmed: on the person's word in this request ("she knows"), or on the one Enable live chat switch.
      const basis = follow.aware ? `You said ${who} knows it is Eya writing.` : "Your Enable live chat switch is on, so I answer by myself and do not ask each time.";
      return result(`${lead} Automatic replies are ON: I answer each new message as it comes in, ${autoLimitsSaid(auto, this.now())}, at least ${auto.minGapSeconds} seconds apart. ${basis}${follow.opening ? ' I am introducing myself in the chat now.' : ''} Say "pause live chat" to hold it, or "stop live chat" to end it.`, true, 'chat_live', ['live_chat']);
    }
    if (follow.unaware) {
      // (the person said she does not know: nothing is sent by itself, and nothing is asked — there is nothing she could be taken to have agreed to)
      return result(`${lead} You said ${who} does not know it is Eya, so I only write replies for you to review and never send anything by myself.`, true, 'chat_live', ['live_chat']);
    }
    if (!done.view.sendAllowed) {
      return result(`${lead} I am watching it and will write replies for you to review. I cannot reply on my own until Eya is allowed to send: switch on "Enable live chat" on the Live chat page.`, true, 'chat_live', ['live_chat']);
    }
    if (follow.aware || done.view.enable.ready) {
      // (it was asked for, and could not be switched on: the reason is the controller's)
      return result(`${lead} ${done.view.notice ?? 'I could not switch on automatic replies.'}`, true, 'chat_live', ['live_chat']);
    }
    return this.askLiveAuto(done.view, lead, follow.opening);
  }

  /** The one question that switches automatic replies on: what it will do, the limits, and that the other person must know and agree. Only the person's yes answers it. */
  private askLiveAuto(v: LiveChatView, lead?: string, opening = false): LocalCommandResult {
    if (!v.verified || !v.sendAllowed) {
      return result(`${lead !== undefined ? `${lead} ` : ''}Automatic replies cannot be switched on yet: the chat has to be confirmed, and Eya needs to be allowed to send (the plugin's "Send text messages" permission, and Chats on).`, false, 'chat_live');
    }
    const who = sayable(v.chat ?? 'this chat');
    this.ask({ kind: 'live_auto', label: who });
    return result(
      `${lead !== undefined ? `${lead} ` : ''}Auto-reply means I will answer ${who} myself as each message comes in, without asking you each time, and keep going until you pause or stop it (at least 10 seconds between two replies). I never send passwords, codes or card numbers and never make up a time, an amount or a link, and you can say "pause live chat" or "stop live chat" at any moment.${opening ? ' I will start by introducing myself in the chat as Eya, your assistant, and ask what they want.' : ''} ${who} must know and agree that replies in this chat are written with AI help. Is that so? Say yes to switch it on, or no to keep it as it is. (To never be asked this, switch on "Enable live chat" on the Live chat page.)`,
      true,
      'chat_live',
      ['live_chat'],
    );
  }

  // --------------------------------------------------------------------------------------- finding a file in the chats
  /**
   * "Check this file where it is in WhatsApp": reads WhatsApp's own list of documents (find_chat_files — read-only, nothing is sent), and says where the file is. "This
   * file" is the one Eya has just found or opened. A task is not kept for it: nothing here is sent, so there is nothing to carry on or to repeat.
   */
  private async findFiles(intent: Extract<ChatIntent, { kind: 'find_files' }>): Promise<LocalCommandResult | null> {
    const app = this.appFor(intent.app);
    const refused = this.refusal(app);
    if (refused !== null) return refused;
    const name = CHAT_APPS[app].name;
    const { request } = intent;
    let words = request.words;
    if (request.deictic) {
      const last = this.deps.lastFile?.() ?? null;
      if (last === null) return result(`Which file do you mean? Tell me its name, or part of it, and I'll look for it in ${name}.`, true, 'chat_files');
      words = last.name; // "Resume Rakesh.pdf": the name is looked for, words and type
    }
    if (words === '' && request.when === undefined && request.from === undefined && request.direction === 'any') {
      return result(`Which file? Tell me its name, or part of it, or when it was sent, and I'll look for it in ${name}.`, true, 'chat_files');
    }
    const args: ToolArgs = {
      ...(words !== '' ? { file: words } : {}),
      ...(request.when !== undefined ? { when: request.when } : {}),
      ...(request.from !== undefined ? { from: request.from } : {}),
      direction: request.direction,
    };
    // (not registered anywhere: it only lets the shared "open the app and wait until it has loaded" steps run for a request that has nothing to keep)
    const scratch = new ChatTask(app, 'open', { query: 'files', isNumber: false }, null, undefined, this.now);
    const ready = await this.callWhenReady(app, 'find_chat_files', args, scratch);
    switch (ready.kind) {
      case 'blocked':
        return result(ready.say, false, 'chat_files', ['find_chat_files']);
      case 'unavailable':
        return null; // the model knows how to help with that (connect_chrome)
      case 'slow':
        return result(`${name} is taking a long time to load, probably a slow connection. Ask me again in a moment and I'll look.`, false, 'chat_files', ['find_chat_files']);
      case 'login':
        return result(`${name} is asking you to log in, with a QR code. Scan it with your phone and ask me again.`, false, 'chat_files', ['find_chat_files']);
      case 'result': {
        const r = ready.result;
        const said = typeof r.data?.['say'] === 'string' ? r.data['say'] : null;
        if (!r.ok || said === null) return result(r.error ?? `I could not look for that file in ${name}. Nothing was changed.`, false, 'chat_files', ['find_chat_files']);
        // (the list does not show who a file went to: when the person said, and the chat found is someone else's, that is said)
        const chat = typeof r.data?.['chat'] === 'string' ? r.data['chat'] : null;
        const mismatch = chat !== null && request.to !== undefined && !/\d{3,}/.test(chat) && !normalizeText(chat).includes(normalizeText(request.to));
        const toName = sayable(request.to ?? '').replace(/(^|\s)(\p{L})/gu, (_m, space: string, letter: string) => `${space}${letter.toUpperCase()}`); // (the request was read in lower case)
        return result(mismatch ? `${said} You said it went to ${toName}; the chat I found is ${sayable(chat as string)}.` : said, true, 'chat_files', ['find_chat_files']);
      }
    }
  }

  // ------------------------------------------------------------------------------ answers to a question
  /** The reply to the question just asked. `undefined` means it was not an answer (so it is a new request). */
  private async answer(pending: Pending, reply: string): Promise<LocalCommandResult | undefined> {
    if (pending.kind === 'which') return this.answerWhich(pending, reply);
    if (pending.kind === 'recipient') return this.answerRecipient(pending, reply);
    if (pending.kind === 'live_relation') return this.answerRelation(pending, reply);
    let yn = parseYesNo(reply);
    if (yn === null && pending.kind === 'send') {
      // (a person asked the same thing again says so crossly: "send, why are you asking me again" is a yes; and a change asked for in the written message is made, not taken for a new request)
      if (isImpatientYes(reply)) yn = 'yes';
      else if (pending.refined !== undefined && this.deps.refine !== undefined && looksLikeEdit(reply)) return this.editRefined(pending, pending.refined.original, reply);
    }
    if (yn === null) return undefined;
    this.pending = null;
    if (pending.kind === 'live_auto') {
      const live = this.deps.liveChat;
      if (live === undefined) return undefined;
      if (yn === 'no') return result('Okay. No automatic replies: the live chat stays as it is, and replies wait for you.', true, 'chat_live');
      // (the person said yes to exactly the question that was asked: that the other person knows and agrees, and the limits)
      const on = await live.handle({ kind: 'enable_auto', confirmedAware: true });
      return result(on.message, on.ok, 'chat_live', ['live_chat']);
    }
    if (pending.kind === 'send') {
      if (yn === 'no') {
        this.deps.session.sendCancelled();
        pending.task?.fail('declined', 'the person said no');
        return result("Okay, I won't send it. The message is still typed in the box if you want it.", true, 'chat_cancel');
      }
      return this.send(pending);
    }
    if (pending.kind === 'send_file') {
      if (yn === 'no') {
        pending.task?.fail('declined', 'the person said no');
        // (a file waiting in the app's "Select chats" step is taken out of it: nothing is left half-done on the page)
        if (pending.via === 'share') await this.call(pending.task, 'share_file_to_chat', { cancel: true });
        return result(pending.via === 'share' ? "Okay, I won't send it. Nothing was sent." : "Okay, I won't send it. Nothing was attached.", true, 'chat_cancel');
      }
      return pending.via === 'share' ? this.shareFileNow(pending) : this.sendFileNow(pending);
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

  /** The answer to "Who is she to you?": the live chat starts, with that. A reply that names nobody is not an answer (the question lapses and it is an ordinary request). */
  private async answerRelation(p: Extract<Pending, { kind: 'live_relation' }>, reply: string): Promise<LocalCommandResult | undefined> {
    if (parseYesNo(reply) === 'no') {
      this.pending = null;
      return result("Okay, I won't start the live chat.", true, 'chat_live');
    }
    const relation = relationFrom(reply);
    if (relation === null) return undefined;
    this.pending = null;
    // (the start below remembers it: it comes back through the request with the relation said, which is what writes it to the book)
    const started = await this.liveChat({ ...p.intent, relation });
    return started === null ? undefined : { ...started, spoken: `Okay, ${RELATION_LABEL[relation]}. ${started.spoken}` };
  }

  /** The person asked for a change in the message Eya wrote: it is written again, typed again (replacing what is in the box), shown, and asked about again. */
  private async editRefined(p: Extract<Pending, { kind: 'send' }>, original: string, change: string): Promise<LocalCommandResult> {
    const refine = this.deps.refine as (input: RefineInput) => Promise<string>;
    const next = await refine({ text: original, draft: p.text, change });
    let typed = false;
    for (const label of ADAPTERS[p.app].composerLabels) {
      const filled = await this.call(p.task, 'fill_on_page', { label, value: next });
      if (filled.ok) {
        typed = true;
        break;
      }
    }
    if (!typed) {
      this.pending = null;
      return result("I couldn't change the message in the box, so nothing was sent. Say it again and I'll start over.", false, 'chat_message', ['fill_on_page']);
    }
    this.refined = { text: next, original };
    this.ask({ ...p, text: next, refined: { original } });
    const shown = next.length > 300 ? `${next.slice(0, 297)}…` : next;
    return result(`Changed. I'll send: "${shown}" Send it? Say yes, or tell me what else to change.`, true, 'chat_message', ['fill_on_page']);
  }

  private async answerWhich(pending: Extract<Pending, { kind: 'which' }>, reply: string): Promise<LocalCommandResult | undefined> {
    const picked = this.pick(pending.options, reply);
    if (picked === 'unclear') {
      this.ask(pending); // still waiting
      return result(`I'm not sure which. Say the number, or more of the name.`, true, 'chat_which', ['find_chat']);
    }
    if (picked === null) return undefined;
    this.pending = null;
    // The person has chosen: that is who it is for (and what they said is not asked again). The task goes on from the choice, not from the start.
    if (pending.via === 'share' && pending.file !== undefined && pending.task !== undefined) {
      return (await this.shareFile(pending.app, pending.spokenName, picked.label, pending.file, pending.task, picked.choice)) ?? undefined;
    }
    const opened: Opened =
      picked.choice !== undefined
        ? this.readFound(await this.call(pending.task, 'find_chat', { choice: picked.choice }))
        : await this.openChat(pending.app, { query: picked.label }, pending.task);
    return (await this.afterOpen(pending.app, pending.spokenName, pending.text, opened, pending.file, pending.task)) ?? undefined;
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
  /**
   * The user said yes: press Send and check that it really went. What is known about the send is kept BEFORE the click (it was begun), so that a
   * result that is not clear (a timeout, a page that shows nothing) leaves "begun, outcome unknown" behind, which is looked at before anything is
   * sent again. A yes does not cover a Send in a different chat from the one chosen: the tools refuse that click, and nothing is sent.
   */
  private async send(p: Extract<Pending, { kind: 'send' }>): Promise<LocalCommandResult> {
    const tools = ['click_on_page'];
    const task = p.task;
    task?.enter('SEND');
    this.deps.session.noteSend(p.label, p.text, 'attempted');
    const click = await this.call(task, 'click_on_page', { text: ADAPTERS[p.app].sendLabel, confirm: true });
    if (!click.ok) {
      log.warn('could not press Send', { why: click.error ?? click.summary });
      this.deps.session.noteSend(p.label, p.text, 'failed');
      const refused = this.blocked(click);
      if (refused !== null) {
        task?.fail('plugin_blocked', refused);
        return result(`${refused} Nothing was sent.`, false, 'chat_send', tools);
      }
      if (click.data?.['status'] === 'wrong_chat') {
        task?.fail('wrong_chat', 'the chat that is open is not the one chosen: nothing was sent');
        return result(`The chat that is open is not the chat with ${sayable(p.label)} any more, so nothing was sent.`, false, 'chat_send', tools);
      }
      task?.fail('send_failed', 'the Send control could not be pressed');
      return result(`I couldn't press Send, so nothing was sent to ${sayable(p.label)}.`, false, 'chat_send', tools);
    }
    task?.sendBegan();
    const checked = await this.call(task, 'verify_sent', { text: p.text });
    tools.push('verify_sent');
    return this.reportSend(p, checked, tools, undefined, task);
  }

  /** The user said yes to a file: put it on the chat's attach step (opening the app's attach menu if it needs that), press Send, check it went. */
  private async sendFileNow(p: Extract<Pending, { kind: 'send_file' }>): Promise<LocalCommandResult> {
    const used = ['attach_file'];
    const task = p.task;
    const adapter = ADAPTERS[p.app];
    task?.enter('PREPARE_MESSAGE_OR_ATTACHMENT');
    const give = (): Promise<ToolResult> => this.call(task, 'attach_file', { path: p.file.path, confirm: true });
    let attached = await give();
    if (!attached.ok && attached.summary === 'no file picker yet') {
      // Chat apps keep their file inputs hidden until the attach menu has been opened (the tool says so). Open it — nothing is chosen or sent by that.
      const opened = await this.call(task, 'click_on_page', { text: adapter.attachLabel });
      used.push('click_on_page');
      if (opened.ok && (task === undefined || task.tryAgain('attach'))) attached = await give();
    }
    if (browserMissing(attached)) {
      task?.fail('browser_unavailable', 'the browser dropped out before the file was attached');
      return result('I lost the connection to your browser, so nothing was sent.', false, 'chat_send', used);
    }
    const attachRefused = this.blocked(attached);
    if (attachRefused !== null) {
      task?.fail('plugin_blocked', attachRefused);
      return result(`${attachRefused} Nothing was sent.`, false, 'chat_send', used);
    }
    if (attached.data?.['status'] === 'wrong_chat') {
      task?.fail('wrong_chat', 'the chat that is open is not the one chosen: nothing was attached');
      return result(`The chat that is open is not the chat with ${sayable(p.label)} any more, so nothing was attached or sent.`, false, 'chat_send', used);
    }
    if (!attached.ok || attached.data?.['status'] !== 'attached_not_sent') {
      log.warn('could not attach the file', { why: attached.error ?? attached.summary });
      task?.fail('attach_failed', 'the page did not take the file, or never showed it');
      return result(`I couldn't put "${sayable(p.file.name)}" on the chat with ${sayable(p.label)}, so nothing was sent.`, false, 'chat_send', used);
    }
    // (the page showed the attachment: that is the evidence the preparation is done, and the file is the one chosen)
    task?.enter('VERIFY_PREPARATION');
    task?.enter('SEND');
    this.deps.session.noteSend(p.label, p.file.name, 'attempted');
    const click = await this.call(task, 'click_on_page', { text: adapter.sendLabel, confirm: true });
    used.push('click_on_page');
    if (!click.ok) {
      log.warn('could not press Send for the file', { why: click.error ?? click.summary });
      this.deps.session.noteSend(p.label, p.file.name, 'failed');
      const sendRefused = this.blocked(click);
      if (sendRefused !== null) {
        task?.fail('plugin_blocked', sendRefused);
        return result(`${sendRefused} The file is waiting in the chat but was not sent.`, false, 'chat_send', used);
      }
      task?.fail(click.data?.['status'] === 'wrong_chat' ? 'wrong_chat' : 'send_failed', 'the Send control could not be pressed; the file is waiting in the chat');
      return result(`The file is waiting in the chat with ${sayable(p.label)}, but I couldn't press Send, so it was not sent.`, false, 'chat_send', used);
    }
    task?.sendBegan();
    const checked = await this.call(task, 'verify_sent', { name: p.file.name });
    used.push('verify_sent');
    return this.reportSend({ app: p.app, label: p.label, spokenName: p.spokenName }, checked, used, p.file.name, task);
  }

  /**
   * What to tell the user after Send was pressed and verify_sent looked: only "sent" is said when the app really showed it went. Everything else is
   * said as what it is, and leaves the send marked as not known, so that it is looked at (not repeated) if the same thing is asked for again.
   */
  private reportSend(p: { readonly app: ChatAppId; readonly label: string; readonly spokenName: string }, checked: ToolResult, tools: string[], file?: string, task?: ChatTask): LocalCommandResult {
    const status = checked.data?.['status'];
    task?.enter('VERIFY_SENT_RESULT');
    if (status === 'sent') {
      // How far it got is what the page's own mark says (sent, delivered, read): never more than that, and never "read" without the page showing it.
      const mark = typeof checked.data?.['mark'] === 'string' ? checked.data['mark'] : undefined;
      task?.sendSeen(mark);
      task?.complete();
      this.remember(p.app, p.label, p.spokenName);
      const shown = mark === undefined ? '' : mark === 'sent' ? " WhatsApp shows it as sent, not yet delivered." : mark === 'delivered' ? ' WhatsApp shows it as delivered.' : ` WhatsApp shows it as ${mark}.`;
      let spoken = (file === undefined ? `Sent to ${sayable(p.label)}.` : `Sent "${sayable(file)}" to ${sayable(p.label)}.`) + shown;
      if (this.deps.contacts.learning() === 'unasked') {
        spoken += ` By the way, I can remember the names in your ${CHAT_APPS[p.app].name} so I find chats instantly next time — names only, kept on this PC, never messages. Want that? Say yes or no.`;
        this.ask({ kind: 'consent', app: p.app, label: p.label, spokenName: p.spokenName });
      }
      return result(spoken, true, 'chat_send', tools);
    }
    if (status === 'failed') {
      task?.fail('send_failed', 'the app shows the send as failed');
      return result(`It failed to send to ${sayable(p.label)}.`, false, 'chat_send', tools);
    }
    // From here the outcome is not known: it may have gone. It is never sent again without looking at the chat first (see priorSend).
    task?.fail('send_uncertain', 'Send was pressed but the chat did not show the result: look at the chat before sending again');
    if (status === 'pending') return result(`It's in the chat with ${sayable(p.label)}, but the app still shows it as sending, so I can't say it went yet.`, false, 'chat_send', tools);
    log.info('send not confirmed', { status });
    if (status === 'not_found') return result(`I pressed Send, but I can't see ${file === undefined ? 'the message' : 'the file'} in the chat with ${sayable(p.label)}, so I can't say it was sent. I won't send it again without checking the chat first.`, false, 'chat_send', tools);
    return result(`It's in the chat with ${sayable(p.label)}, but the app hasn't shown that it was sent yet, so I can't confirm it. I won't send it again without checking the chat first.`, false, 'chat_send', tools);
  }

  /** After a confirmed send: this chat is one the user uses, and what they called it is what it means from now on. */
  private remember(app: ChatAppId, label: string, spokenName: string): void {
    const { contacts } = this.deps;
    contacts.used(app, label);
    // (only what the person NAMED the chat is kept as its name: never "him", "the last person I messaged", or digits of a phone number)
    if (normalizeText(spokenName) !== normalizeText(label) && readRecipientReference(spokenName, this.country()).kind === 'name') contacts.addAlias(app, label, spokenName);
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
    const learnRefused = this.blocked(read);
    if (learnRefused !== null) return result(`${learnRefused} I have not kept any names.`, false, 'chat_names');
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
  | { readonly kind: 'opened'; readonly label: string; readonly ending?: string; readonly verified: boolean; readonly evidence: string; readonly headerChecked: boolean }
  | { readonly kind: 'ambiguous'; readonly options: readonly Option[] }
  | { readonly kind: 'none'; readonly say?: string }
  /** The plugin for this chat app is off, not connected, or has not been given the permission: said as it is, and nothing is done. */
  | { readonly kind: 'blocked'; readonly say: string }
  /** None of the user's browsers is connected to Eya: nothing was done, and the model can help connect one. */
  | { readonly kind: 'unavailable' }
  /** The chat app is still loading after a long wait (a slow connection): the task is kept and carried on by itself. */
  | { readonly kind: 'slow' }
  /** The chat app is asking the user to log in (the QR code): they have to do that themselves. */
  | { readonly kind: 'login' }
  | { readonly kind: 'failed'; readonly say: string; readonly why: string };

/** The same request, for the person who was settled on (it was "him" or "the person I messaged yesterday"; now it is that person's name). */
function withRecipient(intent: ChatIntent, name: string): ChatIntent {
  switch (intent.kind) {
    case 'message': {
      const { rest: _rest, ...plain } = intent;
      return { ...plain, name };
    }
    case 'open_chat':
    case 'send_file':
      return { ...intent, name };
    default:
      return intent;
  }
}

/** A tool's way of saying "no browser of the user's is reachable" (its text is for the model, so it is never read out). */
function browserMissing(r: ToolResult): boolean {
  return r.data?.['browserUnavailable'] === true;
}
