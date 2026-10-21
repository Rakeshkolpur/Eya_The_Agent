import type { ActivityKind } from '@shared/ipcContract';
import type { ActivityStore, NewActivity } from './ActivityStore';
import { looksSensitive } from './normalize';

/** What happened, as the code that did it knows it. */
export interface ActivityInput {
  /** What the user asked, in their words. */
  readonly request: string;
  /** The tools that ran for it, in order. */
  readonly tools: readonly string[];
  /** Addresses opened with open_website (for the site list; never kept for chat apps). */
  readonly urls?: readonly string[];
  /** What Eya said when it was over. */
  readonly spoken?: string;
  readonly ok: boolean;
  /** Set when a saved routine did the whole job. */
  readonly routine?: string;
  /**
   * A fixed title to use instead of the request's own words. The request is then NOT kept and the entry cannot be repeated — for
   * things (a question about the screen) whose words must not be saved and that "do it again" through the agent would not mean.
   */
  readonly label?: string;
}

const CHAT_TOOLS = new Set(['find_chat', 'attach_file', 'verify_sent', 'learn_chat_names']);
const FILE_TOOLS = new Set([
  'analyze_document', 'read_file', 'open_file', 'open_folder', 'create_folder', 'copy_file', 'move_file', 'rename_file', 'delete_file', 'delete_folder',
  'find_file', 'find_folder', 'zip_folder', 'close_file', 'download_file', 'get_recycle_bin_count', 'get_recycle_bin_items', 'find_recycle_bin_item',
  'restore_recycle_bin_item', 'restore_all_recycle_bin_items', 'permanently_delete_recycle_bin_item', 'empty_recycle_bin',
]);
const WEB_TOOLS = new Set([
  'open_website', 'open_url', 'click_on_page', 'fill_on_page', 'inspect_page', 'find_on_page', 'read_page', 'scroll_page', 'go_back', 'go_forward',
  'reload_page', 'list_browser_tabs', 'switch_browser_tab', 'close_browser_tab', 'web_search', 'wait_for_user_in_browser', 'connect_chrome',
]);
/** Managing memory, and asking about settings, is not something Eya "did": it never makes an entry on its own. */
const NOT_ACTIVITY = new Set([
  'remember', 'forget_memory', 'list_memories', 'list_routines', 'save_routine', 'answer_routine_suggestion', 'update_routine', 'delete_routine',
  'communication_access_status', 'browser_status',
]);

const POLITE = /^(?:(?:hey|hi|ok|okay)\s+)?(?:eya[,.]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i;

/** A request as a short title: the polite lead-in dropped, a capital letter, no trailing full stop, cut to length. */
export function tidy(text: string, max: number): string {
  const plain = text.replace(/\s+/g, ' ').trim().replace(POLITE, '').replace(/[.!?\s]+$/, '');
  if (plain === '') return '';
  const cased = plain.charAt(0).toUpperCase() + plain.slice(1);
  return cased.length > max ? `${cased.slice(0, max - 1).trimEnd()}…` : cased;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** What kind of thing it was, for the Recent screen's filters. Chat first (it is the most private), then web, then files. */
export function kindOf(tools: readonly string[], anyChatUrl: boolean): ActivityKind {
  if (anyChatUrl || tools.some((t) => CHAT_TOOLS.has(t))) return 'chat';
  if (tools.some((t) => WEB_TOOLS.has(t))) return 'web';
  if (tools.some((t) => FILE_TOOLS.has(t))) return 'file';
  return 'action';
}

/**
 * Turns what happened into the entry the Recent screen shows — or nothing, when it is not something to list. What is kept is a short
 * title and a line of outcome. Nothing from a chat app (not even who or what), and nothing that looks private (a password, a card or
 * long number, an e-mail address), ever has its words kept: those show only as a generic line and cannot be repeated.
 */
export function describeActivity(input: ActivityInput, isChatUrl: (url: string) => boolean = () => false): NewActivity | null {
  const tools = input.tools.filter((t) => !NOT_ACTIVITY.has(t));
  const ranRoutine = input.routine !== undefined;
  if (tools.length === 0 && !ranRoutine) return null;

  const urls = input.urls ?? [];
  const kind = kindOf(tools, urls.some(isChatUrl));
  if (kind === 'chat') return { kind, title: 'Worked in a chat app', detail: input.ok ? 'Done' : 'It did not work', ok: input.ok, request: '', site: '' };

  if (input.label !== undefined) {
    const reply = input.ok ? 'Done' : 'It did not work';
    return { kind, title: input.label, detail: reply, ok: input.ok, request: '', site: '' };
  }

  const request = input.request.trim();
  if (looksSensitive(request) || /\d{6,}/.test(request) || request.includes('@')) {
    return { kind, title: 'A private request', detail: input.ok ? 'Done' : 'It did not work', ok: input.ok, request: '', site: '' };
  }

  const reply = tidy(input.spoken ?? '', 140);
  const detail = input.ok ? (reply === '' || /^done$/i.test(reply) ? 'Done' : reply) : reply === '' ? 'It did not work' : reply;
  const title = ranRoutine ? `Ran routine: ${(input.routine ?? '').replace(/_/g, ' ')}` : tidy(request, 90) || 'Did something';
  const site = kind === 'web' ? (urls.map(hostOf).find((h) => h !== '') ?? '') : '';
  return { kind, title, detail, ok: input.ok, request: request.slice(0, 200), site };
}

/** Records finished tasks in the history — if the user keeps one (Settings → Privacy). */
export class ActivityLog {
  constructor(
    private readonly store: ActivityStore,
    private readonly deps: { readonly enabled: () => boolean; readonly isChatUrl?: (url: string) => boolean },
  ) {}

  record(input: ActivityInput): void {
    if (!this.deps.enabled()) return;
    const entry = describeActivity(input, this.deps.isChatUrl);
    if (entry !== null) this.store.record(entry);
  }
}
