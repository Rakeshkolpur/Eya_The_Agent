import { describe, it, expect, beforeEach } from 'vitest';
import { WritingWatch } from '../src/main/writing/WritingWatch';
import type { WatchState } from '../src/main/writing/WritingWatch';
import type { DocumentText, RawFinding, TextSource } from '../src/main/writing/types';

class FakeDocument implements TextSource {
  readonly name = 'Word';
  doc: DocumentText | null;
  replaced: Array<{ paragraph: number; from: string; to: string }> = [];
  canReplace = true;
  close?: () => void;
  constructor(paragraphs: string[], active = 0, title = 'Petition.docx', extra: Partial<DocumentText> = {}) {
    this.doc = { app: 'word', title, paragraphs, active, ...extra };
  }
  async read(): Promise<DocumentText | null> {
    return this.doc === null ? null : { ...this.doc, paragraphs: [...this.doc.paragraphs] };
  }
  async replace(paragraph: number, from: string, to: string, seen: string): Promise<boolean> {
    this.replaced.push({ paragraph, from, to });
    if (!this.canReplace || this.doc === null) return false;
    const text = this.doc.paragraphs[paragraph - 1] ?? '';
    if (text !== seen || !text.includes(from)) return false; // the paragraph is not the one that was read
    this.doc = { ...this.doc, paragraphs: this.doc.paragraphs.map((p, i) => (i === paragraph - 1 ? p.replace(from, to) : p)) };
    return true;
  }
  set(paragraphs: string[], active = this.doc?.active ?? 0): void {
    if (this.doc !== null) this.doc = { ...this.doc, paragraphs, active };
  }
}

let clock = 0;
let states: WatchState[] = [];
const rig = (source: TextSource, cloud?: { check(p: string): Promise<readonly RawFinding[]> }) =>
  new WritingWatch({ sources: [source], ...(cloud !== undefined ? { cloud } : {}), onChange: (s) => void states.push(s), now: () => clock, schedule: () => () => undefined, pauseMs: 1800 });
const last = (): WatchState => states[states.length - 1] as WatchState;

/** One look, then enough quiet time passes for the pause to be over, and one more look. */
async function settle(watch: WritingWatch): Promise<void> {
  await watch.tick();
  clock += 2000;
  await watch.tick();
}

beforeEach(() => {
  clock = 1_000_000;
  states = [];
});

describe('Writing Watch: what is checked, and when', () => {
  it('leaves what was already written alone, and checks what is written after it starts looking', async () => {
    const doc = new FakeDocument(['An old paragraph with the the slip already in it.', 'Second paragraph.'], 2);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    expect(last().findings).toEqual([]); // the old slip is not reported unprompted
    expect(last()).toMatchObject({ watching: true, source: 'Word', title: 'Petition.docx' });

    doc.set(['An old paragraph with the the slip already in it.', 'Second paragraph.', 'The Petitioner humbly submits that the the order is illegal.'], 3);
    await watch.tick(); // just changed: still being written, so not checked yet
    expect(last().findings).toEqual([]);
    clock += 2000; // the writing paused
    await watch.tick();
    expect(last().findings).toHaveLength(1);
    expect(last().findings[0]).toMatchObject({ kind: 'repeated_word', paragraph: 3, canFix: true, message: '"the" is written twice in a row' });
  });

  it('moving the cursor into or out of an old paragraph is not writing in it (found with real Word)', async () => {
    const doc = new FakeDocument(['An old paragraph with the the slip already in it.', 'Second.'], 1); // the cursor starts inside the old one
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['An old paragraph with the the slip already in it.', 'Second.', 'A new one.'], 3); // the user moved down and began a new paragraph
    await settle(watch);
    doc.set(['An old paragraph with the the slip already in it.', 'Second.', 'A new one.'], 1); // and back up again
    await settle(watch);
    expect(last().findings).toEqual([]);
  });

  it('does not judge brackets and quotation marks in the paragraph being typed — only after the cursor leaves it', async () => {
    const doc = new FakeDocument(['First.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['First.', 'The sum (as stated in the order'], 2); // the cursor is in it: the bracket is still open on purpose
    await settle(watch);
    expect(last().findings).toEqual([]);
    doc.set(['First.', 'The sum (as stated in the order', 'Next paragraph.'], 3); // the cursor moved on
    await settle(watch);
    expect(last().findings.map((f) => f.kind)).toEqual(['brackets']);
  });

  it('keeps a slip only while its words are there: fixing or rewriting them clears it, and it follows its paragraph', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    expect(last().findings[0]?.paragraph).toBe(2);
    doc.set(['A new paragraph above.', 'Start.', 'It was held that the the order stands.'], 3); // a paragraph was inserted above
    await watch.tick();
    expect(last().findings[0]?.paragraph).toBe(3);
    doc.set(['A new paragraph above.', 'Start.', 'It was held that the order stands.'], 3); // the user fixed it themselves
    await watch.tick();
    expect(last().findings).toEqual([]);
  });

  it('a fix is made only on request, through the program, and only if the words are still there', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    expect(doc.replaced).toEqual([]); // nothing was changed on its own
    const id = last().findings[0]?.id as string;
    expect(await watch.fix(id)).toBe(true);
    expect(doc.replaced).toEqual([{ paragraph: 2, from: 'the the', to: 'the' }]);
    expect(doc.doc?.paragraphs[1]).toBe('It was held that the order stands.');
    expect(last().findings).toEqual([]);
    expect(await watch.fix(id)).toBe(false); // already done

    doc.set(['Start.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    doc.canReplace = false; // Word says no (the words moved)
    expect(await watch.fix(last().findings[0]?.id as string)).toBe(false);
    expect(last().findings).toHaveLength(1); // and nothing pretends it was fixed
  });

  it('an ignored slip stays ignored, even when its paragraph is edited', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    expect(watch.dismiss(last().findings[0]?.id as string)).toBe(true);
    expect(last().findings).toEqual([]);
    doc.set(['Start.', 'It was held that the the order stands, and so on.'], 2); // edited, the same slip still in it
    await settle(watch);
    expect(last().findings).toEqual([]);
  });

  it('says so when there is nothing to read, and starts afresh with a different document', async () => {
    const doc = new FakeDocument(['One.'], 1, 'First.docx');
    const watch = rig(doc);
    watch.start();
    expect(last().note).toMatch(/Open your document/);
    await settle(watch);
    doc.set(['One.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    expect(last().findings).toHaveLength(1);
    doc.doc = null; // Word was closed
    await watch.tick();
    expect(last()).toMatchObject({ findings: [], source: null });
    expect(last().note).toMatch(/Open your document/);
    doc.doc = { app: 'word', title: 'Second.docx', paragraphs: ['Old text with the the slip.'], active: 1 };
    await settle(watch);
    expect(last().findings).toEqual([]); // the second document's existing text is its baseline
    expect(last().title).toBe('Second.docx');
  });
});

describe("the program's own spell checker", () => {
  it('brings its suggestions, skips abbreviations and a name the user spells the same way throughout', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'Raghavendra and Raghavendra met the SEBI officer and the recieved letter from CBI_2.'], 2);
    doc.doc = {
      ...(doc.doc as DocumentText),
      misspelled: [
        { paragraph: 2, word: 'Raghavendra', suggestions: [] },
        { paragraph: 2, word: 'SEBI', suggestions: [] },
        { paragraph: 2, word: 'CBI_2', suggestions: [] },
        { paragraph: 2, word: 'recieved', suggestions: ['received', 'relieved'] },
      ],
    };
    await settle(watch);
    expect(last().findings).toHaveLength(1);
    expect(last().findings[0]).toMatchObject({ kind: 'spelling', message: '"recieved" may be misspelled — did you mean "received" or "relieved"?', replace: { from: 'recieved', to: 'received' } });
  });

  it('ignoring one spelling ignores that word everywhere', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.doc = { ...(doc.doc as DocumentText), paragraphs: ['Start.', 'Chaluvagali came.'], active: 2, misspelled: [{ paragraph: 2, word: 'Chaluvagali', suggestions: [] }] };
    await settle(watch);
    expect(last().findings).toHaveLength(1);
    watch.dismiss(last().findings[0]?.id as string);
    doc.doc = { ...(doc.doc as DocumentText), paragraphs: ['Start.', 'Chaluvagali came.', 'Then Chaluvagali left.'], active: 3, misspelled: [{ paragraph: 3, word: 'Chaluvagali', suggestions: [] }] };
    await settle(watch);
    expect(last().findings).toEqual([]);
  });
});

describe('"check this": the whole document, on request', () => {
  it('reports slips in old paragraphs too, and works without watching', async () => {
    const doc = new FakeDocument(['An old paragraph with the the slip.', 'Rs. 5,00,000/- (Rupees five lakh fifty thousand only) was paid on 31.02.2026.'], 1);
    const watch = rig(doc);
    expect(watch.isWatching()).toBe(false);
    expect(await watch.checkAll()).toBe(3);
    expect(last().findings.map((f) => f.kind).sort()).toEqual(['amount', 'date', 'repeated_word']);
  });

  it('says so when there is no document to check', async () => {
    const watch = rig(new FakeDocument([], 0));
    (watch as unknown as { deps: { sources: TextSource[] } }).deps.sources[0]?.read; // (the fake has a document; make it go away)
    const none = new FakeDocument([], 0);
    none.doc = null;
    const w2 = rig(none);
    expect(await w2.checkAll()).toBe(0);
    expect(last().note).toMatch(/can't see a document/);
  });
});

describe('the optional deeper check', () => {
  const longParagraph = 'The Petitioner respectfully submits that the impugned order dated twelfth March is contrary to law.';

  it('is never called unless the user has allowed it', async () => {
    const calls: string[] = [];
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc, { check: async (p) => (calls.push(p), []) });
    watch.start();
    await settle(watch);
    doc.set(['Start.', longParagraph], 2);
    await settle(watch);
    expect(calls).toEqual([]);
  });

  it('checks only the paragraph being written, once, and shows what it says', async () => {
    const calls: string[] = [];
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc, {
      check: async (p) => {
        calls.push(p);
        return [{ kind: 'ai', message: 'Say "is contrary to law" as "is contrary to the law"', excerpt: 'is contrary to law', replace: { from: 'is contrary to law', to: 'is contrary to the law' } }];
      },
    });
    watch.setCloudAllowed(true);
    watch.start();
    await settle(watch);
    doc.set(['Start.', longParagraph], 2);
    await settle(watch);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([longParagraph]); // the one paragraph, nothing else
    expect(last().cloudAllowed).toBe(true);
    expect(last().findings.map((f) => f.kind)).toEqual(['ai']);
    await settle(watch);
    expect(calls).toHaveLength(1); // the same words are not sent again
  });

  it('skips a short paragraph, and stops the moment the user takes the permission back', async () => {
    const calls: string[] = [];
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc, { check: async (p) => (calls.push(p), []) });
    watch.setCloudAllowed(true);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'Too short to send.'], 2);
    await settle(watch);
    expect(calls).toEqual([]);
    watch.setCloudAllowed(false);
    doc.set(['Start.', longParagraph], 2);
    await settle(watch);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });

  it('a failing cloud check never stops the local ones', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc, { check: async () => { throw new Error('offline'); } });
    watch.setCloudAllowed(true);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'It was held that the the order of the Court, which is contrary to law, stands.'], 2);
    await settle(watch);
    await new Promise((r) => setTimeout(r, 0));
    expect(last().findings.map((f) => f.kind)).toEqual(['repeated_word']);
  });
});

describe('the card is never flooded', () => {
  it('shows the nearest few and says how many more', async () => {
    const doc = new FakeDocument(['Start.'], 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', ...Array.from({ length: 9 }, (_, i) => `Paragraph ${i} where the the word is doubled.`)], 10);
    await settle(watch);
    expect(last().findings).toHaveLength(6);
    expect(last().more).toBe(3);
    expect(last().findings[0]?.paragraph).toBe(10); // the one nearest the cursor first
  });

  it('stopping clears everything and closes the sources', async () => {
    let closed = 0;
    const doc = new FakeDocument(['Start.'], 1);
    doc.close = () => void (closed += 1);
    const watch = rig(doc);
    watch.start();
    await settle(watch);
    doc.set(['Start.', 'It was held that the the order stands.'], 2);
    await settle(watch);
    expect(last().findings).toHaveLength(1);
    watch.stop();
    expect(last()).toMatchObject({ watching: false, findings: [], note: '' });
    expect(closed).toBe(1);
  });
});
