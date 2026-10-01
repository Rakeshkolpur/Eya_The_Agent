import { describe, it, expect } from 'vitest';
import { buildSnapshot, findBestTextMatchIndex } from '../src/main/browser/pageSnapshot';

describe('buildSnapshot', () => {
  it('dedupes, trims and collapses whitespace', () => {
    const snap = buildSnapshot(
      'https://example.com',
      'Example',
      ['  Welcome  ', 'Welcome'],
      ['Cause List', 'cause list', 'Case Status'],
      ['Search'],
      ['Advocate Code'],
    );
    expect(snap.headings).toEqual(['Welcome']);
    expect(snap.links).toEqual(['Cause List', 'Case Status']);
    expect(snap.buttons).toEqual(['Search']);
    expect(snap.inputs).toEqual(['Advocate Code']);
    expect(snap.truncated).toBe(false);
  });

  it('drops empty/whitespace-only entries', () => {
    const snap = buildSnapshot('u', 't', ['', '   '], ['Home', ''], [], []);
    expect(snap.headings).toEqual([]);
    expect(snap.links).toEqual(['Home']);
  });

  it('caps each category and reports truncation', () => {
    const many = Array.from({ length: 50 }, (_, i) => `Link ${i}`);
    const snap = buildSnapshot('u', 't', [], many, [], []);
    expect(snap.links).toHaveLength(40);
    expect(snap.truncated).toBe(true);
  });

  it('carries url and title through unchanged', () => {
    const snap = buildSnapshot('https://tshc.gov.in', 'High Court for the State of Telangana', [], [], [], []);
    expect(snap.url).toBe('https://tshc.gov.in');
    expect(snap.title).toBe('High Court for the State of Telangana');
  });

  it('defaults to no dialogs when none are given, and dedupes/caps them the same as everything else', () => {
    const noDialogs = buildSnapshot('u', 't', [], [], [], []);
    expect(noDialogs.dialogs).toEqual([]);
    const withDialog = buildSnapshot('u', 't', [], [], [], [], ['Please sign in', 'Please sign in']);
    expect(withDialog.dialogs).toEqual(['Please sign in']);
  });
});

describe('findBestTextMatchIndex', () => {
  const candidates = ['Home', 'Cause List', 'Case Status', 'Orders', 'Judgments'];

  it('prefers an exact (normalized) match', () => {
    expect(findBestTextMatchIndex('cause list', candidates)).toBe(1);
    expect(findBestTextMatchIndex('Cause List', candidates)).toBe(1);
  });

  it('falls back to the shortest substring match', () => {
    const ambiguous = ['Case Status', 'Case Status Detailed View'];
    expect(findBestTextMatchIndex('case status', ambiguous)).toBe(0);
  });

  it('returns null when nothing matches', () => {
    expect(findBestTextMatchIndex('cause list', candidates.filter((c) => c !== 'Cause List'))).toBeNull();
  });

  it('returns null for an empty query', () => {
    expect(findBestTextMatchIndex('', candidates)).toBeNull();
  });

  it('matches regardless of extra whitespace, including real page markup padding', () => {
    expect(findBestTextMatchIndex('cause   list', ['Cause List'])).toBe(0);
    expect(findBestTextMatchIndex('entire causelist', ['\n        \n  Entire Causelist\n   \n  '])).toBe(0);
  });

  it('returns the index of the match, not the text, so a caller can re-select on the same locator', () => {
    expect(findBestTextMatchIndex('orders', candidates)).toBe(3);
  });
});
