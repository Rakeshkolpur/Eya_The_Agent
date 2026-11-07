import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSiteTools, readAddress, verifyDownloadedFile } from '../src/main/tools/impl/siteTools';
import type { SiteBrowser } from '../src/main/tools/impl/siteTools';
import type { ActOnPageResult, FindOnPageResult } from '../src/main/browser/BrowserAutomationService';
import { BrowserNavigationError, BrowserUnavailableError } from '../src/main/browser/errors';
import { classifyNavigationError } from '../src/main/browser/navigationErrors';
import type { RecoveryEvent } from '../src/main/browser/navigationRecovery';
import type { DownloadInfo } from '../src/main/browser/pageEffects';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { showRecoveryEvent } from '../src/main/browser/recoveryProgress';
import type { WebSearchHit } from '../src/main/browser/webSearchResults';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import type { ToolResult } from '../src/main/tools/types';

let dir: string;
let downloads: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eya-site-'));
  downloads = join(dir, 'Downloads');
  mkdirSync(downloads, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const folders = (): KnownFolders => ({ home: dir, downloads, desktop: dir, documents: dir, pictures: dir, videos: dir, music: dir, temp: dir });

function snap(url: string, title: string, text = 'Welcome. This page has enough ordinary text on it to count as a real page for the reader.', over: Partial<PageSnapshot> = {}): PageSnapshot {
  return { url, title, headings: [title], links: ['Home', 'About'], buttons: [], inputs: [], dialogs: [], truncated: false, visibleText: text, ...over };
}

interface Control {
  readonly name: string;
  readonly role: string;
  readonly href?: string;
  /** Clicking goes to this page. */
  readonly goes?: string;
  /** Clicking starts this download. */
  readonly download?: DownloadInfo;
}

interface FakePage {
  readonly snapshot: PageSnapshot;
  readonly controls: readonly Control[];
}

const changes = (navigated: boolean): { changes: { navigated: boolean; titleChanged: boolean; appeared: string[]; appearedCount: number; disappeared: string[]; disappearedCount: number; dialogClosed: boolean; textChanged: boolean }; settled: boolean } => ({
  changes: { navigated, titleChanged: navigated, appeared: [], appearedCount: 0, disappeared: [], disappearedCount: 0, dialogClosed: false, textChanged: navigated },
  settled: true,
});

/** A pretend browser with a few pages: finding controls works like the real page search, clicking follows or downloads. */
class FakeBrowser implements SiteBrowser {
  readonly opened: string[] = [];
  readonly clicked: string[] = [];
  current: string | null = null;
  searches: WebSearchHit[] = [];
  readonly failures = new Map<string, Error>();
  constructor(readonly pages: Record<string, FakePage>) {}

  async openWebsite(url: string): Promise<PageSnapshot> {
    this.opened.push(url);
    const failure = this.failures.get(url);
    if (failure !== undefined) throw failure;
    const page = this.pages[url];
    if (page === undefined) throw new BrowserNavigationError(classifyNavigationError(new Error('net::ERR_NAME_NOT_RESOLVED'), url), url);
    this.current = url;
    return page.snapshot;
  }

  async inspectPage(): Promise<PageSnapshot> {
    if (this.current === null) throw new Error('nothing open');
    return (this.pages[this.current] as FakePage).snapshot;
  }

  async findOnPage(query: string): Promise<FindOnPageResult> {
    const page = this.pages[this.current ?? ''];
    const q = query.toLowerCase();
    const matches = (page?.controls ?? [])
      .filter((c) => c.name.toLowerCase().includes(q) || (c.href ?? '').toLowerCase().includes(q))
      .map((c) => ({ name: c.name, role: c.role, where: 'on the page', ...(c.href !== undefined ? { href: c.href } : {}) }));
    return { url: this.current ?? '', title: page?.snapshot.title ?? '', query, matches, textMatches: [], totalControls: page?.controls.length ?? 0 };
  }

  async clickOnPage(text: string): Promise<ActOnPageResult> {
    this.clicked.push(text);
    const page = this.pages[this.current ?? ''];
    const control = page?.controls.find((c) => c.name === text);
    if (page === undefined || control === undefined) return { ok: false, reason: 'not_found', snapshot: page?.snapshot ?? snap('about:blank', '') };
    if (control.download !== undefined) return { ok: true, snapshot: page.snapshot, effects: { ...changes(false), download: control.download } };
    if (control.goes !== undefined) {
      this.current = control.goes;
      return { ok: true, snapshot: (this.pages[control.goes] as FakePage).snapshot, effects: changes(true) };
    }
    return { ok: true, snapshot: page.snapshot, effects: changes(false) };
  }

  async readPage(): Promise<never> {
    throw new Error('not used');
  }

  async searchWeb(): Promise<WebSearchHit[]> {
    return this.searches;
  }
}

function tools(browser: FakeBrowser, extra: Partial<Parameters<typeof createSiteTools>[0]> = {}): { find: (a: Record<string, string | boolean>) => Promise<ToolResult>; download: (a: Record<string, string | boolean>) => Promise<ToolResult>; events: RecoveryEvent[] } {
  const events: RecoveryEvent[] = [];
  let clock = 0;
  const [find, download] = createSiteTools({
    service: browser,
    folders: folders(),
    progress: (e) => events.push(e),
    // (fast and pretend: waiting costs no real time)
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    downloadWaitMs: 5000,
    downloadStallMs: 2000,
    downloadSettleMs: 500,
    downloadPollMs: 250,
    ...extra,
  });
  return { find: (a) => (find as NonNullable<typeof find>).execute(a), download: (a) => (download as NonNullable<typeof download>).execute(a), events };
}

const pdfBytes = (): Buffer => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 65)]);

describe('find_and_open_website', () => {
  it('opens a site that works first time and reports it plainly', async () => {
    const b = new FakeBrowser({ 'https://example.org/': { snapshot: snap('https://example.org/', 'Example Org'), controls: [] } });
    const { find, events } = tools(b);
    const r = await find({ url: 'https://example.org/' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('opened Example Org');
    expect((r.data?.['recovery'] as { via: string; verified: boolean }).via).toBe('known');
    expect(events.map((e) => e.kind)).toEqual(['opening', 'loaded']);
  });

  it('finds the current address of a site that moved and says so', async () => {
    const b = new FakeBrowser({ 'https://example-new.org/': { snapshot: snap('https://example-new.org/', 'Example — official site'), controls: [] } });
    b.searches = [{ title: 'Example — official site', url: 'https://example-new.org/', snippet: 'The home of Example' }];
    const { find } = tools(b);
    const r = await find({ url: 'https://old-example.com/', name: 'Example' });
    expect(r.ok).toBe(true);
    const rec = r.data?.['recovery'] as { via: string; addressChanged: boolean; finalUrl: string; notes: string[] };
    expect(rec.via).toBe('alternative');
    expect(rec.addressChanged).toBe(true);
    expect(rec.finalUrl).toBe('https://example-new.org/');
    expect(rec.notes.join(' ')).toMatch(/did not work/);
  });

  it('hands a CAPTCHA to the person and stops', async () => {
    const b = new FakeBrowser({ 'https://example.org/': { snapshot: snap('https://example.org/', 'Check', 'Checking you are human.', { challenge: { kind: 'captcha', hint: 'x' } }), controls: [] } });
    const r = await tools(b).find({ url: 'https://example.org/', name: 'Example' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs you');
    expect(r.data?.['needsUser']).toBe(true);
    expect(b.opened).toHaveLength(1);
  });

  it('says in plain words why it gave up, with what it tried', async () => {
    const b = new FakeBrowser({});
    const r = await tools(b).find({ url: 'https://gone.example/', name: 'Gone' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be found/);
    expect((r.data?.['recovery'] as { tried: string[] }).tried).toContain('gone.example');
  });

  it('needs an address or a name, and a real address', async () => {
    const t = tools(new FakeBrowser({}));
    expect((await t.find({})).ok).toBe(false);
    expect((await t.find({ url: 'ftp://x.org/' })).summary).toBe('bad url');
  });

  it('a browser that is not available is reported as that, not as a site problem', async () => {
    const b = new FakeBrowser({});
    b.failures.set('https://example.org/', new BrowserUnavailableError('Eya Browser is not available.', { why: 'not_connected' }));
    const r = await tools(b).find({ url: 'https://example.org/' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('browser not connected');
  });
});

describe('download_from_site', () => {
  const site = (download?: DownloadInfo, extra: Control[] = []): FakeBrowser =>
    new FakeBrowser({
      'https://reports.example.org/': {
        snapshot: snap('https://reports.example.org/', 'Reports Example'),
        controls: [{ name: 'Download Annual Report 2024 (PDF)', role: 'link', href: 'https://reports.example.org/files/annual-report-2024.pdf', ...(download !== undefined ? { download } : {}) }, ...extra],
      },
    });

  it('asks first and downloads nothing until the person says yes', async () => {
    const b = site();
    const r = await tools(b).download({ what: 'the 2024 annual report', url: 'https://reports.example.org/', type: 'pdf' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(r.error).toMatch(/Do you want me to download it into your Downloads folder/);
    expect(r.error).toMatch(/annual-report-2024\.pdf/);
    expect(b.clicked).toEqual([]);
  });

  it('after the yes, downloads through the page, waits, checks the file and reports where it is', async () => {
    const path = join(downloads, 'annual-report-2024.pdf');
    writeFileSync(path, pdfBytes());
    const b = site({ path, name: 'annual-report-2024.pdf', state: 'complete', bytes: 2009 });
    const t = tools(b);
    const args = { what: 'the 2024 annual report', url: 'https://reports.example.org/', type: 'pdf' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('downloaded');
    expect(r.data).toMatchObject({ name: 'annual-report-2024.pdf', path, sizeBytes: 2009, verified: true, from: 'reports.example.org' });
    expect(b.clicked).toEqual(['Download Annual Report 2024 (PDF)']);
    expect(t.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['opening', 'loaded', 'locating', 'download_started', 'checking', 'download_completed']));
    // the page was opened once for the question; the yes did not start the whole search again
    expect(b.opened).toHaveLength(1);
  });

  it('a download that starts and then fails to finish is reported as failed', async () => {
    const b = site({ path: '', name: 'annual-report-2024.pdf', state: 'interrupted', bytes: 100, error: 'the connection dropped' });
    const t = tools(b);
    const args = { what: 'annual report', url: 'https://reports.example.org/' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('download failed');
    expect(r.error).toMatch(/did not finish: the connection dropped/);
  });

  it('a download that goes quiet part-way is a failure too, not "downloading"', async () => {
    const part = join(downloads, 'annual-report-2024.pdf');
    writeFileSync(part, pdfBytes().subarray(0, 300));
    writeFileSync(`${part}.crdownload`, 'x');
    const b = site({ path: '', name: 'annual-report-2024.pdf', state: 'in_progress', bytes: 300 });
    const t = tools(b);
    const args = { what: 'annual report', url: 'https://reports.example.org/' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stopped sending data/);
  });

  it('a download that finishes while it is waited for is checked and reported', async () => {
    const path = join(downloads, 'annual-report-2024.pdf');
    const b = site({ path: '', name: 'annual-report-2024.pdf', state: 'in_progress', bytes: 10 });
    let wrote = false;
    const t = tools(b, {
      sleep: (() => {
        let clock = 0;
        return async (ms: number): Promise<void> => {
          clock += ms;
          if (!wrote && clock >= 500) {
            wrote = true;
            writeFileSync(path, pdfBytes());
          }
        };
      })(),
      now: (() => {
        let n = 0;
        return () => (n += 100);
      })(),
    });
    const args = { what: 'annual report', url: 'https://reports.example.org/' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('downloaded');
  });

  it('never calls a web page saved under a file\'s name a successful download', async () => {
    const path = join(downloads, 'annual-report-2024.pdf');
    writeFileSync(path, '<!DOCTYPE html><html><body>Please log in to download</body></html>');
    const b = site({ path, name: 'annual-report-2024.pdf', state: 'complete', bytes: 70 });
    const t = tools(b);
    const args = { what: 'annual report', url: 'https://reports.example.org/', type: 'pdf' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('file not verified');
    expect(r.error).toMatch(/web page, not the file/);
  });

  it('follows the site to the file\'s own page when the control is not on the first one', async () => {
    const path = join(downloads, 'report.pdf');
    writeFileSync(path, pdfBytes());
    const b = new FakeBrowser({
      'https://reports.example.org/': { snapshot: snap('https://reports.example.org/', 'Reports'), controls: [{ name: 'Annual Report 2024', role: 'link', href: 'https://reports.example.org/r/2024', goes: 'https://reports.example.org/r/2024' }, { name: 'About', role: 'link' }] },
      'https://reports.example.org/r/2024': { snapshot: snap('https://reports.example.org/r/2024', 'Annual Report 2024'), controls: [{ name: 'Download PDF', role: 'button', download: { path, name: 'report.pdf', state: 'complete', bytes: 2009 } }] },
    });
    const t = tools(b);
    const args = { what: 'annual report 2024', url: 'https://reports.example.org/' };
    const asked = await t.download(args);
    expect(asked.summary).toBe('needs confirmation');
    expect(b.clicked).toEqual(['Annual Report 2024']);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(true);
    expect(b.clicked).toEqual(['Annual Report 2024', 'Download PDF']);
  });

  it('refuses sites that give things away without permission, and does not click anything there', async () => {
    const b = new FakeBrowser({ 'https://movierulz.example/': { snapshot: snap('https://movierulz.example/', 'Movies'), controls: [{ name: 'Download 720p', role: 'link', href: 'https://movierulz.example/f.mp4' }] } });
    const r = await tools(b).download({ what: 'a new film', url: 'https://movierulz.example/' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not allowed');
    expect(r.error).toMatch(/without permission/);
    expect(b.clicked).toEqual([]);
  });

  it('a service that only streams has no file: it says so', async () => {
    const b = new FakeBrowser({ 'https://www.netflix.com/title/1': { snapshot: snap('https://www.netflix.com/title/1', 'A Film'), controls: [{ name: 'Download', role: 'button' }] } });
    const r = await tools(b).download({ what: 'the film', url: 'https://www.netflix.com/title/1' });
    expect(r.summary).toBe('streaming only');
    expect(r.error).toMatch(/does not give out a normal video file/);
    const watchOnly = new FakeBrowser({ 'https://films.example.org/': { snapshot: snap('https://films.example.org/', 'Films', 'Watch now. Stream the film online.', { buttons: ['Watch now'] }), controls: [] } });
    const w = await tools(watchOnly).download({ what: 'the film', url: 'https://films.example.org/' });
    expect(w.summary).toBe('streaming only');
  });

  it('never offers a program, or a "fast download" button that is an advert', async () => {
    const b = new FakeBrowser({
      'https://soft.example.org/': {
        snapshot: snap('https://soft.example.org/', 'Soft'),
        controls: [
          { name: 'Download setup.exe', role: 'link', href: 'https://soft.example.org/setup.exe' },
          { name: 'High speed download', role: 'link', href: 'https://ads.other.net/go' },
        ],
      },
    });
    const r = await tools(b).download({ what: 'the report', url: 'https://soft.example.org/' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('no download found');
    expect(b.clicked).toEqual([]);
  });

  it('stops at a CAPTCHA that appears on the way', async () => {
    const b = new FakeBrowser({
      'https://reports.example.org/': { snapshot: snap('https://reports.example.org/', 'Reports'), controls: [{ name: 'Annual Report 2024', role: 'link', goes: 'https://reports.example.org/check' }] },
      'https://reports.example.org/check': { snapshot: snap('https://reports.example.org/check', 'Check', 'Prove you are human.', { challenge: { kind: 'captcha', hint: 'x' } }), controls: [] },
    });
    const r = await tools(b).download({ what: 'annual report 2024', url: 'https://reports.example.org/' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs you');
    expect(r.error).toMatch(/will not try to get past it/);
  });

  it('uses the page\'s own direct link when clicking the control starts nothing, and still checks the file', async () => {
    const path = join(downloads, 'annual-report-2024.pdf');
    writeFileSync(path, pdfBytes());
    const b = site();
    const fetched: string[] = [];
    const t = tools(b, {
      directDownload: async (url) => {
        fetched.push(url);
        return { ok: true, summary: 'downloaded', data: { name: 'annual-report-2024.pdf', path, sizeBytes: 2009 } };
      },
    });
    const args = { what: 'annual report', url: 'https://reports.example.org/', type: 'pdf' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(fetched).toEqual(['https://reports.example.org/files/annual-report-2024.pdf']);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ verified: true, path });
  });

  it('says nothing started when the control did nothing and there is no direct link', async () => {
    const b = new FakeBrowser({ 'https://reports.example.org/': { snapshot: snap('https://reports.example.org/', 'Reports'), controls: [{ name: 'Download report', role: 'button' }] } });
    const t = tools(b);
    const args = { what: 'report', url: 'https://reports.example.org/' };
    await t.download(args);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('no download started');
  });

  it('needs to know what to download, and which site', async () => {
    const t = tools(new FakeBrowser({}));
    expect((await t.download({})).summary).toBe('nothing to download');
    expect((await t.download({ what: 'report' })).summary).toBe('no page');
  });

  it('when the site\'s address is out of date it recovers first, then finds the download', async () => {
    const path = join(downloads, 'annual-report-2024.pdf');
    writeFileSync(path, pdfBytes());
    const b = new FakeBrowser({
      'https://reports-new.org/': {
        snapshot: snap('https://reports-new.org/', 'Reports — official site'),
        controls: [{ name: 'Download annual report 2024', role: 'link', href: 'https://reports-new.org/a.pdf', download: { path, name: 'annual-report-2024.pdf', state: 'complete', bytes: 2009 } }],
      },
    });
    b.searches = [{ title: 'Reports — official site', url: 'https://reports-new.org/', snippet: 'Reports official' }];
    const t = tools(b);
    const args = { what: 'annual report 2024', url: 'https://reports-old.org/', name: 'Reports', type: 'pdf' };
    const asked = await t.download(args);
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toMatch(/reports-new\.org/);
    const r = await t.download({ ...args, confirm: true });
    expect(r.ok).toBe(true);
    expect(r.data?.['from']).toBe('reports-new.org');
  });
});

describe('checking a saved file', () => {
  it('knows a real file from an empty one, a program, a missing one and a page in disguise', async () => {
    const good = join(dir, 'a.pdf');
    writeFileSync(good, pdfBytes());
    expect(await verifyDownloadedFile(good, 'pdf')).toMatchObject({ ok: true, sizeBytes: 2009 });
    const empty = join(dir, 'e.pdf');
    writeFileSync(empty, '');
    expect((await verifyDownloadedFile(empty)).problem).toMatch(/empty/);
    expect((await verifyDownloadedFile(join(dir, 'nope.pdf'))).problem).toMatch(/not on disk/);
    const exe = join(dir, 'x.exe');
    writeFileSync(exe, 'MZ....');
    expect((await verifyDownloadedFile(exe)).problem).toMatch(/program/);
    const fake = join(dir, 'f.pdf');
    writeFileSync(fake, 'just some words, not a pdf at all');
    expect((await verifyDownloadedFile(fake)).problem).toMatch(/does not look like a real \.pdf/);
    const page = join(dir, 'p.zip');
    writeFileSync(page, '<html><head></head><body>blocked</body></html>');
    expect((await verifyDownloadedFile(page)).problem).toMatch(/web page/);
    const png = join(dir, 'i.png');
    writeFileSync(png, Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n'), Buffer.alloc(100)]));
    expect((await verifyDownloadedFile(png)).ok).toBe(true);
    const txt = join(dir, 't.txt');
    writeFileSync(txt, 'plain words');
    expect((await verifyDownloadedFile(txt)).ok).toBe(true);
  });
});

describe('showing it in "Your Agent at Work"', () => {
  it('the thing being done is the current line, a good step is ticked, a trouble crossed, what waits for the person is the blocker', () => {
    const lines: Array<[string, string]> = [];
    const panel = { progress: (k: 'now' | 'done' | 'warn', t: string) => lines.push([k, t]), blocked: (t: string) => lines.push(['blocked', t]) };
    for (const kind of ['opening', 'searching', 'verifying', 'locating', 'checking', 'download_started'] as const) showRecoveryEvent(panel, { kind, message: kind });
    for (const kind of ['loaded', 'redirect', 'content_found', 'download_completed'] as const) showRecoveryEvent(panel, { kind, message: kind });
    for (const kind of ['recovering', 'failed'] as const) showRecoveryEvent(panel, { kind, message: kind });
    showRecoveryEvent(panel, { kind: 'needs_you', message: 'the person' });
    expect(lines.filter(([k]) => k === 'now')).toHaveLength(6);
    expect(lines.filter(([k]) => k === 'done')).toHaveLength(4);
    expect(lines.filter(([k]) => k === 'warn')).toHaveLength(2);
    expect(lines[lines.length - 1]).toEqual(['blocked', 'the person']);
  });
});

describe('find_and_open_website is forgiving about what it is given', () => {
  it('reads an address the way a person writes it: a bare domain is an address, words are what is wanted, another kind of link is refused', () => {
    expect(readAddress('https://example.org/a')).toMatchObject({ url: { href: 'https://example.org/a' }, words: '', refused: false });
    expect(readAddress('example.org/reports')?.url?.href).toBe('https://example.org/reports');
    expect(readAddress('www.example.org')?.url?.href).toBe('https://www.example.org/');
    expect(readAddress('telangana high court cause list')).toMatchObject({ url: null, words: 'telangana high court cause list', refused: false });
    expect(readAddress('ftp://files.example.org/x')).toMatchObject({ url: null, refused: true });
    expect(readAddress(undefined)).toMatchObject({ url: null, words: '', refused: false });
  });

  it('keywords alone are enough: the web is searched and the page that really has it is opened', async () => {
    const b = new FakeBrowser({ 'https://tshc.gov.in/causelist': { snapshot: snap('https://tshc.gov.in/causelist', 'Cause List — Telangana High Court', 'Cause list for today, Telangana High Court. Judgments and orders are listed below with their case numbers.'), controls: [] } });
    b.searches = [{ title: 'Cause List — Telangana High Court', url: 'https://tshc.gov.in/causelist', snippet: 'Today\'s cause list' }];
    const r = await tools(b).find({ keywords: 'telangana high court cause list' });
    expect(r.ok).toBe(true);
    expect((r.data?.['recovery'] as { via: string }).via).toBe('search');
    expect(b.opened).toEqual(['https://tshc.gov.in/causelist']);
  });

  it('words put where an address belongs are taken as what the person is looking for, not refused', async () => {
    const b = new FakeBrowser({ 'https://tshc.gov.in/causelist': { snapshot: snap('https://tshc.gov.in/causelist', 'Cause List — Telangana High Court', 'Cause list for today, Telangana High Court. Judgments and orders are listed below with their case numbers.'), controls: [] } });
    b.searches = [{ title: 'Cause List — Telangana High Court', url: 'https://tshc.gov.in/causelist', snippet: 'cause list' }];
    const r = await tools(b).find({ url: 'telangana high court cause list' });
    expect(r.ok).toBe(true);
    expect((r.data?.['recovery'] as { via: string }).via).toBe('search');
  });

  it('a bare domain is opened as an address', async () => {
    const b = new FakeBrowser({ 'https://example.org/reports': { snapshot: snap('https://example.org/reports', 'Reports Example'), controls: [] } });
    const r = await tools(b).find({ url: 'example.org/reports' });
    expect(r.ok).toBe(true);
    expect(b.opened).toEqual(['https://example.org/reports']);
  });
});
