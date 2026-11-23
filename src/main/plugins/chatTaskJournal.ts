import { maskNumbersIn } from '@main/chat/recipientResolver';
import type { ChatTask, ChatTaskObserver, ChatTaskState, FailureCategory, Selection } from '@main/chat/chatTask';
import type { TaskEntity, TaskPhase } from '@shared/tasks';
import { SEND_PRESSED } from '@main/tasks/TaskCompleter';

/** What a task kept through a plugin is told (see TaskCompleter.beginPlugin and the methods beside it). */
export interface PluginTaskSink {
  beginPlugin(info: { readonly key: string; readonly plugin: string; readonly action: string; readonly title: string }): void;
  pluginUpdate(key: string, change: { readonly phase?: TaskPhase; readonly title?: string; readonly note?: string; readonly entity?: TaskEntity; readonly evidence?: string; readonly question?: string | null }): void;
  pluginFinish(key: string, outcome: 'completed' | 'failed' | 'cancelled' | 'uncertain', note: string): void;
}

/** Which plugin stands for a chat app. An app with no plugin (yet) is not kept as a plugin task. */
const PLUGIN_OF_APP: Readonly<Record<string, string>> = { whatsapp: 'whatsapp' };
const APP_NAME: Readonly<Record<string, string>> = { whatsapp: 'WhatsApp', telegram: 'Telegram' };

const ACTION_OF: Readonly<Record<string, string>> = { message: 'send_message', file: 'send_file', open: 'find_chat' };

/** Where in the order of a task each step of a chat request sits. */
export function phaseOfState(state: ChatTaskState): TaskPhase {
  switch (state) {
    case 'PARSE_REQUEST':
      return 'received';
    case 'RESOLVE_FILE':
    case 'RESOLVE_RECIPIENT':
    case 'INSPECT_BROWSER':
    case 'OPEN_PLATFORM':
    case 'CHECK_LOGIN':
    case 'SEARCH_CONTACT':
    case 'EVALUATE_MATCHES':
      return 'planning';
    case 'AWAIT_RECIPIENT_CLARIFICATION':
      return 'waiting_clarification';
    case 'OPEN_CONVERSATION':
    case 'VERIFY_CONVERSATION':
    case 'PREPARE_MESSAGE_OR_ATTACHMENT':
    case 'VERIFY_PREPARATION':
    case 'SEND':
      return 'executing';
    case 'VERIFY_SENT_RESULT':
      return 'verifying';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
  }
}

const capital = (s: string): string => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));

/**
 * Keeps every chat request as a task through the plugin that stands for its app: what it is, who it settled on and on what evidence, what was seen to
 * happen (the Send being pressed, the chat showing it as sent), and where it stands. Written as it happens — the Send being pressed is on disk before the
 * check that follows it — so that a restart in between leaves a task that says "may already have gone", never one that looks as if nothing happened.
 *
 * What is kept holds no message and no whole phone number: a recipient shown by its number is kept masked, and the words of a message are not kept at all.
 */
export class ChatTaskJournal implements ChatTaskObserver {
  private readonly begun = new Set<string>();
  private readonly phases = new Map<string, TaskPhase>();
  private readonly who = new Map<string, string>();
  private readonly file_ = new Map<string, string>();

  constructor(private readonly sink: PluginTaskSink) {}

  private plugin(task: ChatTask): string | null {
    return PLUGIN_OF_APP[task.platform] ?? null;
  }

  private title(task: ChatTask): string {
    const app = APP_NAME[task.platform] ?? task.platform;
    const to = this.who.get(task.id);
    const named = this.file_.get(task.id);
    const file = task.action === 'file' && named !== undefined ? ` "${named.slice(0, 60)}"` : '';
    switch (task.action) {
      case 'message':
        return `Send a message${to !== undefined ? ` to ${to}` : ''} on ${app}`;
      case 'file':
        return `Send${file === '' ? ' a file' : file}${to !== undefined ? ` to ${to}` : ''} on ${app}`;
      case 'open':
        return `Open ${to !== undefined ? `the chat with ${to}` : 'a chat'} on ${app}`;
    }
  }

  /** The task is begun in the store the first time anything is heard of it. Returns its key, or null for an app that has no plugin. */
  private ensure(task: ChatTask): string | null {
    const plugin = this.plugin(task);
    if (plugin === null) return null;
    if (!this.begun.has(task.id)) {
      this.begun.add(task.id);
      this.sink.beginPlugin({ key: task.id, plugin, action: ACTION_OF[task.action] ?? 'find_chat', title: this.title(task) });
    }
    return task.id;
  }

  private phase(key: string, phase: TaskPhase, extra: { readonly note?: string; readonly evidence?: string; readonly question?: string | null } = {}): void {
    const changed = this.phases.get(key) !== phase;
    this.phases.set(key, phase);
    if (changed || extra.evidence !== undefined || extra.note !== undefined || extra.question !== undefined) this.sink.pluginUpdate(key, { phase, ...extra });
  }

  state(task: ChatTask, _from: ChatTaskState, to: ChatTaskState): void {
    const key = this.ensure(task);
    if (key === null) return;
    const phase = phaseOfState(to);
    const evidence =
      to === 'VERIFY_CONVERSATION'
        ? "The page showed the chat open (its message box or header named it)"
        : to === 'VERIFY_PREPARATION'
          ? task.action === 'file'
            ? "The file was put on the chat's attach step; nothing sent yet"
            : 'The message was typed in the message box; nothing sent yet'
          : undefined;
    // (a state the task is already in, or one that only repeats a phase, is not written again)
    this.phase(key, phase, { ...(evidence !== undefined ? { evidence } : {}), ...(phase !== 'waiting_clarification' ? { question: null } : {}) });
  }

  chose(task: ChatTask, selection: Selection): void {
    const key = this.ensure(task);
    if (key === null) return;
    const label = maskNumbersIn(selection.label);
    this.who.set(task.id, label);
    this.sink.pluginUpdate(key, {
      title: this.title(task),
      entity: { kind: 'recipient', label, evidence: selection.evidence, verified: selection.verified },
      evidence: `Chose ${label} on: ${selection.evidence}${selection.verified ? '' : ' (a likely match, not an identity)'}`,
    });
  }

  file(task: ChatTask, name: string, evidence: string): void {
    const key = this.ensure(task);
    if (key === null) return;
    this.file_.set(task.id, name);
    this.sink.pluginUpdate(key, { title: this.title(task), entity: { kind: 'file', label: name.slice(0, 120), evidence, verified: true }, evidence: `File settled on: ${name.slice(0, 60)} (${evidence})` });
  }

  waiting(task: ChatTask, question: string): void {
    const key = this.ensure(task);
    if (key === null) return;
    this.phase(key, 'waiting_clarification', { question: maskNumbersIn(question).slice(0, 250), note: 'Waiting for your answer.' });
  }

  sendBegan(task: ChatTask): void {
    const key = this.ensure(task);
    if (key === null) return;
    // (written at once: if Eya closes before the check that follows, the task is found to be uncertain, never "nothing happened")
    this.phase(key, 'executing', { evidence: `${SEND_PRESSED}; its result has not been seen yet`, note: 'Sent, now checking.' });
  }

  sendSeen(task: ChatTask, mark?: string): void {
    const key = this.ensure(task);
    if (key === null) return;
    this.phase(key, 'verifying', { evidence: mark === undefined ? 'The chat showed it as sent' : `The chat showed it as ${mark}` });
  }

  completed(task: ChatTask): void {
    const key = this.ensure(task);
    if (key === null) return;
    const note = task.action === 'open' ? 'The chat is open; the page showed it.' : task.sendVerified ? 'Sent, and the chat showed it.' : 'Done.';
    this.sink.pluginFinish(key, 'completed', note);
  }

  failed(task: ChatTask, category: FailureCategory, recovery: string): void {
    const key = this.ensure(task);
    if (key === null) return;
    const why = capital(recovery);
    switch (category) {
      case 'send_uncertain':
        this.sink.pluginUpdate(key, { evidence: 'Send was pressed but the chat did not show the result' });
        this.sink.pluginFinish(key, 'uncertain', `It may already have gone: look in the chat. Eya will check there first and will not send it twice. (${why})`);
        return;
      case 'declined':
        this.sink.pluginFinish(key, 'cancelled', 'You said no, so nothing was sent.');
        return;
      case 'plugin_blocked':
      case 'chats_off':
        this.phase(key, 'waiting_permission', { note: why, question: null });
        return;
      default:
        this.sink.pluginFinish(key, 'failed', task.sendAttempted ? `${why} (a send had been begun: check the chat before asking again)` : `${why} Nothing was sent.`);
    }
  }
}
