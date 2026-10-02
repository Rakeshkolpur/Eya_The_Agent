import { describe, it, expect } from 'vitest';
import { findClickTarget, findFillTarget, normalizePageState, stateToSnapshot } from '../src/main/chrome/pageState';
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
