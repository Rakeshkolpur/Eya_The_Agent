import { normalizeCommand } from '@main/agent/IntentRouter';
import { FILE_TYPE_EXTENSIONS } from '@main/tools/impl/fileTools';
import type { WhenValue } from '@main/tools/dateQuery';
import type { FolderName } from '@main/security/pathPolicy';
import { domainToUrl, findSite, joinSpokenDots, searchableSiteNames, searchUrl } from './sites';
import type { Site } from './sites';

/**
 * Understanding everyday commands without a language model.
 *
 * "Open YouTube", "search Amazon for a phone case", "open downloads", "find my resume", "download <link>": each is a fixed shape,
 * so recognising it takes microseconds, where asking the model takes seconds and the internet. This only claims a request when
 * it recognises both the verb and a concrete thing (a site, a known folder, a file with a type or "my ..."). Anything else
 * returns null and goes on to the model exactly as before: a wrong guess here would be worse than a slow right answer.
 */

export type FileFolder = Extract<FolderName, 'downloads' | 'desktop' | 'documents' | 'pictures' | 'videos' | 'music'>;

export interface FileQuery {
  readonly kind: 'file';
  /** "find"/"show" lists matches; "open" opens the one clearly meant (and asks when several could be). */
  readonly action: 'find' | 'open';
  readonly tokens: readonly string[];
  readonly extensions?: readonly string[];
  readonly folder?: FileFolder;
  /** The user said "latest"/"newest", or gave no name at all: the newest match is the one meant. */
  readonly newest: boolean;
  readonly when?: WhenValue;
  readonly limit: number;
}

/** Browsers the fast path can start by name. Without one named, a page opens in Chrome. */
export type NamedBrowser = 'chrome' | 'edge' | 'firefox';

export type LocalIntent =
  | { readonly kind: 'open_site'; readonly url: string; readonly label: string; readonly browser?: NamedBrowser }
  | { readonly kind: 'search'; readonly site: Site; readonly query: string; readonly url: string; readonly browser?: NamedBrowser }
  | { readonly kind: 'open_folder'; readonly folder: FolderName }
  | { readonly kind: 'open_named_folder'; readonly tokens: readonly string[] }
  | FileQuery
  | { readonly kind: 'download'; readonly url: string | null };

const OPEN_VERB = /^(?:open up|open|go to|goto|visit|browse to|browse|take me to|pull up|bring up|launch|start)\s+/;
const SHOW_VERB = /^(?:show me|show)\s+/;
const FIND_VERB = /^(?:find me|find|locate|search for|search|look for|where is|where's|where are|list|get me|give me)\s+/;
const WHERE_DID = /^where (?:did i (?:put|save|keep|download)|can i find)\s+/;

const LEADING_NOISE = /^(?:my|the|a|an|any|all|all my|all the|some)\s+/;
const TRAILING_SITE_WORDS = /\s+(?:website|web site|site|web page|webpage|home page|homepage|page)$/;
const TRAILING_FOLDER_WORDS = /\s+(?:folder|directory)$/;

// Folders by the words people use. The bare singular ("download", "video") is only a folder when "folder" follows it.
const FOLDER_WORDS: ReadonlyArray<readonly [readonly string[], FolderName, boolean]> = [
  [['downloads', 'my downloads'], 'downloads', false],
  [['download'], 'downloads', true],
  [['desktop'], 'desktop', false],
  [['documents', 'my documents', 'docs'], 'documents', false],
  [['document'], 'documents', true],
  [['pictures', 'my pictures'], 'pictures', false],
  [['picture', 'photos', 'photo', 'images', 'image'], 'pictures', true],
  [['videos', 'my videos'], 'videos', false],
  [['video'], 'videos', true],
  [['music', 'my music'], 'music', false],
  [['home', 'user', 'user profile', 'home directory'], 'home', true],
];

function knownFolder(rest: string, saidFolder: boolean): FolderName | null {
  const name = rest.replace(LEADING_NOISE, '').trim();
  for (const [words, folder, needsWord] of FOLDER_WORDS) {
    if (needsWord && !saidFolder) continue;
    if (words.includes(name) || words.includes(rest)) return folder;
  }
  return null;
}

const FILE_FOLDERS: Readonly<Record<string, FileFolder>> = {
  downloads: 'downloads',
  desktop: 'desktop',
  documents: 'documents',
  pictures: 'pictures',
  videos: 'videos',
  music: 'music',
};

// What a person calls a kind of file, and the extensions it means.
const TYPE_WORDS: Readonly<Record<string, readonly string[]>> = {
  pdf: ['pdf'],
  pdfs: ['pdf'],
  doc: FILE_TYPE_EXTENSIONS['word'] ?? ['doc', 'docx'],
  docx: ['docx'],
  excel: FILE_TYPE_EXTENSIONS['excel'] ?? ['xls', 'xlsx'],
  spreadsheet: FILE_TYPE_EXTENSIONS['excel'] ?? ['xls', 'xlsx'],
  spreadsheets: FILE_TYPE_EXTENSIONS['excel'] ?? ['xls', 'xlsx'],
  xlsx: ['xlsx'],
  csv: ['csv'],
  powerpoint: FILE_TYPE_EXTENSIONS['powerpoint'] ?? ['ppt', 'pptx'],
  presentation: FILE_TYPE_EXTENSIONS['powerpoint'] ?? ['ppt', 'pptx'],
  presentations: FILE_TYPE_EXTENSIONS['powerpoint'] ?? ['ppt', 'pptx'],
  ppt: ['ppt', 'pptx'],
  pptx: ['pptx'],
  image: FILE_TYPE_EXTENSIONS['image'] ?? [],
  images: FILE_TYPE_EXTENSIONS['image'] ?? [],
  photo: FILE_TYPE_EXTENSIONS['image'] ?? [],
  photos: FILE_TYPE_EXTENSIONS['image'] ?? [],
  picture: FILE_TYPE_EXTENSIONS['image'] ?? [],
  pictures: FILE_TYPE_EXTENSIONS['image'] ?? [],
  screenshot: FILE_TYPE_EXTENSIONS['image'] ?? [],
  screenshots: FILE_TYPE_EXTENSIONS['image'] ?? [],
  jpg: ['jpg', 'jpeg'],
  png: ['png'],
  video: FILE_TYPE_EXTENSIONS['video'] ?? [],
  videos: FILE_TYPE_EXTENSIONS['video'] ?? [],
  movie: FILE_TYPE_EXTENSIONS['video'] ?? [],
  movies: FILE_TYPE_EXTENSIONS['video'] ?? [],
  mp4: ['mp4'],
  audio: FILE_TYPE_EXTENSIONS['audio'] ?? [],
  song: FILE_TYPE_EXTENSIONS['audio'] ?? [],
  songs: FILE_TYPE_EXTENSIONS['audio'] ?? [],
  mp3: ['mp3'],
  text: FILE_TYPE_EXTENSIONS['text'] ?? ['txt'],
  txt: ['txt'],
  zip: ['zip'],
  archive: FILE_TYPE_EXTENSIONS['archive'] ?? ['zip'],
  document: FILE_TYPE_EXTENSIONS['document'] ?? ['doc', 'docx', 'pdf', 'txt'],
  documents: FILE_TYPE_EXTENSIONS['document'] ?? ['doc', 'docx', 'pdf', 'txt'],
};

const KNOWN_EXTENSIONS = new Set(Object.values(FILE_TYPE_EXTENSIONS).flat().concat(['csv', 'json', 'html', 'log', 'odt']));

const LATEST_WORDS = new Set(['latest', 'newest', 'recent', 'recently', 'last', 'new', 'most']);
const DOWNLOAD_WORDS = new Set(['download', 'downloads', 'downloaded']);
const FILLER_WORDS = new Set(['file', 'files', 'named', 'called', 'name', 'the', 'a', 'an', 'of', 'for', 'that', 'is', 'my', 'copy', 'version', 'one', 'i', 'saved', 'about', 'to']);
const WHEN_WORDS: ReadonlyArray<readonly [string, WhenValue]> = [
  ['today', 'today'],
  ['yesterday', 'yesterday'],
  ['this week', 'this_week'],
  ['last week', 'last_week'],
  ['this month', 'this_month'],
  ['last month', 'last_month'],
];

/** What is being asked for in "my latest invoice pdf in downloads": the words that name it, its type, where, and how recent. */
export function parseFileQuery(restIn: string, action: 'find' | 'open'): FileQuery | null {
  let rest = restIn.trim();
  const possessive = /^(?:my|all my)\b/.test(rest);
  while (LEADING_NOISE.test(rest)) rest = rest.replace(LEADING_NOISE, '');

  let folder: FileFolder | undefined;
  const inFolder = /\s+(?:in|from|inside|under|within|on)\s+(?:my\s+|the\s+)?(downloads|desktop|documents|pictures|videos|music)(?:\s+folder)?$/.exec(rest);
  if (inFolder !== null) {
    folder = FILE_FOLDERS[inFolder[1] ?? ''];
    rest = rest.slice(0, inFolder.index).trim();
  }

  let when: WhenValue | undefined;
  for (const [phrase, value] of WHEN_WORDS) {
    const trailing = new RegExp(`(?:^|\\s)(?:(?:from|of|in|modified|made|created|saved)\\s+)?${phrase}$`).exec(rest);
    if (trailing !== null) {
      when = value;
      rest = rest.slice(0, trailing.index).trim();
      break;
    }
    const leading = new RegExp(`^${phrase}'?s?\\s+`).exec(rest);
    if (leading !== null) {
      when = value;
      rest = rest.slice(leading[0].length).trim();
      break;
    }
  }

  // "a word document" is a kind of file (Word's), not a file with "word" in its name: left as it was it searched every document type for
  // names containing "word" and answered "keywords.txt".
  rest = rest.replace(/\bword\s+(?:documents?|docs?|files?)\b/g, 'doc');

  let newest = false;
  let sawDownload = false;
  let typeCue: readonly string[] | undefined;
  let literalExtension: string | undefined;
  let fileWord = false;
  const tokens: string[] = [];
  for (const word of rest.split(' ').filter((w) => w.length > 0)) {
    const literal = /^(.+)\.([a-z0-9]{2,5})$/.exec(word);
    if (literal !== null && KNOWN_EXTENSIONS.has(literal[2] ?? '')) {
      literalExtension = literal[2];
      tokens.push(...(literal[1] ?? '').split(/[_\-\s]+/).filter((t) => t.length > 0));
      continue;
    }
    if (LATEST_WORDS.has(word)) {
      newest = true;
      continue;
    }
    if (DOWNLOAD_WORDS.has(word)) {
      sawDownload = true;
      continue;
    }
    const extensions = TYPE_WORDS[word];
    if (extensions !== undefined) {
      typeCue = typeCue === undefined ? extensions : typeCue;
      continue;
    }
    if (word === 'file' || word === 'files') fileWord = true;
    if (FILLER_WORDS.has(word)) continue;
    tokens.push(word);
  }
  if (sawDownload && folder === undefined) folder = 'downloads';
  const extensions = literalExtension !== undefined ? [literalExtension] : typeCue;

  if (tokens.length > 6) return null;
  if (tokens.length === 0 && extensions === undefined && !sawDownload) return null;
  // A bare "download" is the Downloads folder, not a file; it only means a file as "the latest download".
  if (tokens.length === 0 && extensions === undefined && !newest) return null;

  const cue = extensions !== undefined || fileWord || sawDownload;
  // Opening needs a clear sign it is a file ("the invoice pdf", "my notes file"); finding also accepts "my ...", since
  // "find my resume" says whose it is. Anything vaguer goes to the model.
  if (action === 'open' && !cue) return null;
  if (action === 'find' && !cue && !(possessive && tokens.length <= 4)) return null;
  // "open video" names no file: opening needs a name, or an explicit "the latest".
  if (action === 'open' && tokens.length === 0 && !newest) return null;

  return {
    kind: 'file',
    action,
    tokens,
    ...(extensions !== undefined ? { extensions } : {}),
    ...(folder !== undefined ? { folder } : {}),
    newest: newest || tokens.length === 0,
    ...(when !== undefined ? { when } : {}),
    limit: 5,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SITE_ALTERNATION = searchableSiteNames().map(escapeRegExp).join('|');
const SEARCH_ON = new RegExp(`^(?:search|find|look up|look for|google)\\s+(?:for\\s+)?(.+?)\\s+(?:on|in|at|using|from)\\s+(?:the\\s+)?(${SITE_ALTERNATION})(?:\\s+(?:website|site))?$`);
const SEARCH_SITE = new RegExp(`^(?:search|look up|find|look for)\\s+(?:on\\s+|in\\s+)?(${SITE_ALTERNATION})\\s+(?:for\\s+)?(.+)$`);
const SEARCH_WEB = /^(?:google search for|google search|google it for|google for|google|search (?:the )?(?:web|internet|net|online) for|search online for|look online for|look up online|web search for|web search)\s+(.+)$/;

const MAX_QUERY_CHARS = 120;

function cleanQuery(query: string): string | null {
  const q = query.replace(/^(?:for|about)\s+/, '').trim();
  return q.length > 0 && q.length <= MAX_QUERY_CHARS ? q : null;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/i;
const LINK_TOKEN = 'linktoken';
const CLIPBOARD_WORDS = new Set([
  'this', 'that', 'it', 'this link', 'that link', 'the link', 'link', 'this file', 'that file', 'the file', 'this url', 'that url',
  'the url', 'the copied link', 'the copied url', 'copied link', 'what i copied', 'the file i copied', 'the link i copied',
]);

const BROWSER_WORDS = 'google chrome|chrome|microsoft edge|ms edge|edge|mozilla firefox|firefox|brave|opera|vivaldi|safari|tor';
const IN_BROWSER = new RegExp(`\\s+(?:in|on|using|with|via|through)\\s+(?:the\\s+)?(${BROWSER_WORDS})(?:\\s+browser)?(?:[,\\s]+(?:please|for me|now|thanks|thank you))*[,\\s.!?]*$`, 'i');

/** The browser a request ends with ("... in Edge", "... on Chrome browser"): the text without it, and which one. `null` browser = one Eya cannot start by name. */
function splitBrowser(raw: string): { readonly text: string; readonly browser: NamedBrowser | null } | null {
  const m = IN_BROWSER.exec(raw);
  if (m === null) return null;
  const said = (m[1] ?? '').toLowerCase();
  const browser: NamedBrowser | null = /chrome/.test(said) ? 'chrome' : /edge/.test(said) ? 'edge' : /firefox/.test(said) ? 'firefox' : null;
  return { text: raw.slice(0, m.index), browser };
}

/** Whether the request ends by naming a browser ("... in Edge"). */
export function namesABrowser(raw: string): boolean {
  return IN_BROWSER.test(raw);
}

/**
 * Whether this request is one the fast path can carry out, and what it is. Pure: no disk, no network, no clock.
 * Returns null for everything else.
 *
 * A browser named at the end ("open YouTube in Edge") is carried with the intent; with none named, the page opens in Chrome.
 * A browser named for anything but opening or searching a site, or one Eya cannot start by name (Brave, Opera…), is left to the model.
 */
export function parseLocalIntent(raw: string): LocalIntent | null {
  const named = splitBrowser(raw);
  if (named === null) return parseIntent(raw);
  const intent = parseIntent(named.text);
  if (named.browser === null || intent === null || (intent.kind !== 'open_site' && intent.kind !== 'search')) return null;
  return { ...intent, browser: named.browser };
}

function parseIntent(raw: string): LocalIntent | null {
  const found = URL_RE.exec(raw);
  const link = found === null ? null : found[0].replace(/[.,;:!?)\]]+$/, '');
  const working = link === null ? raw : raw.replace(link, ` ${LINK_TOKEN} `);
  const text = joinSpokenDots(normalizeCommand(working, { keepDots: true }));
  if (text.length === 0) return null;

  // download <link> / download this
  const download = /^download\s+(?:the\s+)?(?:file\s+)?(?:(?:at|from)\s+)?(.+)$/.exec(text);
  if (download !== null) {
    const rest = (download[1] ?? '').trim();
    if (rest === LINK_TOKEN && link !== null) return { kind: 'download', url: link };
    const domain = domainToUrl(rest);
    if (domain !== null) return { kind: 'download', url: domain };
    if (CLIPBOARD_WORDS.has(rest)) return { kind: 'download', url: null };
    return null;
  }

  // search <something> on <site> / google <something>
  const on = SEARCH_ON.exec(text);
  if (on !== null) {
    const site = findSite(on[2] ?? '');
    const query = cleanQuery(on[1] ?? '');
    const url = site === undefined || query === null ? null : searchUrl(site, query);
    if (site !== undefined && query !== null && url !== null) return { kind: 'search', site, query, url };
  }
  const onSite = SEARCH_SITE.exec(text);
  if (onSite !== null) {
    const site = findSite(onSite[1] ?? '');
    const query = cleanQuery(onSite[2] ?? '');
    const url = site === undefined || query === null ? null : searchUrl(site, query);
    if (site !== undefined && query !== null && url !== null) return { kind: 'search', site, query, url };
  }
  const web = SEARCH_WEB.exec(text);
  if (web !== null) {
    const site = findSite('google');
    const query = cleanQuery(web[1] ?? '');
    const url = site === undefined || query === null ? null : searchUrl(site, query);
    if (site !== undefined && query !== null && url !== null) return { kind: 'search', site, query, url };
  }

  // open <site | link | folder | file>
  const opening = OPEN_VERB.exec(text) ?? SHOW_VERB.exec(text);
  if (opening !== null) {
    const verbIsShow = SHOW_VERB.test(text);
    let rest = text.slice(opening[0].length).trim();
    if (rest.length === 0) return null;
    if (rest === LINK_TOKEN) return link === null ? null : { kind: 'open_site', url: link, label: hostOf(link) };
    const domain = domainToUrl(rest);
    if (domain !== null) return { kind: 'open_site', url: domain, label: hostOf(domain) };

    let saidFolder = false;
    let saidSite = false;
    rest = rest.replace(LEADING_NOISE, '').trim();
    if (TRAILING_FOLDER_WORDS.test(rest)) {
      saidFolder = true;
      rest = rest.replace(TRAILING_FOLDER_WORDS, '').trim();
    } else if (TRAILING_SITE_WORDS.test(rest)) {
      saidSite = true;
      rest = rest.replace(TRAILING_SITE_WORDS, '').trim();
    }
    const folder = saidSite ? null : knownFolder(rest, saidFolder);
    if (folder !== null) return { kind: 'open_folder', folder };
    const site = saidFolder ? undefined : findSite(rest);
    if (site !== undefined) return { kind: 'open_site', url: site.url, label: site.label };
    if (saidFolder) {
      const tokens = rest.split(' ').filter((t) => t.length > 0 && !FILLER_WORDS.has(t));
      return tokens.length > 0 && tokens.length <= 5 ? { kind: 'open_named_folder', tokens } : null;
    }
    return parseFileQuery(text.slice(opening[0].length), verbIsShow ? 'find' : 'open');
  }

  // find <file> / where is <file>
  const finding = WHERE_DID.exec(text) ?? FIND_VERB.exec(text);
  if (finding !== null) return parseFileQuery(text.slice(finding[0].length), 'find');
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
