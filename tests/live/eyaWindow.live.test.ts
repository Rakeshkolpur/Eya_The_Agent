/**
 * Live integration test of Eya's OWN browser window (Playwright driving the installed Chrome — Edge as the backup),
 * running the same page script and the same service as the extension path, against the local multi-structure site.
 *
 * Skipped unless EYA_LIVE_BROWSER=1:   EYA_LIVE_BROWSER=1 npx vitest run tests/live
 * EYA_LIVE_CHANNEL=msedge picks Edge instead of Chrome; EYA_LIVE_HEADED=1 shows the window.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { PlaywrightBrowserService } from '../../src/main/browser/PlaywrightBrowserService';
import type { HostChannel } from '../../src/main/browser/PlaywrightPageHost';
import { sensitiveActionReason } from '../../src/main/browser/sensitiveActions';
import type { ActOnPageResult } from '../../src/main/browser/BrowserAutomationService';
import { startTestSite } from '../fixtures/chrome-test-site/server.mjs';
import { registerJourneyScenarios } from './sharedScenarios';

const live = process.env['EYA_LIVE_BROWSER'] === '1';
const channel: HostChannel = process.env['EYA_LIVE_CHANNEL'] === 'msedge' ? 'msedge' : 'chrome';

function must(r: ActOnPageResult): Extract<ActOnPageResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${'message' in r ? r.message : ''}`);
  return r;
}

describe.skipIf(!live)(`Eya's own window (${channel}): the same page script, driven through Playwright`, () => {
  let site: { server: Server; port: number };
  let base = '';
  let svc: PlaywrightBrowserService;
  const profile = mkdtempSync(join(tmpdir(), 'eya-win-profile-'));
  const downloads = mkdtempSync(join(tmpdir(), 'eya-win-downloads-'));

  beforeAll(async () => {
    site = await startTestSite(0);
    base = `http://127.0.0.1:${site.port}`;
    svc = new PlaywrightBrowserService({
      profileDir: join(profile, 'browser-profile'),
      downloadsDir: downloads,
      channels: [channel],
      headless: process.env['EYA_LIVE_HEADED'] !== '1',
    });
  }, 60_000);

  afterAll(async () => {
    await svc?.close();
    site?.server.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true });
    rmSync(downloads, { recursive: true, force: true });
  }, 30_000);

  registerJourneyScenarios('Eya window', () => ({ svc, base }));

  it('discovers a JS-driven hidden menu, fills a form and reads the result', async () => {
    const snap = await svc.openWebsite(`${base}/menu.html`);
    expect(snap.buttons).toContain('Open menu');
    expect(snap.links).not.toContain('Cause List');
    must(await svc.clickOnPage('Open menu'));
    must(await svc.clickOnPage('Services'));
    const page = must(await svc.clickOnPage('Cause List'));
    expect(page.snapshot.title).toBe('Cause List');
    expect(page.snapshot.tables?.[0]?.rows[0]).toEqual(['1', '1', 'WP 101/2026']);
    must(await svc.fillOnPage('Advocate Code', 'ADV-9'));
    expect(must(await svc.clickOnPage('Search')).snapshot.visibleText).toContain('Searched for ADV-9');
  }, 90_000);

  it('reports a covering popup, then works once it is dismissed', async () => {
    await svc.openWebsite(`${base}/modal.html`);
    expect(await svc.clickOnPage('Continue to account')).toMatchObject({ ok: false, reason: 'could_not' });
    must(await svc.clickOnPage('Accept cookies'));
    expect(must(await svc.clickOnPage('Continue to account')).snapshot.visibleText).toContain('under clicked');
  }, 60_000);

  it('follows a new tab, and a download lands on disk with the right content', async () => {
    await svc.openWebsite(`${base}/newtab.html`);
    const viaLink = must(await svc.clickOnPage('Open orders in new tab'));
    expect(viaLink.effects?.newTab?.title).toBe('Orders');

    await svc.openWebsite(`${base}/download.html`);
    const dl = must(await svc.clickOnPage('Download report')).effects?.download;
    expect(dl?.state).toBe('complete');
    expect(dl?.path.startsWith(downloads)).toBe(true);
    expect(existsSync(dl!.path)).toBe(true);
    expect(readFileSync(dl!.path, 'utf8')).toBe('eya test download\n');
  }, 90_000);

  it('stops at a CAPTCHA, never types a password, and asks before a purchase-like click', async () => {
    const captcha = await svc.openWebsite(`${base}/captcha.html`);
    expect(captcha.challenge?.kind).toBe('captcha');
    expect(await svc.clickOnPage('Continue')).toMatchObject({ ok: false, reason: 'needs_user' });

    await svc.openWebsite(`${base}/forms.html`);
    expect(await svc.fillOnPage('Account password', 'hunter2')).toMatchObject({ ok: false, reason: 'needs_user' });
    const gated = await svc.clickOnPage('Place order', (t) => sensitiveActionReason(t.name, t.role));
    expect(gated).toMatchObject({ ok: false, reason: 'needs_confirmation', target: 'Place order' });
    expect((await svc.inspectPage()).visibleText).not.toContain('Bought it');
  }, 60_000);

  it('works on shadow DOM, clickable divs, same-site frames and a page that fills in late', async () => {
    await svc.openWebsite(`${base}/shadow.html`);
    must(await svc.clickOnPage('Shadow action'));
    const both = must(await svc.clickOnPage('Fancy div button'));
    expect(both.snapshot.visibleText).toMatch(/shadow clicked.*div clicked|div clicked.*shadow clicked/s);
    await svc.openWebsite(`${base}/frames.html`);
    expect(must(await svc.fillOnPage('Advocate Code', 'F1')).snapshot.inputs).toContain('Advocate Code');
    expect((await svc.openWebsite(`${base}/spa.html`)).links).toContain('Alpha order');
  }, 90_000);

  it('reads a search-results page in a throwaway tab', async () => {
    const hits = await svc.searchWeb('anything'); // goes to the real search engines; may be empty offline, but must not throw
    expect(Array.isArray(hits)).toBe(true);
  }, 90_000);
});
