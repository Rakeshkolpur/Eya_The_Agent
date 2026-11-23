import { promises as fsp } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { permissionRequest } from '@main/permissions/PermissionManager';
import { rootLogger } from '@main/logging/logger';
import { isBlockedSite, streamingPlatform, trustOf } from '@main/research/trust';
import { isExecutablePath } from '@main/security/pathPolicy';
import type { KnownFolders } from '@main/security/pathPolicy';
import { BrowserUnavailableError } from '@main/browser/errors';
import type { ActOnPageResult, BrowserAutomationService, OpenWebsiteOptions } from '@main/browser/BrowserAutomationService';
import { NavigationRecovery } from '@main/browser/navigationRecovery';
import type { RecoveryConfig, RecoveryEvent, RecoveryOutcome } from '@main/browser/navigationRecovery';
import type { DownloadInfo } from '@main/browser/pageEffects';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { hostOf, isExecutableUrl, sameSite, significantTokens } from '@main/browser/siteIdentity';
import type { Tool, ToolArgs, ToolResult } from '../types';
import { currentPageData, unavailable } from './browserTools';
import { parseWebUrl } from './openTools';

const log = rootLogger.child('site-tools');

/** The part of the browser these tools use (the session manager in the app, a pretend one in tests). */
export type SiteBrowser = Pick<BrowserAutomationService, 'openWebsite' | 'inspectPage' | 'findOnPage' | 'clickOnPage' | 'readPage' | 'searchWeb'>;

export interface SiteToolDeps {
  readonly service: SiteBrowser;
  readonly folders: KnownFolders;
  /** The folder the browser saves downloads into (the Downloads folder, unless a test says otherwise). */
  readonly downloadsDir?: string;
  /** What is going on, in words, for the "Your Agent at Work" panel. */
  readonly progress?: (event: RecoveryEvent) => void;
  readonly recovery?: Partial<RecoveryConfig>;
  /** A direct file link the page itself gives, fetched by Eya's own download handler (used when clicking the control starts nothing). */
  readonly directDownload?: (url: string, filename?: string) => Promise<ToolResult>;
  /** How long to wait for a started download to finish, how long it may go without growing, how long a size must stay still, and how often to look. */
  readonly downloadWaitMs?: number;
  readonly downloadStallMs?: number;
  readonly downloadSettleMs?: number;
  readonly downloadPollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** "cause list, orders" -> two things; one phrase stays one phrase. */
function expectWords(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[,;\n]/)
    .map((w) => w.trim())
    .filter((w) => w !== '')
    .slice(0, 6);
}

/**
 * What a person typed as an address, made forgiving like a person would be: "example.com/reports" is an address, a full https link is one, and
 * words ("telangana high court cause list") are not an address at all but what they are looking for. A link of another kind (ftp://…) is refused.
 */
export function readAddress(raw: string | undefined): { readonly url: URL | null; readonly words: string; readonly refused: boolean } {
  if (raw === undefined) return { url: null, words: '', refused: false };
  const direct = parseWebUrl(raw);
  if (direct !== null) return { url: direct, words: '', refused: false };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { url: null, words: '', refused: true };
  if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(raw)) {
    const guessed = parseWebUrl(`https://${raw}`);
    if (guessed !== null) return { url: guessed, words: '', refused: false };
  }
  return { url: null, words: raw, refused: false };
}

// ------------------------------------------------------------------------------------------ opening a site
function openedResult(out: Extract<RecoveryOutcome, { status: 'opened' }>): ToolResult {
  const s = out.snapshot;
  const moved = out.via === 'alternative' || out.via === 'redirect';
  return {
    ok: true,
    summary: `opened ${s.title || hostOf(s.url)}`,
    data: currentPageData('open', out.url, { stateChanged: true, navigated: true }, s, {
      recovery: {
        via: out.via,
        ...(out.requested !== null ? { requested: out.requested } : {}),
        finalUrl: out.url,
        ...(moved ? { addressChanged: true } : {}),
        verified: out.verified,
        ...(out.contentFound !== null ? { expectedContentFound: out.contentFound } : {}),
        ...(out.signInNeeded ? { signInNeeded: true } : {}),
        pagesOpened: out.attempts,
        notes: out.notes,
      },
    }),
  };
}

function stoppedResult(out: Exclude<RecoveryOutcome, { status: 'opened' }>): ToolResult {
  if (out.status === 'needs_user') {
    return {
      ok: false,
      summary: 'needs you',
      error: out.message,
      data: { needsUser: true, userAction: out.message, reason: out.why, ...(out.candidate !== undefined ? { candidate: out.candidate } : {}), recovery: { pagesOpened: out.attempts, notes: out.notes } },
    };
  }
  return {
    ok: false,
    summary: out.why === 'time_budget' || out.why === 'attempt_limit' ? 'stopped trying' : 'could not open',
    error: out.message,
    data: { navigation: { problem: out.why, canRetry: out.why === 'time_budget' || out.why === 'unreachable' }, recovery: { reason: out.why, tried: out.tried, pagesOpened: out.attempts, notes: out.notes } },
  };
}

function failureOf(err: unknown, what: string): ToolResult {
  if (err instanceof BrowserUnavailableError) return unavailable(err);
  return { ok: false, summary: 'failed', error: `${what}: ${err instanceof Error ? err.message : String(err)}` };
}

// ---------------------------------------------------------------------------------------- finding a download
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'zip', '7z', 'rar', 'epub', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'mp3', 'wav', 'flac', 'mp4', 'mkv', 'webm', 'avi', 'mov', 'json']);
const AD_LIKE = /(fast|high.?speed|turbo|premium|install|update|setup|get started|open with|play now|watch now|start now|vpn|scan)/i;
const BORING_LINKS = /^(home|about( us)?|contact( us)?|login|log in|sign in|sign up|register|search|menu|privacy( policy)?|terms( of (use|service))?|help|faq|cookies?|next|previous|back|more|skip( to content)?)$/i;

interface Control {
  readonly name: string;
  readonly role: string;
  readonly href?: string;
  readonly score: number;
  readonly offsite: boolean;
}

function extensionOf(href: string | undefined): string {
  if (href === undefined) return '';
  try {
    return extname(new URL(href).pathname).replace('.', '').toLowerCase();
  } catch {
    return '';
  }
}

/** The controls on the open page that would download what was asked for, best first. Programs and advert-like "Download now" buttons are never offered. */
async function downloadControls(service: SiteBrowser, page: PageSnapshot, what: string, type: string | undefined): Promise<Control[]> {
  const tokens = significantTokens(what).slice(0, 4);
  const queries = ['download', ...(type !== undefined ? [type] : []), ...tokens.slice(0, 2)];
  const found = new Map<string, Control>();
  for (const q of [...new Set(queries)]) {
    let result: Awaited<ReturnType<SiteBrowser['findOnPage']>>;
    try {
      result = await service.findOnPage(q);
    } catch (err) {
      if (err instanceof BrowserUnavailableError) throw err;
      continue;
    }
    for (const m of result.matches) {
      const name = m.name.toLowerCase();
      const href = m.href?.toLowerCase();
      const ext = extensionOf(m.href);
      if (isExecutableUrl(m.href ?? '') || /\.(exe|msi|apk|dmg|bat)\b/.test(name)) continue;
      const downloadish = /download/.test(name) || DOCUMENT_EXTENSIONS.has(ext) || (type !== undefined && (name.includes(type) || ext === type));
      if (!downloadish) continue;
      let score = 0;
      if (/download/.test(name)) score += 3;
      for (const t of tokens) score += name.includes(t) ? 2 : href?.includes(t) === true ? 1 : 0;
      if (type !== undefined && ext === type) score += 4;
      else if (DOCUMENT_EXTENSIONS.has(ext)) score += 2;
      if (type !== undefined && name.includes(type)) score += 2;
      const offsite = m.href !== undefined && /^https?:/i.test(m.href) && !sameSite(m.href, page.url);
      if (offsite) score -= 2;
      if (AD_LIKE.test(name) && !/download/.test(name)) score -= 3;
      if (/(fast|high.?speed|turbo|premium)/.test(name) && offsite) score -= 3;
      const key = `${name}|${href ?? ''}`;
      const have = found.get(key);
      if (have === undefined || have.score < score) found.set(key, { name: m.name, role: m.role, ...(m.href !== undefined ? { href: m.href } : {}), score, offsite });
    }
  }
  return [...found.values()].filter((c) => c.score >= 3).sort((a, b) => b.score - a.score);
}

/** A link worth following to get nearer to the file: one that carries words of what was asked for (a title, a document's page), not a menu item. */
async function stepLink(service: SiteBrowser, what: string, visited: ReadonlySet<string>): Promise<string | null> {
  const tokens = significantTokens(what).slice(0, 4);
  if (tokens.length === 0) return null;
  let best: { name: string; score: number } | null = null;
  for (const t of tokens.slice(0, 3)) {
    let result: Awaited<ReturnType<SiteBrowser['findOnPage']>>;
    try {
      result = await service.findOnPage(t);
    } catch (err) {
      if (err instanceof BrowserUnavailableError) throw err;
      continue;
    }
    for (const m of result.matches) {
      if (m.role !== 'link' || BORING_LINKS.test(m.name.trim()) || visited.has(m.name.toLowerCase())) continue;
      if (m.href !== undefined && isExecutableUrl(m.href)) continue;
      const name = m.name.toLowerCase();
      const overlap = tokens.filter((x) => name.includes(x)).length;
      if (overlap === 0 || (tokens.length >= 3 && overlap < 2)) continue;
      const score = overlap * 2 + (m.name.length < 120 ? 1 : 0);
      if (best === null || score > best.score) best = { name: m.name, score };
    }
  }
  return best?.name ?? null;
}

const STREAMING_WORDS = /(watch now|stream now|streaming|play now|watch (the )?(movie|film|episode)|subscribe to watch|available on|rent or buy)/i;

// ------------------------------------------------------------------------------------- checking the saved file
export interface FileCheck {
  readonly ok: boolean;
  readonly sizeBytes: number;
  readonly problem?: string;
}

const MAGIC: Readonly<Record<string, (head: Buffer) => boolean>> = {
  pdf: (h) => h.subarray(0, 4).toString('latin1') === '%PDF',
  zip: (h) => h[0] === 0x50 && h[1] === 0x4b,
  docx: (h) => h[0] === 0x50 && h[1] === 0x4b,
  xlsx: (h) => h[0] === 0x50 && h[1] === 0x4b,
  pptx: (h) => h[0] === 0x50 && h[1] === 0x4b,
  epub: (h) => h[0] === 0x50 && h[1] === 0x4b,
  png: (h) => h[0] === 0x89 && h.subarray(1, 4).toString('latin1') === 'PNG',
  jpg: (h) => h[0] === 0xff && h[1] === 0xd8,
  jpeg: (h) => h[0] === 0xff && h[1] === 0xd8,
  gif: (h) => h.subarray(0, 3).toString('latin1') === 'GIF',
  webp: (h) => h.subarray(0, 4).toString('latin1') === 'RIFF',
  mp4: (h) => h.subarray(4, 8).toString('latin1') === 'ftyp',
  mp3: (h) => h.subarray(0, 3).toString('latin1') === 'ID3' || (h[0] === 0xff && ((h[1] ?? 0) & 0xe0) === 0xe0),
};

/** Is what was saved really the file: there, not empty, not a program, and not a web page that was saved under a file's name. */
export async function verifyDownloadedFile(path: string, type?: string): Promise<FileCheck> {
  let size = 0;
  try {
    const st = await fsp.stat(path);
    if (!st.isFile()) return { ok: false, sizeBytes: 0, problem: 'that is not a file' };
    size = st.size;
  } catch {
    return { ok: false, sizeBytes: 0, problem: 'the file is not on disk' };
  }
  if (size === 0) return { ok: false, sizeBytes: 0, problem: 'the file is empty' };
  if (isExecutablePath(path)) return { ok: false, sizeBytes: size, problem: 'it is a program, which I do not download' };
  const handle = await fsp.open(path, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(Math.min(512, size));
    await handle.read(buf, 0, buf.length, 0);
    head = buf;
  } finally {
    await handle.close();
  }
  const ext = (type ?? extname(path)).replace('.', '').toLowerCase();
  const startsLikePage = /^\s*(<!doctype html|<html|<head|<body)/i.test(head.toString('utf8', 0, 200));
  if (startsLikePage && !['html', 'htm', 'xhtml'].includes(ext)) return { ok: false, sizeBytes: size, problem: 'it is a web page, not the file (the site sent a page instead)' };
  const magic = MAGIC[ext];
  if (magic !== undefined && !magic(head)) return { ok: false, sizeBytes: size, problem: `it does not look like a real .${ext} file` };
  return { ok: true, sizeBytes: size };
}

const PARTIAL_ENDINGS = ['.crdownload', '.part', '.eya-part', '.download', '.tmp'];

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}

type Finished =
  | { readonly state: 'complete'; readonly path: string; readonly bytes: number }
  | { readonly state: 'stalled'; readonly bytes: number }
  | { readonly state: 'running'; readonly path: string; readonly bytes: number };

// --------------------------------------------------------------------------------------------- the tools
export function createSiteTools(deps: SiteToolDeps): Tool[] {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const say = (kind: RecoveryEvent['kind'], message: string, url?: string): void => deps.progress?.({ kind, message, ...(url !== undefined ? { url } : {}) });
  const recovery = new NavigationRecovery({
    host: {
      open: (url, options) => deps.service.openWebsite(url, options),
      look: () => deps.service.inspectPage(),
      search: (query) => deps.service.searchWeb(query),
    },
    ...(deps.recovery !== undefined ? { config: deps.recovery } : {}),
    ...(deps.progress !== undefined ? { progress: deps.progress } : {}),
    now,
    sleep,
  });
  const downloadsDir = deps.downloadsDir ?? deps.folders.downloads;
  const waitMs = deps.downloadWaitMs ?? 30_000;
  const stallMs = deps.downloadStallMs ?? 10_000;
  const settleMs = deps.downloadSettleMs ?? 1500;
  const pollMs = deps.downloadPollMs ?? 1000;

  const findAndOpen: Tool = {
    schema: {
      name: 'find_and_open_website',
      status: 'Finding and opening the website…',
      description:
        'Open a website and make sure it really opened, finding the right one yourself. Use it for ANY "open / go to / find <site or thing>" request: with an address (it is tried first; if it is wrong, out of date or down, the right one is found), with a name, or with only keywords (what the user wants, in their words: the web is searched, the relevant results are opened one by one, and the first page that really has it is kept). Also use it ' +
        '(an unofficial or alternative-domain site, a mirror, a download site, a site that may have moved), when a saved address may be out of date, when the user says a site is not opening or asks for its new URL, or after open_website failed. ' +
        'It opens the page, checks it is a real page (not blank, not an error page, not a parked "domain for sale" page), follows redirects and checks where they lead, and, when the address does not work, tries once more for a hiccup, ' +
        'then looks up the site\'s current address, opens the best candidate and checks it is the same site (title, headings, address), all within a time limit. It never gets past a CAPTCHA or a sign-in, and it asks the user before going to a site it cannot confirm. ' +
        'The result says what happened in plain words (recovery.notes): tell the user briefly if the address had changed or how the page was found. Give at least one of url, name and keywords. Opening the page is the start, not the end: carry on with the user\'s actual request on the page it returns.',
      args: {
        url: { type: 'string', description: 'An address the user gave or that was saved. It may be out of date. Optional if a name is given.' },
        name: { type: 'string', description: 'What the user calls the site ("the Telangana High Court", "Example Corp"). Used to find and confirm the right site.' },
        keywords: { type: 'string', description: 'When no site is named: what the user wants, in their words ("today\'s cause list Telangana High Court", "cheapest flight Hyderabad to Delhi"). The web is searched and the best matching pages are tried.' },
        expect: { type: 'string', description: 'Words that must be on the page for it to be the right one, separated by commas (for example "cause list"). Optional.' },
        browser: { type: 'string', enum: ['chrome', 'edge'], description: 'Only if the user names their own browser.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const rawUrl = stringArg(args, 'url');
      const name = stringArg(args, 'name');
      const given = readAddress(rawUrl);
      const url = given.url;
      // (words given where an address belongs are what the person is looking for)
      const words = [stringArg(args, 'keywords'), given.words].filter((w): w is string => w !== undefined && w !== '').join(' ').trim();
      const keywords = words === '' ? undefined : words;
      if (given.refused && name === undefined && keywords === undefined) return { ok: false, summary: 'bad url', error: 'That is not a normal http or https address. Give the exact address, the name of the site, or what to look for.' };
      if (url === null && name === undefined && keywords === undefined) return { ok: false, summary: 'nothing to open', error: 'Give the address of the site, its name, or what to look for.' };
      const browser = args['browser'] === 'chrome' || args['browser'] === 'edge' ? args['browser'] : undefined;
      try {
        const out = await recovery.open({
          ...(url !== null ? { url: url.href } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(keywords !== undefined ? { keywords } : {}),
          expect: expectWords(stringArg(args, 'expect')),
          ...(browser !== undefined ? { browser } : {}),
        });
        return out.status === 'opened' ? openedResult(out) : stoppedResult(out);
      } catch (err) {
        return failureOf(err, 'I could not open that website');
      }
    },
  };

  /** What the person agreed to, kept between the question and the yes: the same download, from the same page. */
  let pending: { readonly key: string; readonly control: Control; readonly pageUrl: string; readonly type: string | undefined } | null = null;

  async function waitForFile(download: DownloadInfo): Promise<Finished> {
    const expected = download.path !== '' ? download.path : join(downloadsDir, download.name);
    const started = now();
    let last = -1;
    let changedAt = started;
    for (;;) {
      let size = -1;
      try {
        size = (await fsp.stat(expected)).size;
      } catch {
        size = -1;
      }
      let partial = false;
      for (const ending of PARTIAL_ENDINGS) {
        if (await exists(join(dirname(expected), `${basename(expected)}${ending}`))) partial = true;
      }
      if (size !== last) {
        last = size;
        changedAt = now();
      }
      if (size > 0 && !partial && now() - changedAt >= settleMs) return { state: 'complete', path: expected, bytes: size };
      if (now() - changedAt >= stallMs) return { state: 'stalled', bytes: Math.max(0, size) };
      if (now() - started >= waitMs) return { state: 'running', path: expected, bytes: Math.max(0, size) };
      await sleep(pollMs);
    }
  }

  async function finish(download: DownloadInfo, host: string, type: string | undefined): Promise<ToolResult> {
    say('download_started', 'The download has started…');
    if (download.state === 'interrupted') {
      return { ok: false, summary: 'download failed', error: `The download did not finish: ${download.error ?? 'it was interrupted'}.`, data: { download: { name: download.name, state: 'interrupted' } } };
    }
    let path = download.path;
    if (download.state !== 'complete' || path === '') {
      const finished = await waitForFile(download);
      if (finished.state === 'stalled') {
        return { ok: false, summary: 'download failed', error: `The download started but stopped sending data (${finished.bytes} bytes arrived) and did not finish.`, data: { download: { name: download.name, state: 'stalled', bytes: finished.bytes } } };
      }
      if (finished.state === 'running') {
        return {
          ok: true,
          summary: 'downloading',
          data: { name: download.name, path: finished.path, inProgress: true, bytes: finished.bytes, note: 'It is still downloading and has NOT finished: do not say it is done. Tell the user it is on its way to their Downloads folder.' },
        };
      }
      path = finished.path;
    }
    say('checking', 'Download completed. Verifying the saved file…');
    const check = await verifyDownloadedFile(path, type);
    if (!check.ok) {
      return { ok: false, summary: 'file not verified', error: `The browser says it downloaded "${basename(path)}", but ${check.problem ?? 'the file could not be checked'}.`, data: { download: { name: download.name, path, verified: false, ...(check.sizeBytes > 0 ? { bytes: check.sizeBytes } : {}) } } };
    }
    say('download_completed', `Downloaded ${basename(path)}.`);
    return { ok: true, summary: 'downloaded', data: { name: basename(path), path, sizeBytes: check.sizeBytes, from: host, verified: true, folder: dirname(path) } };
  }

  const downloadFromSite: Tool = {
    schema: {
      name: 'download_from_site',
      status: 'Finding the download…',
      requiresConfirmation: true,
      description:
        'Go to a website and download a file from it, end to end: find the site (recovering if its address changed, see find_and_open_website), find the page and the real download control for what the user wants, ' +
        'and, after the user\'s yes, trigger the download through the browser, wait until it has finished, and check the saved file (it exists, is not empty, is the right kind of file). It reports where the file was saved. ' +
        'Use it for "go to <site> and download <the file>". `what` says exactly what (title, kind, quality if given). ALWAYS needs the user\'s clear yes first: the first call (without confirm) finds the download and downloads nothing, ' +
        'returning the question to ask; call again with confirm: true (same arguments) only after the user has agreed. Never says it is downloaded until the file is really finished and checked. ' +
        'It refuses programs and scripts, sites that give away films, songs or programs without permission, and anything that needs getting around a CAPTCHA, a sign-in or a paywall. ' +
        'A film or video that a service only lets people watch or save inside its own app has no normal file: say so. For a direct file link use download_file instead.',
      args: {
        what: { type: 'string', required: true, description: 'Exactly what to download (for example "the Kesavananda Bharati judgment PDF", "the 2024 annual report").' },
        url: { type: 'string', description: 'The site\'s address, or the page to start from. Optional if the site is already open or a name is given.' },
        name: { type: 'string', description: 'What the user calls the site, used to find it (and its current address) if the address does not work.' },
        type: { type: 'string', description: 'The kind of file wanted, as an ending without the dot (pdf, docx, mp3, zip…). Optional.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed to this download.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const what = stringArg(args, 'what');
      if (what === undefined) return { ok: false, summary: 'nothing to download', error: 'Say what to download.' };
      const type = stringArg(args, 'type')?.replace(/^\./, '').toLowerCase();
      const rawUrl = stringArg(args, 'url');
      const name = stringArg(args, 'name');
      const url = readAddress(rawUrl).url;
      const confirmed = args['confirm'] === true;
      const key = `${what.toLowerCase()}|${(rawUrl ?? '').toLowerCase()}|${(name ?? '').toLowerCase()}|${type ?? ''}`;
      try {
        // ----------------------------------------------------------- the yes comes for a download that was found
        if (confirmed && pending !== null && pending.key === key) {
          const { control, pageUrl } = pending;
          pending = null;
          return await run(control, hostOf(pageUrl), type, what);
        }
        pending = null;

        // ----------------------------------------------------------- 1. the site
        let page: PageSnapshot;
        if (url !== null || name !== undefined) {
          const out = await recovery.open({ ...(url !== null ? { url: url.href } : {}), ...(name !== undefined ? { name } : {}) });
          if (out.status !== 'opened') return stoppedResult(out);
          page = out.snapshot;
        } else {
          try {
            page = await deps.service.inspectPage();
          } catch (err) {
            if (err instanceof BrowserUnavailableError) throw err;
            return { ok: false, summary: 'no page', error: 'No page is open and no site was named. Say which site to download from.' };
          }
        }

        // ----------------------------------------------------------- 2. what must not be done
        if (isBlockedSite(page.url)) {
          return {
            ok: false,
            summary: 'not allowed',
            error: `${hostOf(page.url)} gives away films, songs or programs without permission, so I do not download from it. I can look for a legal place to get it (a service that sells or streams it, or a free public-domain copy) instead.`,
          };
        }
        const platform = streamingPlatform(page.url);
        if (platform !== null) {
          return {
            ok: false,
            summary: 'streaming only',
            error: `${platform} lets people watch, or save inside its own app, but it does not give out a normal video file, and I do not get around that. Use the download option inside the ${platform} app, or tell me another place to get it.`,
          };
        }

        // ----------------------------------------------------------- 3. the download page and the control
        say('locating', 'The page is open. Locating the requested download…', page.url);
        const visited = new Set<string>();
        let control: Control | null = null;
        for (let hop = 0; hop < 3; hop++) {
          const controls = await downloadControls(deps.service, page, what, type);
          control = controls[0] ?? null;
          if (control !== null) break;
          const next = await stepLink(deps.service, what, visited);
          if (next === null) break;
          visited.add(next.toLowerCase());
          const stepped = await deps.service.clickOnPage(next);
          if (!stepped.ok) break;
          page = stepped.snapshot;
          if (isBlockedSite(page.url)) return { ok: false, summary: 'not allowed', error: `That led to ${hostOf(page.url)}, a site that gives things away without permission, so I stopped there.` };
          if (page.challenge?.kind === 'captcha' || page.challenge?.kind === 'bot_check') {
            return { ok: false, summary: 'needs you', error: 'The site is showing a check that only a person can pass. I will not try to get past it: please do it in the browser, then ask me again.', data: { needsUser: true, reason: 'challenge' } };
          }
        }
        if (control === null) {
          if (STREAMING_WORDS.test(`${page.visibleText ?? ''} ${page.buttons.join(' ')}`)) {
            return { ok: false, summary: 'streaming only', error: `${hostOf(page.url)} seems to offer this only to watch or play online (or inside an app), with no file to download. I do not get around that.` };
          }
          return {
            ok: false,
            summary: 'no download found',
            error: `I opened ${hostOf(page.url)} but could not find a download for "${what}" on it.`,
            data: { page: page.url, options: [...page.buttons, ...page.links].slice(0, 12), note: 'Tell the user what you saw, and ask where on the site the file is, or whether to try another site.' },
          };
        }

        // ----------------------------------------------------------- 4. ask first
        const shown = control.href !== undefined ? basename(new URL(control.href, page.url).pathname) || control.name : control.name;
        if (!confirmed) {
          pending = { key, control, pageUrl: page.url, type };
          const trust = trustOf(page.url);
          const caution = trust.kind === 'poor' || (trust.kind === 'general' && /movie|film|episode|series|season|song|album|video|mp4|mkv/i.test(what)) ? ' This site is not one I recognise as an official source for that, so please be sure.' : '';
          return {
            ok: false,
            summary: 'needs confirmation',
            error: `I found "${shown}" on ${hostOf(page.url)}${control.offsite ? ' (the link goes to another site)' : ''}. Do you want me to download it into your Downloads folder?${caution}`,
            data: permissionRequest('download_file', hostOf(page.url), 'This saves a file from the internet onto your computer.'),
          };
        }
        return await run(control, hostOf(page.url), type, what);
      } catch (err) {
        return failureOf(err, 'I could not download that');
      }
    },
  };

  /** The yes has been given: use the page's own control, let the browser save the file, wait for it and check it. */
  async function run(control: Control, host: string, type: string | undefined, what: string): Promise<ToolResult> {
    let click: ActOnPageResult = await deps.service.clickOnPage(control.name);
    for (let step = 0; step < 3; step++) {
      if (!click.ok) {
        if (click.reason === 'needs_user') return { ok: false, summary: 'needs you', error: click.message, data: { needsUser: true, userAction: click.message } };
        break;
      }
      const download = click.effects?.download;
      if (download !== undefined) return finish(download, host, type);
      const page = click.snapshot;
      if (page.challenge?.kind === 'captcha' || page.challenge?.kind === 'bot_check') {
        return { ok: false, summary: 'needs you', error: 'The site is showing a check that only a person can pass. I will not try to get past it: please do it in the browser, then ask me again.', data: { needsUser: true, reason: 'challenge' } };
      }
      if (isBlockedSite(page.url)) return { ok: false, summary: 'not allowed', error: `That led to ${hostOf(page.url)}, a site that gives things away without permission, so I stopped there.` };
      // The click opened another page (a "Download now" step, a file's own page): look there for the next control.
      if (click.effects?.changes.navigated !== true && click.effects?.newTab === undefined) break;
      const next = (await downloadControls(deps.service, page, what, type))[0];
      if (next === undefined) break;
      click = await deps.service.clickOnPage(next.name);
    }
    // Nothing downloaded by clicking: a direct file link on the same site may be fetched by Eya's own download handler.
    const direct = control.href;
    if (direct !== undefined && deps.directDownload !== undefined && /^https?:/i.test(direct) && !control.offsite && !isExecutableUrl(direct)) {
      log.info('the control started no download; using the page\'s direct link', { host });
      const fetched = await deps.directDownload(direct);
      if (fetched.ok) {
        const path = typeof fetched.data?.['path'] === 'string' ? fetched.data['path'] : '';
        if (path !== '' && fetched.data?.['inProgress'] !== true) {
          const check = await verifyDownloadedFile(path, type);
          return check.ok
            ? { ok: true, summary: 'downloaded', data: { name: basename(path), path, sizeBytes: check.sizeBytes, from: host, verified: true, folder: dirname(path) } }
            : { ok: false, summary: 'file not verified', error: `The file was saved, but ${check.problem ?? 'it could not be checked'}.`, data: { download: { path, verified: false } } };
        }
      }
      return fetched;
    }
    return { ok: false, summary: 'no download started', error: `I used the download control on ${host}, but no download started. The site may need a sign-in, another step, or may not allow automated downloads.` };
  }

  return [findAndOpen, downloadFromSite];
}

export type { OpenWebsiteOptions };
