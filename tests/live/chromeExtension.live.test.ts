/**
 * Live integration test: the real Eya Browser Bridge extension, loaded into a
 * real Edge, talking to the real ChromeBridge over the real loopback socket,
 * driven through ChromeBrowserService against a local site made of page
 * structures the code was never written for.
 *
 * Skipped unless EYA_LIVE_BROWSER=1 (it launches a browser). Run with:
 *   EYA_LIVE_BROWSER=1 npx vitest run tests/live
 * Set EYA_LIVE_HEADED=1 to watch it in a visible window.
 *
 * What this can NOT cover: the user's own signed-in profile. A temporary,
 * empty profile is used, so real-world sign-ins, MFA and site-specific
 * behaviour are untested here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { ChromeBridge } from '../../src/main/chrome/ChromeBridge';
import type { SecretStore } from '../../src/main/chrome/ChromeBridge';
import { ChromeBrowserService } from '../../src/main/chrome/ChromeBrowserService';
import { BRIDGE_PORT } from '../../src/main/chrome/protocol';
import { sensitiveActionReason } from '../../src/main/browser/sensitiveActions';
import type { PageSnapshot } from '../../src/main/browser/pageSnapshot';
import type { ActOnPageResult } from '../../src/main/browser/BrowserAutomationService';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const headed = process.env['EYA_LIVE_HEADED'] === '1';

const EDGE_CANDIDATES = [
  join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];

class MemorySecrets implements SecretStore {
  hash: string | null = null;
  loadHash() {
    return this.hash;
  }
  saveHash(h: string) {
    this.hash = h;
  }
  clear() {
    this.hash = null;
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function must<T>(r: ActOnPageResult): Extract<ActOnPageResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${'message' in r ? r.message : ''}`);
  return r;
}

describe.skipIf(!live)('Eya Browser Bridge: real extension, real Edge, real bridge', () => {
  let site: { server: Server; port: number };
  let base = '';
  let bridge: ChromeBridge;
  let svc: ChromeBrowserService;
  let edge: ChildProcess | null = null;
  const secrets = new MemorySecrets();
  const profile = mkdtempSync(join(tmpdir(), 'eya-live-profile-'));
  const downloads = mkdtempSync(join(tmpdir(), 'eya-live-downloads-'));
  const extensionPath = join(process.cwd(), 'eya-chrome-extension');

  beforeAll(async () => {
    const edgePath = EDGE_CANDIDATES.find((p) => existsSync(p));
    if (edgePath === undefined) throw new Error('Edge is not installed; cannot run the live test.');

    site = await startTestSite(0);
    base = `http://127.0.0.1:${site.port}`;

    bridge = new ChromeBridge({ secrets, port: BRIDGE_PORT });
    if (!(await bridge.start())) throw new Error(`port ${BRIDGE_PORT} is busy (is Eya itself running?); stop it and retry.`);
    svc = new ChromeBrowserService(bridge);
    bridge.openPairingWindow();

    // A fresh profile whose downloads go to a throwaway folder instead of the user's real one.
    mkdirSync(join(profile, 'Default'), { recursive: true });
    writeFileSync(
      join(profile, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads } }),
    );

    edge = spawn(
      edgePath,
      [
        `--user-data-dir=${profile}`,
        `--load-extension=${extensionPath}`,
        `--disable-extensions-except=${extensionPath}`,
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        ...(headed ? ['--window-size=1100,850'] : ['--headless=new']),
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    await waitFor(() => bridge.isConnected(), 45_000, 'the extension to connect and pair');
  }, 120_000);

  afterAll(async () => {
    if (edge?.pid !== undefined) {
      try {
        // Only the browser this test started (and its children) — never the user's own Edge.
        execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
    }
    await bridge?.stop();
    site?.server.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }, 30_000);

  const names = (s: PageSnapshot) => [...s.links, ...s.buttons];

  it('paired with the real extension in a real Edge', () => {
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.info()).toMatchObject({ paired: true, browser: 'edge' });
    expect(secrets.hash).not.toBeNull();
  });

  it('a web page cannot talk to the bridge: the Origin check refuses it', async () => {
    const snap = await svc.openWebsite(`${base}/wscheck.html`);
    await waitFor(async () => (await svc.inspectPage()).visibleText?.includes('ws-') === true, 8000, 'the page to try its socket');
    const after = await svc.inspectPage();
    expect(after.visibleText).toContain('ws-blocked');
    expect(after.visibleText).not.toContain('ws-open');
    expect(snap.environment).toBe('your_browser');
    expect(bridge.isConnected()).toBe(true); // and the legitimate connection is untouched
  }, 30_000);

  it('opens a site in the user\'s browser and shows the live page', async () => {
    const snap = await svc.openWebsite(`${base}/menu.html`);
    expect(snap.title).toBe('Courts Portal');
    expect(snap.buttons).toContain('Open menu');
    expect(names(snap)).not.toContain('Cause List'); // hidden until the menu is opened
  }, 30_000);

  it('discovers a hidden menu live: nothing about this site is known in advance', async () => {
    const opened = must(await svc.clickOnPage('Open menu'));
    expect(opened.effects?.changes.navigated).toBe(false);
    expect(opened.effects?.changes.appeared.join(' ')).toContain('Services');
    const sub = must(await svc.clickOnPage('Services'));
    expect(sub.effects?.changes.appeared.join(' ')).toContain('Cause List');
    const page = must(await svc.clickOnPage('Cause List'));
    expect(page.effects?.changes.navigated).toBe(true);
    expect(page.snapshot.title).toBe('Cause List');
    expect(page.snapshot.tables?.[0]?.rows[0]).toEqual(['1', '1', 'WP 101/2026']);
  }, 60_000);

  it('fills a field, presses a button, and sees the result on the page', async () => {
    must(await svc.fillOnPage('Advocate Code', 'ADV-9'));
    const done = must(await svc.clickOnPage('Search'));
    expect(done.snapshot.visibleText).toContain('Searched for ADV-9');
    expect(done.effects?.changes.textChanged).toBe(true);
  }, 30_000);

  it('goes back through the browser history', async () => {
    const back = must(await svc.goBack());
    expect(back.snapshot.title).toBe('Courts Portal');
  }, 30_000);

  it('reuses tabs instead of piling them up, and never steers a tab it did not open', async () => {
    const before = (await svc.listTabs()).length;
    const again = await svc.openWebsite(`${base}/orders.html`); // another page of a site Eya already has a tab for
    expect(again.title).toBe('Orders');
    expect((await svc.listTabs()).length).toBe(before);
    const root = await svc.openWebsite(`${base}/`); // the front door of a site that already has a tab open: just go there
    expect(root.url).toContain('/orders'); // focused the existing tab as it was, rather than reloading it
    expect(root.notes?.join(' ')).toMatch(/already had a tab open/);
    expect((await svc.listTabs()).length).toBe(before);
    const tabs = await svc.listTabs();
    expect(tabs.some((t) => t.workingHere && t.openedByEya)).toBe(true);
  }, 60_000);

  it('a popup covering the page is reported, then dealt with, then the page works', async () => {
    await svc.openWebsite(`${base}/modal.html`);
    const covered = await svc.clickOnPage('Continue to account');
    expect(covered).toMatchObject({ ok: false, reason: 'could_not' });
    if (!covered.ok && covered.reason === 'could_not') expect(covered.message).toMatch(/covering/);
    must(await svc.clickOnPage('Accept cookies'));
    const free = must(await svc.clickOnPage('Continue to account'));
    expect(free.snapshot.visibleText).toContain('under clicked');
  }, 60_000);

  it('follows a link that opens a new tab', async () => {
    await svc.openWebsite(`${base}/newtab.html`);
    const viaLink = must(await svc.clickOnPage('Open orders in new tab'));
    expect(viaLink.effects?.newTab?.title).toBe('Orders');
    expect(viaLink.snapshot.title).toBe('Orders');
    const tabs = await svc.listTabs();
    expect(tabs.find((t) => t.workingHere)?.title).toBe('Orders');
  }, 60_000);

  // KNOWN LIMITATION, pinned here on purpose so it is never forgotten or silently "fixed" by accident:
  // Eya clicks with script-made events, which browsers do not treat as a real user gesture. A page that
  // calls window.open() from a click handler is therefore blocked as a popup. Links (target=_blank) are
  // unaffected. Real trusted clicks would need the 'debugger' permission, which this extension declines.
  it('known limitation: a script-opened popup (window.open) needs a real click and is blocked', async () => {
    const tabs = await svc.listTabs();
    const opener = tabs.find((t) => t.title === 'New tab page');
    expect(opener).toBeDefined();
    await svc.switchToTab(opener!.tabId);
    const before = (await svc.listTabs()).length;
    const result = await svc.clickOnPage('Open cause list popup');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.effects?.newTab).toBeUndefined();
    expect((await svc.listTabs()).length).toBe(before);
  }, 60_000);

  it('downloads a file, and the file is really on disk with the right content', async () => {
    await svc.openWebsite(`${base}/download.html`);
    const r = must(await svc.clickOnPage('Download report'));
    const dl = r.effects?.download;
    expect(dl).toBeDefined();
    expect(dl?.state).toBe('complete');
    expect(dl?.name).toBe('eya-test-report.txt');
    expect(dl?.path.startsWith(downloads)).toBe(true);
    expect(readFileSync(dl!.path, 'utf8')).toBe('eya test download\n');
  }, 60_000);

  it('notices a CAPTCHA and stops: it does not click anything on that page', async () => {
    const snap = await svc.openWebsite(`${base}/captcha.html`);
    expect(snap.challenge?.kind).toBe('captcha');
    expect(await svc.clickOnPage('Continue')).toMatchObject({ ok: false, reason: 'needs_user' });
  }, 30_000);

  it('never types into a password field, and asks before a purchase-like click', async () => {
    await svc.openWebsite(`${base}/forms.html`);
    expect(await svc.fillOnPage('Account password', 'hunter2')).toMatchObject({ ok: false, reason: 'needs_user' });
    const picked = must(await svc.fillOnPage('Year', '2025'));
    // A label that wraps its drop-down is named by its own words ("Year"), not by every option inside it.
    expect(picked.snapshot.inputs).toContain('Year');
    const submitted = must(await svc.fillOnPage('Case number', 'WP 12/2026', { submit: true }));
    expect(submitted.snapshot.visibleText).toContain('Submitted: WP 12/2026');

    const gated = await svc.clickOnPage('Place order', (t) => sensitiveActionReason(t.name, t.role));
    expect(gated).toMatchObject({ ok: false, reason: 'needs_confirmation', target: 'Place order' });
    expect((await svc.inspectPage()).visibleText).not.toContain('Bought it'); // nothing was clicked
    const allowed = must(await svc.clickOnPage('Place order')); // the user said yes: no gate this time
    expect(allowed.snapshot.visibleText).toContain('Bought it');
  }, 60_000);

  it('works on shadow DOM, clickable divs and same-origin frames', async () => {
    await svc.openWebsite(`${base}/shadow.html`);
    must(await svc.clickOnPage('Shadow action'));
    const both = must(await svc.clickOnPage('Fancy div button'));
    expect(both.snapshot.visibleText).toMatch(/shadow clicked/);
    expect(both.snapshot.visibleText).toMatch(/div clicked/);

    await svc.openWebsite(`${base}/frames.html`);
    const filled = must(await svc.fillOnPage('Advocate Code', 'F1'));
    expect(filled.snapshot.inputs).toContain('Advocate Code');
  }, 60_000);

  it('waits for a slow page to finish loading before it looks', async () => {
    const snap = await svc.openWebsite(`${base}/spa.html`);
    expect(snap.links).toContain('Alpha order');
  }, 30_000);

  it('can look at a browser-internal page without falling over, and says it cannot read it', async () => {
    const tabs = await svc.listTabs();
    const blank = tabs.find((t) => t.url === '' || t.url.startsWith('about:') || t.url.startsWith('edge:'));
    if (blank === undefined) return; // no internal tab left open in this run
    const snap = await svc.switchToTab(blank.tabId);
    expect(snap.notes?.join(' ')).toMatch(/browser-internal|protected|not allowed/i);
  }, 30_000);

  it('reads a search-results page in a background tab that closes again', async () => {
    const before = (await svc.listTabs()).length;
    const raw = (await bridge.request('search_page', { url: `${base}/fakesearch.html`, engine: 'duckduckgo' })) as { hits: Array<{ title: string; href: string }> };
    expect(raw.hits).toHaveLength(2);
    expect(raw.hits[0]!.href).toContain('uddg=');
    expect((await svc.listTabs()).length).toBe(before);
  }, 30_000);

  it('refuses to open anything but a normal web address', async () => {
    await expect(bridge.request('open_url', { url: 'file:///C:/Windows/win.ini' })).rejects.toThrow(/http/);
    await expect(bridge.request('open_url', { url: 'javascript:alert(1)' })).rejects.toThrow(/http|valid/);
  }, 30_000);

  it('reconnects by itself after the bridge restarts, using the stored secret (no new pairing)', async () => {
    await bridge.stop();
    expect(bridge.isConnected()).toBe(false);
    await bridge.start();
    expect(bridge.pairingOpen()).toBe(false);
    await waitFor(() => bridge.isConnected(), 60_000, 'the extension to reconnect');
    expect((await svc.inspectPage()).title).toBeTruthy();
  }, 90_000);

  it('after the pairing is forgotten it stays out until the user asks again, then pairs again', async () => {
    bridge.forgetPairing();
    await waitFor(() => !bridge.isConnected(), 10_000, 'the browser to be dropped');
    await new Promise((r) => setTimeout(r, 4000));
    expect(bridge.isConnected()).toBe(false); // it keeps knocking but is refused: no window is open
    bridge.openPairingWindow();
    await waitFor(() => bridge.isConnected(), 60_000, 'the extension to pair again');
    expect((await svc.inspectPage()).title).toBeTruthy();
  }, 120_000);
});
