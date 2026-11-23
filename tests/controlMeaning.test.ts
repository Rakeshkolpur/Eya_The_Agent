import { describe, expect, it } from 'vitest';
import { browserAccessLine } from '../src/main/browser/browserAccess';
import type { BrowserOverview } from '../src/main/browser/BrowserSessionManager';
import { aboutTheScreen, browserAccessNudge, claimsNoBrowserAccess } from '../src/main/agent/browserClaims';
import { describeClick, planClick } from '../src/main/agent/discovery';
import { chooseClickTarget } from '../src/main/chrome/pageState';
import type { PageElement, PageState } from '../src/main/chrome/pageState';

/**
 * Step 1 of reliable browser control: finding a control by what it MEANS, saying exactly what the model has access to, answering a false "I can't use your
 * browser / share your screen", and an open-then-click that is judged only by what the page showed.
 */

function el(over: Partial<PageElement> & Pick<PageElement, 'role' | 'name'>): PageElement {
  return { id: `e1.${over.name}`, inViewport: true, ...over };
}
function page(elements: PageElement[]): PageState {
  return { url: 'https://site.example/', title: 'Site', epoch: 1, headings: [], elements, dialogs: [], visibleText: '', bodyText: '', tables: [], focused: null, scroll: { y: 0, max: 0, atBottom: true }, challenge: null, loading: false, notes: [], restricted: false };
}
const target = (elements: PageElement[], text: string): string | null => {
  const choice = chooseClickTarget(page(elements), text);
  return choice.kind === 'target' ? choice.element.name : null;
};

describe('a control is found by what it means, when nothing carries those exact words', () => {
  it('exact words still win, as before', () => {
    expect(target([el({ role: 'link', name: 'Cause List' }), el({ role: 'link', name: 'Cause List for Districts' })], 'Cause List')).toBe('Cause List');
  });

  it('the same letters however the spaces, hyphens and capitals fall', () => {
    expect(target([el({ role: 'link', name: 'CauseList' }), el({ role: 'link', name: 'Orders' })], 'cause list')).toBe('CauseList');
    expect(target([el({ role: 'link', name: 'Cause-List' })], 'Cause List')).toBe('Cause-List');
    expect(target([el({ role: 'button', name: 'Log In' })], 'login')).toBe('Log In');
  });

  it('all the words, in any order', () => {
    expect(target([el({ role: 'link', name: 'Cause List' }), el({ role: 'link', name: 'Orders' })], 'list cause')).toBe('Cause List');
    expect(target([el({ role: 'link', name: 'My Account Settings' })], 'settings account')).toBe('My Account Settings');
  });

  it('the same purpose under another name', () => {
    expect(target([el({ role: 'link', name: 'Sign in' }), el({ role: 'link', name: 'Help' })], 'log in')).toBe('Sign in');
    expect(target([el({ role: 'link', name: 'Create account' })], 'register')).toBe('Create account');
    expect(target([el({ role: 'link', name: 'Basket' }), el({ role: 'link', name: 'Home' })], 'cart')).toBe('Basket');
    expect(target([el({ role: 'link', name: 'Contact us' })], 'contact')).toBe('Contact us');
  });

  it('an address that says it', () => {
    expect(target([el({ role: 'link', name: 'Today', href: '/courts/causelist.html' }), el({ role: 'link', name: 'Yesterday', href: '/courts/archive.html' })], 'cause list')).toBe('Today');
  });

  it('never guesses between two: a meaning shared by two controls picks neither', () => {
    expect(target([el({ role: 'link', name: 'Sign up' }), el({ role: 'link', name: 'Create account' })], 'register')).toBeNull();
    expect(target([el({ role: 'link', name: 'Today', href: '/causelist/today' }), el({ role: 'link', name: 'Archive', href: '/causelist/archive' })], 'cause list')).toBeNull();
  });

  it('a control that means something else is not taken for it', () => {
    expect(target([el({ role: 'link', name: 'Log out' }), el({ role: 'link', name: 'Home' })], 'log in')).toBeNull();
    expect(target([el({ role: 'link', name: 'Orders' })], 'cause list')).toBeNull();
  });
});

describe('what the model is told about its access to the browser', () => {
  const overview = (over: Partial<BrowserOverview> = {}): BrowserOverview => ({ mode: 'user_browser', browsers: [], waitingToPair: [], outdated: [], pairingOpen: false, workingIn: null, ...over });

  it('connected: that it has hands in it, that it is already allowed, and never to ask for the screen', () => {
    const line = browserAccessLine(overview({ browsers: [{ browser: 'chrome', connected: true, paired: true, tabs: 3, inUse: true }] }));
    expect(line).toContain('Chrome is connected');
    expect(line).toContain('open_website');
    expect(line).toContain('already allowed');
    expect(line).toMatch(/Never ask the user to share their screen/);
  });

  it('not connected: exactly what is missing and what to do — and still not "share your screen"', () => {
    const none = browserAccessLine(overview());
    expect(none).toContain('no browser is connected');
    expect(none).toContain('connect_chrome');
    expect(none).toMatch(/Do not ask them to share their screen/);
    expect(browserAccessLine(overview({ waitingToPair: ['chrome'] }))).toContain('not connected to Eya yet');
    expect(browserAccessLine(overview({ outdated: ['edge'] }))).toContain('must be reloaded');
  });

  it("Eya's own browser needs no extension", () => {
    expect(browserAccessLine(overview({ mode: 'eya_browser' }))).toContain('Eya Browser');
  });
});

describe('a false "I can\'t use your browser" or "share your screen" is recognised', () => {
  it.each([
    'I am unable to interact with your browser, so please share your screen.',
    "I can't open websites or click on anything for you.",
    'Could you share your screen so I can see the page?',
    'Please send me a screenshot of the page.',
    "I don't have the ability to browse the internet.",
    "I'm not able to access your browser directly.",
    'I cannot click on that button.',
    'As an AI language model I cannot browse the web.',
  ])('yes: %s', (text) => {
    expect(claimsNoBrowserAccess(text)).toBe(true);
  });

  it.each([
    'I opened the website and the heading is Example Domain.',
    "I'll share the result in a moment.",
    "Here is what I found: the cause list has 40 cases.",
    'The page asked you to sign in, so I stopped there.',
    "I can't find a link called Cause List on this page; the links are Home and Orders.",
    'The browser is not connected, so I could not open it.',
    '',
  ])('no: %s', (text) => {
    expect(claimsNoBrowserAccess(text)).toBe(false);
  });

  it('a request that is about the screen itself is not argued with', () => {
    expect(aboutTheScreen('what is on my screen right now')).toBe(true);
    expect(aboutTheScreen('take a screenshot')).toBe(true);
    expect(aboutTheScreen('open example.org and click cause list')).toBe(false);
  });

  it('what the model is then told names only tools it was really given', () => {
    const note = browserAccessNudge(['open_website', 'click_on_page', 'web_search']);
    expect(note).toContain('open_website, click_on_page');
    expect(note).not.toContain('fill_on_page');
    expect(note).toMatch(/Do not ask the user to share their screen/);
  });
});

describe('"…and click X" is one plain click, or it is the model\'s', () => {
  it.each([
    ['click Cause List', 'Cause List'],
    ['and click on the Cause List link', 'Cause List'],
    ['then press the login button', 'login'],
    ['go to Orders', 'Orders'],
    ['open "Case Status"', 'Case Status'],
    ['click Open menu', 'Open menu'],
    ['click the Orders tab', 'Orders'],
    ['click the Search icon', 'Search'],
  ])('%s -> %s', (then, label) => {
    expect(planClick(then)).toBe(label);
  });

  it.each([
    '',
    'click Cause List and download the first pdf',
    'click Cause List, then read out the first row',
    'tell me the main heading',
    'fill the search box with ADV-9 and click Search',
    'click the something that has a far too long description to be a label at all really',
  ])('is not one: %s', (then) => {
    expect(planClick(then)).toBeNull();
  });

  it('is judged only by what the page showed: a page that changed is a success, anything else is not', () => {
    const changed = describeClick('Cause List', { ok: true, summary: 'clicked "Cause List"', data: { navigated: true, stateChanged: true, currentPage: { title: 'Cause List', url: 'https://x/c' } } }, 'r');
    expect(changed.verified).toBe(true);
    expect(changed.line).toBe('I clicked "Cause List" and the page changed. It now shows "Cause List".');
    const same = describeClick('Cause List', { ok: true, summary: 'clicked', data: { navigated: false, stateChanged: false, nothingChanged: true } }, 'r');
    expect(same.verified).toBe(false);
    expect(same.line).toContain('nothing on the page changed');
    const asked = describeClick('Pay', { ok: false, summary: 'needs confirmation', error: 'ask first' }, 'r');
    expect(asked.verified).toBe(false);
    expect(asked.note).toContain('do not repeat the same click');
  });
});
