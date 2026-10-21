import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { cleanAction, cleanPatch, writingView } from '../src/main/writing/writingIpc';
import type { WatchState } from '../src/main/writing/WritingWatch';

const state = (over: Partial<WatchState> = {}): WatchState => ({
  watching: true,
  source: 'Word',
  title: 'Petition.docx',
  cloudAllowed: true,
  findings: [{ id: 'a', kind: 'repeated_word', message: 'm', excerpt: 'the the', paragraph: 2, canFix: true, replace: { from: 'the the', to: 'the' } }],
  more: 0,
  checkedAt: 5,
  note: '',
  ...over,
});

describe('what the pages are shown', () => {
  it('is the watcher\'s state, plus whether a Gemini key exists', () => {
    expect(writingView(state(), true)).toMatchObject({ watching: true, source: 'Word', cloudAllowed: true, cloudAvailable: true });
    expect(writingView(state(), true).findings[0]).toEqual({ id: 'a', kind: 'repeated_word', message: 'm', excerpt: 'the the', paragraph: 2, canFix: true, replace: { from: 'the the', to: 'the' } });
  });

  it('never says the cloud check is on when there is no key for it', () => {
    expect(writingView(state({ cloudAllowed: true }), false)).toMatchObject({ cloudAllowed: false, cloudAvailable: false });
  });
});

describe('what the pages may ask', () => {
  it('only true or false for the two switches', () => {
    expect(cleanPatch({ watching: true, cloud: false })).toEqual({ watching: true, cloud: false });
    expect(cleanPatch({ watching: 'yes', cloud: 1, other: 'x' })).toEqual({});
    expect(cleanPatch(null)).toEqual({});
  });

  it('only fix or ignore, on a plain identifier', () => {
    expect(cleanAction({ id: 'abc123', action: 'fix' })).toEqual({ id: 'abc123', action: 'fix' });
    expect(cleanAction({ id: 'abc123', action: 'ignore' })).toEqual({ id: 'abc123', action: 'ignore' });
    expect(cleanAction({ id: 'abc', action: 'delete' })).toBeNull();
    expect(cleanAction({ id: '', action: 'fix' })).toBeNull();
    expect(cleanAction({ id: 'x'.repeat(100), action: 'fix' })).toBeNull();
    expect(cleanAction('fix')).toBeNull();
    expect(cleanAction(undefined)).toBeNull();
  });
});
