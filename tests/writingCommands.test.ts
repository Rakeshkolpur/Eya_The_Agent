import { describe, it, expect } from 'vitest';
import { WritingCommands, parseWritingIntent } from '../src/main/writing/WritingCommands';
import type { WritingHost } from '../src/main/writing/WritingCommands';
import { createCloudCheck, parseCloudAnswer } from '../src/main/writing/CloudCheck';
import type { FindingView, WatchState } from '../src/main/writing/WritingWatch';

describe('what is said to Writing Watch', () => {
  it('starts and stops watching', () => {
    for (const t of ['watch my writing', 'Eya, watch my writing please', 'start watching my drafting', 'observe my petition while I draft', 'watch me write', 'watch while I draft', 'turn on writing watch', 'keep an eye on my petition while I draft', 'proofread my petition as I type']) {
      expect(parseWritingIntent(t), t).toEqual({ kind: 'start' });
    }
    for (const t of ['stop watching', 'Stop watching my writing.', 'turn off writing watch', 'stop observing my drafting', 'stop proofreading']) {
      expect(parseWritingIntent(t), t).toEqual({ kind: 'stop' });
    }
  });

  it('checks a document once, and the cloud switch both ways', () => {
    for (const t of ['check this document', 'check my petition', 'proofread this draft', 'check this', 'any mistakes in my draft', 'review my petition']) {
      expect(parseWritingIntent(t), t).toEqual({ kind: 'check' });
    }
    expect(parseWritingIntent('allow cloud check')).toEqual({ kind: 'cloud', on: true });
    expect(parseWritingIntent('use Gemini to check my writing')).toEqual({ kind: 'cloud', on: true });
    expect(parseWritingIntent('stop cloud check')).toEqual({ kind: 'cloud', on: false });
    expect(parseWritingIntent("don't send my writing to Gemini")).toEqual({ kind: 'cloud', on: false });
  });

  it('fix, ignore and read', () => {
    for (const t of ['fix it', 'fix that', 'Eya fix it please', 'apply the fix', 'correct it']) expect(parseWritingIntent(t), t).toEqual({ kind: 'fix' });
    for (const t of ['ignore it', 'ignore that', 'skip it', 'dismiss this suggestion']) expect(parseWritingIntent(t), t).toEqual({ kind: 'ignore' });
    for (const t of ['read it', "what's the mistake", 'what did you find', 'tell me the mistake']) expect(parseWritingIntent(t), t).toEqual({ kind: 'read' });
  });

  it('leaves everything else alone', () => {
    for (const t of ['open word', 'check my email', 'watch youtube', 'fix the printer', 'what time is it', 'message Ravi that I will be late', 'remember my WhatsApp contacts', 'check', '', 'watch my kids while I write the whole of the petition in a very long and rambling sentence']) {
      expect(parseWritingIntent(t), t).toBeNull();
    }
  });
});

function host(state: Partial<WatchState> = {}, over: Partial<WritingHost> = {}): { host: WritingHost; calls: string[] } {
  const calls: string[] = [];
  const base: WatchState = { watching: false, source: null, title: '', cloudAllowed: false, findings: [], more: 0, checkedAt: 0, note: '', ...state };
  const h: WritingHost = {
    state: () => base,
    start: () => void calls.push('start'),
    stop: () => void calls.push('stop'),
    checkAll: async () => (calls.push('check'), base.findings.length),
    setCloudAllowed: (on) => void calls.push(`cloud:${on}`),
    fix: async (id) => (calls.push(`fix:${id}`), true),
    dismiss: (id) => (calls.push(`dismiss:${id}`), true),
    cloudAvailable: () => true,
    ...over,
  };
  return { host: h, calls };
}
const finding = (over: Partial<FindingView> = {}): FindingView => ({ id: 'f1', kind: 'repeated_word', message: '"the" is written twice in a row', excerpt: 'the the', paragraph: 3, canFix: true, replace: { from: 'the the', to: 'the' }, ...over });

describe('Writing Watch commands', () => {
  it('starts watching and says what it will and will not do', async () => {
    const { host: h, calls } = host();
    const out = await new WritingCommands(h).tryHandle('watch my writing');
    expect(calls).toEqual(['start']);
    expect(out?.spoken).toMatch(/never change anything unless you click Fix/);
    expect(out?.spoken).toMatch(/stays on this PC/);
  });

  it('is not started or acted on from always-on listening', async () => {
    const { host: h, calls } = host({ findings: [finding()] });
    const w = new WritingCommands(h);
    for (const t of ['watch my writing', 'fix it', 'ignore it', 'check this document', 'allow cloud check']) expect(await w.tryHandle(t, { live: true }), t).toBeNull();
    expect(calls).toEqual([]);
  });

  it('fixes the top suggestion on request, and is honest when it cannot', async () => {
    const ok = host({ watching: true, findings: [finding()] });
    expect((await new WritingCommands(ok.host).tryHandle('fix it'))?.spoken).toBe('Done. "the" is written twice in a row — fixed.');
    expect(ok.calls).toEqual(['fix:f1']);
    const manual = host({ watching: true, findings: [finding({ canFix: false, id: 'f2', message: 'The paragraph numbers jump from 3 to 5' })] });
    const out = await new WritingCommands(manual.host).tryHandle('fix it');
    expect(out).toMatchObject({ ok: false });
    expect(out?.spoken).toMatch(/needs your own decision/);
    expect(manual.calls).toEqual([]);
    const moved = host({ findings: [finding()] }, { fix: async () => false });
    expect((await new WritingCommands(moved.host).tryHandle('fix it'))?.spoken).toMatch(/words have moved/);
    expect((await new WritingCommands(host().host).tryHandle('fix it'))?.spoken).toBe('There is nothing to fix right now.');
  });

  it('ignores and reads the top suggestion', async () => {
    const { host: h, calls } = host({ findings: [finding()] });
    const w = new WritingCommands(h);
    expect((await w.tryHandle('read it'))?.spoken).toBe('"the" is written twice in a row.');
    await w.tryHandle('ignore it');
    expect(calls).toEqual(['dismiss:f1']);
  });

  it('"check this" says how many things it found, or that the document could not be seen', async () => {
    expect((await new WritingCommands(host({ findings: [finding(), finding({ id: 'f2' })] }).host).tryHandle('check this document'))?.spoken).toBe("I found 2 things to look at. They're on the card.");
    expect((await new WritingCommands(host().host).tryHandle('check my petition'))?.spoken).toMatch(/found nothing to correct/);
    const nothing = await new WritingCommands(host({ note: "I can't see a document to check." }).host).tryHandle('check my petition');
    expect(nothing).toMatchObject({ ok: false, spoken: "I can't see a document to check." });
  });

  it('the cloud check needs a key, says exactly what it sends, and can be switched off', async () => {
    const withKey = host();
    const on = await new WritingCommands(withKey.host).tryHandle('allow cloud check');
    expect(withKey.calls).toEqual(['cloud:true']);
    expect(on?.spoken).toMatch(/only that paragraph/);
    const noKey = host({}, { cloudAvailable: () => false });
    expect(await new WritingCommands(noKey.host).tryHandle('allow cloud check')).toMatchObject({ ok: false });
    expect(noKey.calls).toEqual([]);
    const off = host();
    await new WritingCommands(off.host).tryHandle('stop cloud check');
    expect(off.calls).toEqual(['cloud:false']);
  });

  it('stops watching, and says so when it was not', async () => {
    const watching = host({ watching: true });
    await new WritingCommands(watching.host).tryHandle('stop watching');
    expect(watching.calls).toEqual(['stop']);
    expect((await new WritingCommands(host().host).tryHandle('stop watching'))?.spoken).toBe("I wasn't watching.");
  });
});

describe('the deeper check', () => {
  const paragraph = 'The Petitioner submits that the order dated 12.03.2026 are contrary to law and he pray for relief.';

  it('keeps what can be checked against the paragraph and throws away invented quotes', () => {
    const answer = JSON.stringify({
      issues: [
        { quote: 'the order dated 12.03.2026 are', problem: 'The verb should agree with "order" (singular).', fix: 'the order dated 12.03.2026 is' },
        { quote: 'he pray', problem: 'Needs "prays".', fix: 'he prays' },
        { quote: 'words that are not in it', problem: 'Invented.', fix: 'x' },
        { quote: 'a', problem: 'Too short.', fix: 'b' },
      ],
    });
    const found = parseCloudAnswer(answer, paragraph);
    expect(found.map((f) => f.excerpt)).toEqual(['the order dated 12.03.2026 are', 'he pray']);
    expect(found[0]).toMatchObject({ kind: 'ai', replace: { from: 'the order dated 12.03.2026 are', to: 'the order dated 12.03.2026 is' } });
  });

  it('reads an answer in a code fence, and gives nothing for garbage', () => {
    const fenced = '```json\n{"issues":[{"quote":"he pray","problem":"Needs prays.","fix":""}]}\n```';
    expect(parseCloudAnswer(fenced, paragraph)).toEqual([{ kind: 'ai', message: 'Needs prays.', excerpt: 'he pray' }]); // no fix offered when it was not sure
    for (const bad of ['', 'sorry I cannot', '{"issues": "none"}', '{bad json', '{"issues":[{"quote":5}]}']) expect(parseCloudAnswer(bad, paragraph), bad).toEqual([]);
  });

  it('sends only the paragraph, with strict instructions', async () => {
    const seen: Array<{ role: string; content: string }[]> = [];
    const check = createCloudCheck({ complete: async (messages) => (seen.push([...messages]), { text: '{"issues":[]}', toolCalls: [] }) });
    expect(await check.check(paragraph)).toEqual([]);
    expect(seen[0]?.map((m) => m.role)).toEqual(['system', 'user']);
    expect(seen[0]?.[1]?.content).toBe(paragraph); // nothing else of the document goes with it
    expect(seen[0]?.[0]?.content).toMatch(/Do NOT suggest a different style/);
  });
});
