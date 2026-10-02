import { describe, it, expect } from 'vitest';
import {
  findClickTarget,
  findFillTarget,
  findInPage,
  navigationNames,
  normalizePageState,
  readChunk,
  stateToSnapshot,
} from '../src/main/chrome/pageState';
import { redactUrl } from '../src/main/browser/redactUrl';
import type { PageElement, PageState } from '../src/main/chrome/pageState';
import { anyChange, diffStates } from '../src/main/chrome/stateDiff';
import { pageFingerprint } from '../src/main/browser/loopGuard';

function el(over: Partial<PageElement> & Pick<PageElement, 'role' | 'name'>): PageElement {
  return { id: `e1.${over.name}`, inViewport: true, ...over };
}

function state(over: Partial<PageState> = {}): PageState {
  return {
    url: 'https://site.example/',
    title: 'Site',
    epoch: 1,
    headings: ['Welcome'],
    elements: [],
    dialogs: [],
    visibleText: 'Welcome to the site',
    bodyText: 'Welcome to the site',
    tables: [],
    focused: null,
    scroll: { y: 0, max: 0, atBottom: true },
    challenge: null,
    loading: false,
    notes: [],
    restricted: false,
    ...over,
  };
}

describe('normalizePageState: nothing the page influences is trusted for shape or size', () => {
  it('turns garbage into a safe empty state', () => {
    for (const junk of [null, undefined, 42, 'x', [], { elements: 'nope', headings: 7 }]) {
      const s = normalizePageState(junk);
      expect(s.elements).toEqual([]);
      expect(s.headings).toEqual([]);
      expect(s.challenge).toBeNull();
      expect(typeof s.url).toBe('string');
    }
  });

  it('drops elements with an unknown role or no id, and caps string lengths', () => {
    const s = normalizePageState({
      elements: [
        { id: 'e1.0', role: 'link', name: 'x'.repeat(500), inViewport: true },
        { id: 'e1.1', role: 'nonsense', name: 'bad' },
        { role: 'button', name: 'no id' },
        'a string',
      ],
    });
    expect(s.elements).toHaveLength(1);
    expect(s.elements[0]!.name.length).toBeLessThanOrEqual(120);
  });

  it('never carries the value of a sensitive field, even if one is sent', () => {
    const s = normalizePageState({ elements: [{ id: 'e1.0', role: 'input', name: 'Password', sensitive: true, value: 'hunter2', inViewport: true }] });
    expect(s.elements[0]!.sensitive).toBe(true);
    expect(s.elements[0]!.value).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain('hunter2');
  });

  it('only accepts known challenge kinds', () => {
    expect(normalizePageState({ challenge: { kind: 'captcha', hint: 'h' } }).challenge).toEqual({ kind: 'captcha', hint: 'h' });
    expect(normalizePageState({ challenge: { kind: 'made_up', hint: 'h' } }).challenge).toBeNull();
  });

  it('keeps tables, scroll and notes in range', () => {
    const s = normalizePageState({
      tables: [{ headers: ['A'], rows: [['1'], ['2']], totalRows: 9 }, { headers: [], rows: [] }, 'junk'],
      scroll: { y: 10, max: 100, atBottom: false },
      notes: ['n1', 5, 'n2'],
    });
    expect(s.tables).toEqual([{ headers: ['A'], rows: [['1'], ['2']], totalRows: 9 }]);
    expect(s.scroll).toEqual({ y: 10, max: 100, atBottom: false });
    expect(s.notes).toEqual(['n1', 'n2']);
  });
});

describe('findClickTarget', () => {
  const s = state({
    elements: [
      el({ role: 'link', name: 'Cause List Archive' }),
      el({ role: 'link', name: 'Cause List' }),
      el({ role: 'button', name: 'Search' }),
      el({ role: 'button', name: 'Search', disabled: true }),
      el({ role: 'input', name: 'Search box' }),
      el({ role: 'clickable', name: 'Fancy div' }),
    ],
  });

  it('prefers an exact match over a longer partial one, wherever it sits in the list', () => {
    expect(findClickTarget(s, 'cause list')?.name).toBe('Cause List');
  });

  it('falls back to the shortest partial match', () => {
    expect(findClickTarget(s, 'archive')?.name).toBe('Cause List Archive');
  });

  it('never picks an input field to click, and never matches nothing', () => {
    expect(findClickTarget(s, 'Search box')).toBeNull();
    expect(findClickTarget(s, 'does not exist')).toBeNull();
    expect(findClickTarget(s, '')).toBeNull();
  });

  it('prefers an enabled control, but still returns a disabled one if that is all there is', () => {
    expect(findClickTarget(s, 'Search')?.disabled).toBeUndefined();
    const onlyDisabled = state({ elements: [el({ role: 'button', name: 'Pay', disabled: true })] });
    expect(findClickTarget(onlyDisabled, 'Pay')?.disabled).toBe(true);
  });

  it('can click a div that merely looks clickable', () => {
    expect(findClickTarget(s, 'Fancy div')?.role).toBe('clickable');
  });
});

describe('findFillTarget', () => {
  const s = state({
    elements: [el({ role: 'input', name: 'Advocate Code' }), el({ role: 'select', name: 'Year' }), el({ role: 'button', name: 'Year' }), el({ role: 'input', name: '' })],
  });
  it('finds fields by their label, ignoring buttons and unlabelled fields', () => {
    expect(findFillTarget(s, 'advocate code')?.role).toBe('input');
    expect(findFillTarget(s, 'year')?.role).toBe('select');
    expect(findFillTarget(s, 'nothing')).toBeNull();
  });
});

describe('stateToSnapshot', () => {
  it('shows the same simple lists as before plus the richer detail', () => {
    const snap = stateToSnapshot(
      state({
        elements: [
          el({ role: 'link', name: 'Home' }),
          el({ role: 'menuitem', name: 'Services' }),
          el({ role: 'button', name: 'Search' }),
          el({ role: 'checkbox', name: 'I agree' }),
          el({ role: 'input', name: 'Case number' }),
          el({ role: 'select', name: 'Year' }),
        ],
        tables: [{ headers: ['Court'], rows: [['1']], totalRows: 1 }],
        focused: 'Case number',
        notes: ['one'],
      }),
      { environment: 'your_browser', notes: ['two'] },
    );
    expect(snap.links).toEqual(['Home', 'Services']);
    expect(snap.buttons).toEqual(['Search', 'I agree']);
    expect(snap.inputs).toEqual(['Case number', 'Year']);
    expect(snap.visibleText).toBe('Welcome to the site');
    expect(snap.tables).toHaveLength(1);
    expect(snap.focused).toBe('Case number');
    expect(snap.environment).toBe('your_browser');
    expect(snap.notes).toEqual(['one', 'two']);
  });

  it('carries a challenge through, and text changes alone move the loop-guard fingerprint', () => {
    const a = stateToSnapshot(state({ challenge: { kind: 'captcha', hint: 'x' } }));
    expect(a.challenge?.kind).toBe('captcha');
    const t1 = stateToSnapshot(state({ visibleText: 'No records found' }));
    const t2 = stateToSnapshot(state({ visibleText: '3 records found' }));
    expect(pageFingerprint(t1)).not.toBe(pageFingerprint(t2));
  });
});

describe('diffStates', () => {
  it('reports what appeared, what went, a new dialog and a changed address — and nothing else', () => {
    const before = state({ elements: [el({ role: 'button', name: 'Open menu' }), el({ role: 'link', name: 'Home' })] });
    const after = state({
      url: 'https://site.example/next',
      title: 'Next',
      elements: [el({ role: 'link', name: 'Home' }), el({ role: 'link', name: 'Cause List' }), el({ role: 'link', name: 'Orders' })],
      dialogs: ['Please accept cookies'],
      visibleText: 'Different words',
    });
    const d = diffStates(before, after);
    expect(d.navigated).toBe(true);
    expect(d.urlChanged).toEqual({ from: 'https://site.example/', to: 'https://site.example/next' });
    expect(d.appeared).toEqual(['link: Cause List', 'link: Orders']);
    expect(d.disappeared).toEqual(['button: Open menu']);
    expect(d.dialogOpened).toBe('Please accept cookies');
    expect(d.textChanged).toBe(true);
    expect(anyChange(d)).toBe(true);
  });

  it('sees a menu expanding in place as a change that is not a navigation', () => {
    const before = state({ elements: [el({ role: 'button', name: 'Services' })] });
    const after = state({ elements: [el({ role: 'button', name: 'Services' }), el({ role: 'link', name: 'Cause List' })] });
    const d = diffStates(before, after);
    expect(d.navigated).toBe(false);
    expect(d.appearedCount).toBe(1);
    expect(anyChange(d)).toBe(true);
  });

  it('reports no change for an identical page, ignoring whitespace noise', () => {
    const a = state({ visibleText: 'Hello   there' });
    const b = state({ visibleText: 'Hello there' });
    expect(anyChange(diffStates(a, b))).toBe(false);
  });

  it('caps what it lists but keeps the true count', () => {
    const many = Array.from({ length: 30 }, (_, i) => el({ role: 'link', name: `Link ${i}` }));
    const d = diffStates(state(), state({ elements: many }));
    expect(d.appeared).toHaveLength(8);
    expect(d.appearedCount).toBe(30);
  });
});

describe('a long header menu cannot push the page\'s own options out of what the model is shown', () => {
  const header = Array.from({ length: 70 }, (_, i) => el({ role: 'link', name: `Department ${i + 1}`, region: 'header' }));
  const mine = [el({ role: 'link', name: 'Track application', region: 'main' }), el({ role: 'link', name: 'Download forms' })]; // one in <main>, one with no landmark at all
  const closed = [
    el({ role: 'link', name: 'Cause List', hidden: true, menu: 'Services', region: 'header', inViewport: false }),
    el({ role: 'link', name: 'Orders', hidden: true, menu: 'Services', region: 'header', inViewport: false }),
    el({ role: 'link', name: 'Our judges', hidden: true, menu: 'About', inViewport: false }),
  ];
  const s = state({ elements: [...header, ...mine, ...closed] });

  it('lists the page\'s own links apart from the site menu bar, and closed-menu links under their menu', () => {
    const snap = stateToSnapshot(s);
    expect(snap.links).toEqual(['Track application', 'Download forms']);
    expect(snap.navigation).toHaveLength(60); // capped, but it is the menu bar, not the page
    expect(snap.navigation?.[0]).toBe('Department 1');
    expect(snap.collapsedMenus).toEqual({ Services: ['Cause List', 'Orders'], About: ['Our judges'] });
  });

  it('does not repeat the same menu bar on the next page, and says how big it is', () => {
    const first = stateToSnapshot(s);
    expect(first.navigationSameAsPrevious).toBeUndefined();
    const next = stateToSnapshot(s, { previousNavigation: new Set(navigationNames(s)) });
    expect(next.navigation).toBeUndefined();
    expect(next.navigationSameAsPrevious).toBe(70);
    expect(next.links).toEqual(['Track application', 'Download forms']);
  });

  it('shows the menu bar again when it really is a different one', () => {
    const next = stateToSnapshot(s, { previousNavigation: new Set(['Something', 'Else entirely']) });
    expect(next.navigation).toBeDefined();
    expect(next.navigationSameAsPrevious).toBeUndefined();
  });

  it('gives the page\'s own links much more room than before (80, not 40) and says when there are more', () => {
    const many = Array.from({ length: 95 }, (_, i) => el({ role: 'link', name: `Option ${i + 1}`, region: 'main' }));
    const snap = stateToSnapshot(state({ elements: many }));
    expect(snap.links).toHaveLength(80);
    expect(snap.moreLinks).toBe(15);
    expect(snap.truncated).toBe(true);
  });

  it('a link showing on the page wins over an identically named one only a closed menu holds, when clicking', () => {
    const both = state({
      elements: [
        el({ role: 'link', name: 'Cause List', hidden: true, menu: 'Services', id: 'hidden-one', inViewport: false }),
        el({ role: 'link', name: 'Cause List', id: 'visible-one' }),
      ],
    });
    expect(findClickTarget(both, 'cause list')?.id).toBe('visible-one');
    const onlyHidden = state({ elements: [el({ role: 'link', name: 'Cause List', hidden: true, menu: 'Services', inViewport: false })] });
    expect(findClickTarget(onlyHidden, 'cause list')?.hidden).toBe(true);
  });
});

describe('findInPage: look through everything the page has, not just the first screenful', () => {
  const s = state({
    elements: [
      el({ role: 'link', name: 'Home' }),
      el({ role: 'link', name: 'Cause List', hidden: true, menu: 'Services', inViewport: false }),
      el({ role: 'link', name: 'Cause list archive', inViewport: false, href: 'https://x.example/archive' }),
      el({ role: 'link', name: 'Track application', region: 'main' }),
      el({ role: 'link', name: 'Contact us', region: 'footer', inViewport: false }),
      el({ role: 'link', name: 'Annual report', href: 'https://x.example/downloads/annual-report' }),
    ],
    bodyText: 'Welcome.\nTo check a case, open the Cause List for the day and search by advocate code.\nOffices close at 5pm.',
  });

  it('finds a link held by a closed menu, ranks an exact name first, and says exactly where each one is', () => {
    const r = findInPage(s, 'cause list');
    expect(r.matches.map((m) => m.name)).toEqual(['Cause List', 'Cause list archive']);
    expect(r.matches[0]?.where).toBe('inside the closed menu "Services" (not showing until that menu is opened or hovered)');
    expect(r.matches[1]?.where).toBe('further down the page');
  });

  it('says whether something is showing, further down, in the footer…', () => {
    expect(findInPage(s, 'track application').matches[0]?.where).toBe('showing now');
    expect(findInPage(s, 'contact').matches[0]?.where).toBe('further down the page, in the footer');
  });

  it('also finds a control by a word in its address, and shows that address', () => {
    const r = findInPage(s, 'annual report');
    expect(r.matches[0]).toMatchObject({ name: 'Annual report', href: 'https://x.example/downloads/annual-report' });
    expect(findInPage(s, 'archive').matches[0]?.href).toBe('https://x.example/archive');
  });

  it('quotes the page\'s own text around the words', () => {
    const r = findInPage(s, 'advocate code');
    expect(r.matches).toEqual([]);
    expect(r.textMatches[0]).toContain('search by advocate code');
  });

  it('reports nothing at all honestly, with how many controls were searched', () => {
    const r = findInPage(s, 'zzz');
    expect(r.matches).toEqual([]);
    expect(r.textMatches).toEqual([]);
    expect(r.totalControls).toBe(6);
    expect(findInPage(s, '   ').matches).toEqual([]);
  });
});

describe('readChunk: reading a long page a slice at a time', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `Line number ${i + 1} of the notice with some filler words.`).join('\n');
  const s = state({ bodyText: lines });

  it('reads from the top, cuts at a line break, and says where to continue', () => {
    const a = readChunk(s, 0);
    expect(a.offset).toBe(0);
    expect(a.text.startsWith('Line number 1 ')).toBe(true);
    expect(a.text.endsWith('filler words.')).toBe(true); // never mid-sentence
    expect(a.nextOffset).not.toBeNull();
    expect(a.totalChars).toBe(lines.length);
  });

  it('can read the whole page by following nextOffset, with nothing lost or repeated, and ends cleanly', () => {
    let offset: number | null = 0;
    const seen: string[] = [];
    for (let guard = 0; offset !== null && guard < 50; guard++) {
      const chunk = readChunk(s, offset);
      seen.push(...chunk.text.split('\n'));
      offset = chunk.nextOffset;
    }
    expect(offset).toBeNull();
    expect(seen.join('\n')).toBe(lines);
  });

  it('copes with an offset past the end and with an empty page', () => {
    expect(readChunk(s, 10_000_000)).toMatchObject({ text: '', nextOffset: null });
    expect(readChunk(state({ bodyText: '' }), 0)).toMatchObject({ text: '', nextOffset: null, totalChars: 0 });
  });
});

describe('addresses the model is shown never carry credentials', () => {
  it('strips fragments and anything credential-shaped, keeps ordinary search terms', () => {
    expect(redactUrl('https://x.example/orders?page=2&token=abc123&q=shoes#access_token=zzz')).toBe('https://x.example/orders?page=2&q=shoes');
    expect(redactUrl('https://x.example/cb?code=oauth-code&state=ok')).toBe('https://x.example/cb?state=ok');
    expect(redactUrl(`https://x.example/p?blob=${'a'.repeat(60)}`)).toBe('https://x.example/p');
    expect(redactUrl('https://x.example/a/b')).toBe('https://x.example/a/b');
  });

  it('is applied to every page state, whichever browser it came from, and is safe to apply twice', () => {
    const once = normalizePageState({ url: 'https://x.example/in?sessionid=SECRET&lang=en#frag' });
    expect(once.url).toBe('https://x.example/in?lang=en');
    expect(redactUrl(once.url)).toBe(once.url);
    expect(redactUrl('not a url')).toBe('not a url');
  });
});

