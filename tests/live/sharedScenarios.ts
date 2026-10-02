/**
 * Scenarios that must hold in BOTH of Eya's browsers — her own window and the user's own browser through the
 * extension — because both run the same page script and the same service. They exist to pin down the failure that was
 * reported ("she gets stuck on the main page; the options after the first click are never found"):
 *  - a long header menu on every page must not push the page's own options out of what she is shown;
 *  - links that sit inside a hover-only dropdown must be found and usable;
 *  - a page's text must be readable, and anything on it findable, past the first screenful;
 *  - a search box whose button has the same label must be typed into, not the button.
 */
import { describe, it, expect } from 'vitest';
import type { BrowserAutomationService, ActOnPageResult } from '../../src/main/browser/BrowserAutomationService';

function must(r: ActOnPageResult): Extract<ActOnPageResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${'message' in r ? r.message : ''}`);
  return r;
}

export function registerJourneyScenarios(label: string, get: () => { svc: BrowserAutomationService; base: string }): void {
  describe(`${label}: finding the options that come after the main page`, () => {
    it('the main page shows its own links, the long header menu separately, and hover-menu links under their menu', async () => {
      const { svc, base } = get();
      const home = await svc.openWebsite(`${base}/portal/`);
      expect(home.title).toBe('Welcome to the State Portal');
      expect(home.links).toEqual(expect.arrayContaining(['Citizen Services', 'Business Services', 'Latest notices']));
      // 64 filler department links + the menu bar must not have crowded the page's own links out
      expect(home.links).not.toContain('Department 1');
      expect(home.navigation).toContain('Department 1');
      expect(home.collapsedMenus?.['Services']).toEqual(expect.arrayContaining(['Cause List', 'Orders', 'Case Status']));
      expect(home.collapsedMenus?.['About']).toEqual(expect.arrayContaining(['Our judges']));
    }, 60_000);

    it('after the first click, the options on the NEXT page are what she is shown (not the header again)', async () => {
      const { svc } = get();
      const next = must(await svc.clickOnPage('Citizen Services'));
      expect(next.snapshot.title).toBe('Citizen Services');
      expect(next.snapshot.links).toEqual(
        expect.arrayContaining(['Apply for certificate', 'Track application', 'Download forms', 'Pay property tax', 'Citizen helpline']),
      );
      // the same menu bar as the page before is not repeated
      expect(next.snapshot.navigation).toBeUndefined();
      expect(next.snapshot.navigationSameAsPrevious).toBeGreaterThan(60);
      expect(next.effects?.changes.navigated).toBe(true);
    }, 60_000);

    it('keeps going: a second and third level are found the same way, and the page text can be read', async () => {
      const { svc } = get();
      const forms = must(await svc.clickOnPage('Download forms'));
      expect(forms.snapshot.links).toEqual(expect.arrayContaining(['Birth certificate form', 'Income certificate form']));
      const read = await svc.readPage();
      expect(read.text).toContain('9:00 and 17:00');
      expect(read.nextOffset).toBeNull();
      const birth = must(await svc.clickOnPage('Birth certificate form'));
      expect(birth.snapshot.title).toBe('Birth certificate form');
      expect((await svc.readPage()).text).toContain('50 rupees');
    }, 90_000);

    it('find_on_page searches the whole page, including links a closed menu holds', async () => {
      const { svc, base } = get();
      await svc.openWebsite(`${base}/portal/citizen.html`);
      const hidden = await svc.findOnPage('cause list');
      expect(hidden.matches[0]?.name).toBe('Cause List');
      expect(hidden.matches[0]?.where).toMatch(/closed menu "Services"/);
      const visible = await svc.findOnPage('track application');
      expect(visible.matches[0]?.name).toBe('Track application');
      expect(visible.matches[0]?.where).toMatch(/showing now|further down/);
      const text = await svc.findOnPage('citizen helpline');
      expect(text.matches.length + text.textMatches.length).toBeGreaterThan(0);
      expect((await svc.findOnPage('zzz not here')).matches).toEqual([]);
    }, 60_000);

    it('a link inside a hover-only dropdown can be used, and goBack returns to where she was', async () => {
      const { svc, base } = get();
      await svc.openWebsite(`${base}/portal/citizen.html`);
      const viaMenu = must(await svc.clickOnPage('Cause List'));
      expect(viaMenu.snapshot.title).toBe('Cause List');
      expect(viaMenu.effects?.changes.navigated).toBe(true);
      const back = must(await svc.goBack());
      expect(back.snapshot.title).toBe('Citizen Services');
    }, 60_000);

    it('types into a search box whose button carries the same label (the box, not the button)', async () => {
      const { svc, base } = get();
      await svc.openWebsite(`${base}/searchbox.html`);
      const done = must(await svc.fillOnPage('Search for products', 'running shoes', { submit: true }));
      expect(done.snapshot.visibleText).toContain('Searched: running shoes');
    }, 60_000);
  });
}
