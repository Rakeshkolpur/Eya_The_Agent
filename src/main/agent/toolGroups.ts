import type { PromptGroup } from './prompts';

/**
 * Which tools (and which parts of the system prompt) a request needs.
 *
 * Every model step carries every tool's schema plus the whole system prompt: on 79 tools that was about 16 000 tokens of tools and 10 000
 * of prompt per step, five or six steps a request. On a free Gemini key that spends the day's allowance in a handful of commands. So a
 * request carries the core tools and only the groups its words are about; the rest are named in one line and the model can switch a group
 * on with `load_tools` if the request turns out to need it. Nothing is lost, only not sent until it is wanted.
 */
export type ToolGroup = PromptGroup;

export const TOOL_GROUPS: readonly ToolGroup[] = ['browser', 'chat', 'word', 'files', 'system', 'screen', 'memory', 'research'];

/** The group of each tool; a tool that is not listed is core (always sent), the safe default. A test makes every tool name appear here. */
const GROUP_OF: Readonly<Record<string, ToolGroup | 'core'>> = {
  // core: opening, finding, reading, windows, clipboard, searching the web
  analyze_document: 'core',
  clipboard_clear: 'core',
  clipboard_read: 'core',
  clipboard_write: 'core',
  close_application: 'core',
  close_file: 'core',
  download_file: 'core',
  find_file: 'core',
  find_folder: 'core',
  list_windows: 'core',
  open_application: 'core',
  open_file: 'core',
  open_folder: 'core',
  open_url: 'core',
  read_file: 'core',
  web_search: 'core',
  window_control: 'core',
  // browser
  browser_status: 'browser',
  click_on_page: 'browser',
  close_browser_tab: 'browser',
  connect_chrome: 'browser',
  fill_on_page: 'browser',
  find_on_page: 'browser',
  inspect_page: 'browser',
  list_browser_tabs: 'browser',
  open_website: 'browser',
  read_page: 'browser',
  scroll_page: 'browser',
  switch_browser_tab: 'browser',
  wait_for_user_in_browser: 'browser',
  play_on_youtube: 'browser',
  skip_ads: 'browser',
  // deep research on the open internet
  deep_research: 'research',
  // chat apps
  attach_file: 'chat',
  communication_access_status: 'chat',
  find_chat: 'chat',
  learn_chat_names: 'chat',
  verify_sent: 'chat',
  // Microsoft Word
  word_edit: 'word',
  word_format: 'word',
  word_read: 'word',
  word_reference: 'word',
  word_status: 'word',
  word_structure: 'word',
  word_write: 'word',
  // files and folders
  copy_file: 'files',
  create_folder: 'files',
  delete_file: 'files',
  delete_folder: 'files',
  empty_recycle_bin: 'files',
  find_recycle_bin_item: 'files',
  get_recycle_bin_count: 'files',
  get_recycle_bin_items: 'files',
  move_file: 'files',
  permanently_delete_recycle_bin_item: 'files',
  rename_file: 'files',
  restore_all_recycle_bin_items: 'files',
  restore_recycle_bin_item: 'files',
  zip_folder: 'files',
  // the PC itself
  get_brightness: 'system',
  get_volume: 'system',
  lock_screen: 'system',
  mute_volume: 'system',
  open_settings_page: 'system',
  open_windows_settings: 'system',
  restart_computer: 'system',
  set_brightness: 'system',
  set_volume: 'system',
  shutdown_computer: 'system',
  unmute_volume: 'system',
  // the screen
  describe_screen: 'screen',
  screen_click: 'screen',
  screen_elements: 'screen',
  start_screen_share: 'screen',
  stop_screen_share: 'screen',
  take_screenshot: 'screen',
  // memory and routines
  answer_routine_suggestion: 'memory',
  delete_routine: 'memory',
  forget_memory: 'memory',
  list_memories: 'memory',
  list_routines: 'memory',
  remember: 'memory',
  run_routine: 'memory',
  save_routine: 'memory',
  update_routine: 'memory',
};

/** The group a tool belongs to, or `core` for the tools that are always sent (and any tool nobody classified). */
export function groupOfTool(name: string): ToolGroup | 'core' {
  return GROUP_OF[name] ?? 'core';
}

/** Every tool name that has an explicit group (for the test that no tool is left out). */
export function classifiedTools(): readonly string[] {
  return Object.keys(GROUP_OF);
}

/** What a request's own words point at. A group is added when one of its patterns matches; nothing matching means "the usual". */
const TRIGGERS: ReadonlyArray<readonly [ToolGroup, RegExp]> = [
  [
    'word',
    /\b(ms\s*word|microsoft word|in word|word (file|document|doc)|docx?|petition|writ|affidavit|vakalat|annexure|index|page numbers?|table of contents|toc|paragraph|heading|bold|italic|underline|font|align(ed|ment)?|justify|spacing|margin|header|footer|list of events|synopsis|prayer|caveat|memo of parties|running index|going to page|go to page|page \d+|next page|previous page|the document|this document|my document)\b/,
  ],
  [
    'chat',
    /\b(whats\s?app|telegram|signal|instagram|messenger|sms|message|messages|text (him|her|them|my|to)|tell (him|her|them)|send (it|this|that|the|a|my|him|her|them)|forward|chat|contact|communication access|chat names?)\b/,
  ],
  [
    'browser',
    /\b(website|web ?site|web ?page|site|browser|chrome|edge|firefox|brave|opera|tabs?|url|link|https?|www|google|youtube|gmail|amazon|flipkart|myntra|meesho|bookmyshow|irctc|redbus|makemytrip|goibibo|zomato|swiggy|order|book|booking|ticket|tickets|buy|purchase|cart|checkout|pay|login|log in|sign in|click|scroll|form|ecourts?|e-courts?|cause ?list|case status|high court|district court|supreme court|judg(e)?ment|online|\.com|\.in|\.org|\.net|\.gov)\b/,
  ],
  [
    'files',
    /\b(create (a |the )?(new )?folder|new folder|make (a |the )?folder|copy|move|rename|delete|remove|erase|trash|recycle|bin|restore|zip|unzip|compress|archive|duplicate|put (it|them|this) (in|into|on|to)|organi[sz]e|sort|clean ?up|tidy|arrange|save (it|them|this) (in|into|to|as))\b/,
  ],
  [
    'system',
    /\b(volume|mute|unmute|louder|quieter|sound|brightness|brighter|dimmer|lock (the |my )?(screen|pc|computer|laptop)|restart|reboot|shut ?down|power off|windows settings|settings|wi-?fi|bluetooth|night light|battery|airplane|hibernate)\b/,
  ],
  [
    'screen',
    /\b(screen|screenshot|what('?s| is) (on|in) (my |the )?(screen|window)|look at|what do you see|describe|click on|share my|sharing|take a (picture|photo|snap))\b/,
  ],
  [
    'research',
    /\b(research|deeply|in depth|find (me )?(out|related|the full|full)|look(ing)? (it )?up|related (pdf|pdfs|document|documents|file|files|case|cases|judg(e)?ments?)|judg(e)?ments?|case law|bare act|full text|where (can|do|will) (i|we) (get|find|watch|download|listen)|(download|watch|play|listen to) (a |the |some |any )?(movie|film|song|songs|video|series|episode|album|music|book|pdf|case|document|report)|movie|movies|film|song|songs|web series|album|ott|(get|need|want) (a |the |some )?(report|paper|study|document|book))\b/,
  ],
  [
    'memory',
    /\b(remember|forget|routine|routines|from now on|always|every time|preference|my name is|what do you (remember|know)|save (this|that|it)|saved)\b/,
  ],
];

export interface RouteOptions {
  /** Tools the last turn or two used, so "now make it bold" or "yes" carries on in the same area. */
  readonly recentTools?: readonly string[];
}

/** Which optional groups to send for this request. */
export function routeGroups(requestText: string, options: RouteOptions = {}): Set<ToolGroup> {
  const text = requestText.toLowerCase();
  const picked = new Set<ToolGroup>();
  for (const [group, pattern] of TRIGGERS) if (pattern.test(text)) picked.add(group);
  // Messaging goes through WhatsApp Web / Telegram Web, which is the browser.
  if (picked.has('chat')) picked.add('browser');
  // Playing a film or song, and opening what research found, happen in the browser.
  if (picked.has('research') && /\b(play|youtube|watch|listen|open)\b/.test(text)) picked.add('browser');
  // Words that point at nothing in particular get only the core (open, find, read, search, windows, clipboard): that covers most everyday
  // requests, and the model switches on more with load_tools when it turns out to need it.
  // A short reply ("yes", "save it", "no") answers whatever Eya just asked or offered, which may be a routine offer.
  if (/^\s*(yes|yeah|yep|yup|no|nope|nah|ok|okay|sure|please|do it|go ahead|save it|don'?t|never ?mind)\b/.test(text) && text.trim().split(/\s+/).length <= 6) {
    picked.add('memory');
  }
  for (const name of options.recentTools ?? []) {
    const g = groupOfTool(name);
    if (g !== 'core') picked.add(g);
  }
  // Four or more areas at once is a big multi-part job: just send everything rather than reason about it.
  if (picked.size >= 4) return new Set(TOOL_GROUPS);
  return picked;
}

/**
 * What a model says when it believes it has no way to do something. While abilities are switched off this usually means "the tool I
 * need is one of them", so the engine switches everything on and asks again rather than telling the user "I can't".
 */
export function soundsLikeRefusal(text: string): boolean {
  return /\b(i (can'?t|cannot|am not able|am unable|'m unable|'m not able|don'?t have (a|any|the) (tool|way|ability|access))|unable to|not able to|no (tool|way) to|isn'?t something i can)\b/i.test(text);
}

/** What `load_tools` accepts: group names, "all", separated by commas, spaces or "and". Unknown words are returned apart. */
export function parseGroups(raw: string): { readonly groups: ReadonlySet<ToolGroup>; readonly unknown: readonly string[] } {
  const groups = new Set<ToolGroup>();
  const unknown: string[] = [];
  const words = raw
    .toLowerCase()
    .split(/[\s,;/&+]+|\band\b/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  for (const w of words) {
    if (w === 'all' || w === 'everything') {
      for (const g of TOOL_GROUPS) groups.add(g);
      continue;
    }
    const singular = w.endsWith('s') ? w.slice(0, -1) : w;
    const hit = TOOL_GROUPS.find((g) => g === w || g === singular);
    if (hit !== undefined) groups.add(hit);
    else if (w === 'web' || w === 'website' || w === 'chrome') groups.add('browser');
    else if (w === 'message' || w === 'messaging' || w === 'whatsapp') groups.add('chat');
    else if (w === 'document' || w === 'msword') groups.add('word');
    else if (w === 'pc' || w === 'windows') groups.add('system');
    else if (w === 'internet' || w === 'researcher' || w === 'deep_research' || w === 'movie' || w === 'media' || w === 'pdf') groups.add('research');
    else unknown.push(w);
  }
  return { groups, unknown };
}

/** The tools to send: core always, the rest only when their group is switched on. */
export function selectTools<T extends { readonly name: string }>(all: readonly T[], active: ReadonlySet<ToolGroup>): T[] {
  return all.filter((t) => {
    const g = groupOfTool(t.name);
    return g === 'core' || active.has(g);
  });
}

/** The tool the engine itself answers: switch groups of tools on for the rest of this request. */
export const LOAD_TOOLS_SPEC = {
  name: 'load_tools',
  description:
    'Switch on more abilities for this request. Call it when what the user asked needs something listed as switched off ' +
    '(browser, chat, word, files, system, screen, memory), then carry on with the new tools. Costs nothing and is instant.',
  parameters: {
    type: 'object' as const,
    properties: {
      groups: { type: 'string', description: 'Which to switch on: one or more of browser, chat, word, files, system, screen, memory (comma separated), or "all".' },
    },
    required: ['groups'] as readonly string[],
  },
} as const;
