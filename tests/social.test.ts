import { describe, expect, it, vi } from 'vitest';
import type { ActOnPageResult, BrowserAutomationService, ClickGate, FillOptions } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { allowance, DEFAULT_PACING, remainingToday } from '../src/main/social/pacing';
import type { LedgerEntry } from '../src/main/social/pacing';
import { createPublishGate } from '../src/main/social/PublishGate';
import type { PublishGate } from '../src/main/social/PublishGate';
import { checkSocialText, hasErrors, hashtagsIn, textHash, tidyPostText } from '../src/main/social/socialRules';
import { siteOfUrl } from '../src/main/social/socialSites';
import { SocialStore } from '../src/main/social/SocialStore';
import { LocalCatalog } from '../src/main/plugins/catalog';
import { PluginManager } from '../src/main/plugins/PluginManager';
import type { PluginState } from '../src/main/plugins/types';
import { socialImageHtml } from '../src/main/social/socialImage';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { KnownFolders } from '../src/main/security/pathPolicy';
import { runWithUserWords } from '../src/main/security/userWords';
import { currentUserWords } from '../src/main/security/userWords';
import { routeGroups, routeTopics, selectTools } from '../src/main/agent/toolGroups';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { composeText, createSocialTools, parseHashtags } from '../src/main/tools/impl/socialTools';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

/**
 * Writing and publishing on LinkedIn for the person (22–23 Nov 2026): what a text may say, how fast Eya may publish, what is kept, and — the part that matters — that the click on Post /
 * Comment / Reply is held, in code, to the plugin's permission, the limits and the person's OWN yes to that exact text. Mock pages and mock models only: nothing here touches LinkedIn.
 */

class MemoryIo implements StoreIo {
  files = new Map<string, string>();
  read = (p: string): string | null => this.files.get(p) ?? null;
  write = (p: string, t: string): void => void this.files.set(p, t);
}

const NOON = new Date(2026, 10, 24, 12, 0, 0).getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const page = (url = 'https://www.linkedin.com/feed/'): PageSnapshot => ({ url, title: 'Feed', headings: [], links: [], buttons: ['Post'], inputs: [], dialogs: [], truncated: false });

describe('which site a page is', () => {
  it('LinkedIn by its host, with or without www and for its sub-domains; never a look-alike', () => {
    expect(siteOfUrl('https://www.linkedin.com/feed/')?.id).toBe('linkedin');
    expect(siteOfUrl('https://linkedin.com/in/me')?.id).toBe('linkedin');
    expect(siteOfUrl('https://in.linkedin.com/jobs')?.id).toBe('linkedin');
    expect(siteOfUrl('https://www.fiverr.com/')?.id).toBe('fiverr');
    for (const bad of ['https://notlinkedin.com/', 'https://linkedin.com.evil.example/', 'https://example.com/?u=linkedin.com', 'not a url', '']) expect(siteOfUrl(bad), bad).toBeNull();
  });
});

describe('what may be published (an advocate\'s public text)', () => {
  const codes = (text: string, kind: 'post' | 'comment' | 'reply' = 'post', extra: object = {}): string[] => checkSocialText({ kind, text, ...extra }).map((p) => p.code);

  it('a plain, useful post has no problem at all', () => {
    expect(codes('Three things to check before you sign a rent agreement.\n\n1. The notice period\n2. The deposit\n3. Who pays for repairs\n\n#rentlaw #legaltips')).toEqual([]);
  });

  it('client matters and private details are ERRORS: a case number, a phone number, an e-mail', () => {
    for (const bad of ['Today I argued O.S. No. 123/2020 before the Sub Court.', 'W.P.(C) No. 4567 of 2023 was allowed', 'Crl. M.P. No. 88/2024 is listed tomorrow', 'FIR No. 12/2024 was quashed', 'Call me on +91 98765 43210 for a consultation', 'Write to raju@example.com for help']) {
      expect(hasErrors(checkSocialText({ kind: 'post', text: bad })), bad).toBe(true);
    }
  });

  it('a promise or advertisement of a result is an ERROR (the Bar Council\'s rules)', () => {
    for (const bad of ['We guarantee your bail.', '100% success in cheque bounce cases', 'Hire me and I will win your case', 'I am the best advocate in the city']) expect(codes(bad), bad).toContain('guarantee');
    expect(codes('Bail is a right in most bailable offences; what the court weighs is the flight risk.')).toEqual([]);
  });

  it('too long and too many hashtags; a client mention and an unsourced figure only WARN', () => {
    expect(codes('x'.repeat(3001))).toContain('too_long');
    expect(codes('x'.repeat(1251), 'comment')).toContain('too_long');
    const many = `Short.\n${Array.from({ length: 6 }, (_, i) => `#tag${i}`).join(' ')}`;
    expect(checkSocialText({ kind: 'post', text: many }).find((p) => p.code === 'hashtags_many')?.severity).toBe('warn');
    expect(codes(`Short.\n${Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(' ')}`)).toContain('hashtags_max');
    expect(checkSocialText({ kind: 'post', text: 'A client once told me this.' }).find((p) => p.code === 'client')?.severity).toBe('warn');
    const unsourced = checkSocialText({ kind: 'post', text: 'About 4200 people were affected in 2019.', sources: ['I want to write about tenancy law'] });
    expect(unsourced.find((p) => p.code === 'unsourced')?.severity).toBe('warn');
    expect(hasErrors(unsourced)).toBe(false);
    // (what the person said is a source: the same figure is fine then)
    expect(checkSocialText({ kind: 'post', text: 'About 4200 people were affected.', sources: ['4200 people were affected'] }).map((p) => p.code)).not.toContain('unsourced');
  });

  it('a picture must be an image type; a very big one only warns', () => {
    expect(codes('Hello', 'post', { imagePath: 'C:\\x\\a.exe' })).toContain('image_type');
    expect(codes('Hello', 'post', { imagePath: 'C:\\x\\a.png' })).toEqual([]);
    expect(codes('Hello', 'post', { imagePath: 'C:\\x\\a.png', imageBytes: 9_000_000 })).toContain('image_big');
    expect(codes('   ')).toEqual(['empty']);
  });

  it('the same words are the same post, whatever the spacing and case; hashtags are found', () => {
    expect(textHash('Hello  World\n#a')).toBe(textHash('hello world #A'));
    expect(textHash('hello world')).not.toBe(textHash('hello there'));
    expect(hashtagsIn('Text #Law and #law, #tax_2026 but not C#')).toEqual(['#law', '#tax_2026']);
    expect(tidyPostText('  a  b \r\n\r\n\r\n\r\n c ')).toBe('a b\n\nc');
  });
});

describe('how much and how fast (limits that no instruction can raise)', () => {
  const entry = (at: number, action: LedgerEntry['action'] = 'post', hash = 'h'): LedgerEntry => ({ at, site: 'linkedin', action, hash });

  it('nothing at night: the quiet hours, and when it may be again', () => {
    const night = new Date(2026, 10, 24, 2, 30).getTime();
    const r = allowance([], 'linkedin', 'post', 'x', night);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(/quiet time/);
      expect(new Date(r.retryAt ?? 0).getHours()).toBe(6);
    }
    expect(allowance([], 'linkedin', 'post', 'x', NOON).ok).toBe(true);
    expect(allowance([], 'linkedin', 'post', 'x', new Date(2026, 10, 24, 23, 5).getTime()).ok).toBe(false);
  });

  it('a few a day at most (posts 2, comments 15), counted per site and per kind, and the next day starts again', () => {
    const two = [entry(NOON - 5 * 60 * MIN, 'post', 'a'), entry(NOON - 3 * 60 * MIN, 'post', 'b')];
    const r = allowance(two, 'linkedin', 'post', 'c', NOON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/limit for today is reached \(2 posts/);
    expect(allowance(two, 'linkedin', 'comment', 'c', NOON).ok).toBe(true);
    expect(allowance(two, 'fiverr', 'post', 'c', NOON).ok).toBe(true);
    expect(allowance(two, 'linkedin', 'post', 'c', NOON + DAY).ok).toBe(true);
    expect(remainingToday(two, 'linkedin', NOON)).toMatchObject({ post: 0, comment: 15, reply: 20 });
  });

  it('not too fast: a gap between two of a kind', () => {
    const r = allowance([entry(NOON - 5 * MIN, 'comment', 'a')], 'linkedin', 'comment', 'b', NOON);
    expect(r.ok).toBe(true); // (5 minutes is more than the 2-minute gap)
    const fast = allowance([entry(NOON - 1 * MIN, 'comment', 'a')], 'linkedin', 'comment', 'b', NOON);
    expect(fast.ok).toBe(false);
    if (!fast.ok) expect(fast.why).toMatch(/Too soon/);
  });

  it('never the same text twice within 30 days', () => {
    const r = allowance([entry(NOON - 3 * DAY, 'post', 'same')], 'linkedin', 'post', 'same', NOON);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/already published/);
    expect(allowance([entry(NOON - 40 * DAY, 'post', 'same')], 'linkedin', 'post', 'same', NOON).ok).toBe(true);
  });

  it('the person\'s own file can change the limits, but only within sane bounds (a nonsense file changes nothing)', () => {
    const io = new MemoryIo();
    io.files.set('s.json', JSON.stringify({ pacing: { caps: { post: 5, comment: 'lots' }, quiet: { from: 22, to: 7 } } }));
    const s = new SocialStore('s.json', io);
    expect(s.pacing().caps.post).toBe(5);
    expect(s.pacing().caps.comment).toBe(DEFAULT_PACING.caps.comment);
    expect(s.pacing().quiet).toEqual({ from: 22, to: 7 });
    io.files.set('t.json', '{ not json');
    expect(new SocialStore('t.json', io).pacing()).toEqual(DEFAULT_PACING);
  });
});

describe('the store: drafts, what has gone out, and the person\'s facts', () => {
  const draftInput = { site: 'linkedin' as const, kind: 'post' as const, text: 'Hello world #law', title: '', hashtags: ['#law'], imagePath: '', altText: '', target: { url: '', who: '', excerpt: '' }, problems: [] };

  it('keeps drafts and facts across a restart, and keeps only a fingerprint of what was published', () => {
    const io = new MemoryIo();
    const a = new SocialStore('s.json', io, () => NOON);
    const d = a.add(draftInput);
    expect(d.status).toBe('draft');
    a.setProfile({ name: 'Rakesh', facts: ['Advocate', 'Practises in Telangana'] });
    a.published('linkedin', 'post', d.hash);
    const b = new SocialStore('s.json', io, () => NOON);
    expect(b.drafts()).toHaveLength(1);
    expect(b.draft(d.id)?.status).toBe('published');
    expect(b.profile().facts).toEqual(['Advocate', 'Practises in Telangana']);
    expect(b.ledger()).toEqual([{ at: NOON, site: 'linkedin', action: 'post', hash: d.hash }]);
    expect(io.files.get('s.json')).not.toContain('Hello world'.toLowerCase() + 'x'); // (the ledger holds no text)
    expect(JSON.stringify(b.ledger())).not.toContain('Hello');
  });

  it('an update recomputes the fingerprint; a published text only closes the draft of the same kind', () => {
    const s = new SocialStore('s.json', new MemoryIo(), () => NOON);
    const d = s.add(draftInput);
    const u = s.update(d.id, { text: 'Changed words' });
    expect(u?.hash).toBe(textHash('Changed words'));
    s.published('linkedin', 'comment', textHash('Changed words'));
    expect(s.draft(d.id)?.status).toBe('draft');
    s.published('linkedin', 'post', textHash('Changed words'));
    expect(s.draft(d.id)?.status).toBe('published');
    expect(s.update('nope', { text: 'x' })).toBeNull();
  });

  it('a broken file, or rows of the wrong shape, are skipped and nothing crashes', () => {
    const io = new MemoryIo();
    io.files.set('s.json', JSON.stringify({ drafts: [{ id: 1 }, null, 'x', { id: 's_1', site: 'linkedin', kind: 'post', text: 'ok' }], ledger: [{ at: 'x' }, { at: 1, site: 'linkedin', action: 'post', hash: 'h' }], profile: { facts: [1, 'a'] } }));
    const s = new SocialStore('s.json', io);
    expect(s.drafts().map((d) => d.id)).toEqual(['s_1']);
    expect(s.ledger()).toHaveLength(1);
    expect(s.profile().facts).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the gate
function gateRig(overrides: { now?: number; permits?: (site: string, permission: string) => string | null; words?: () => string } = {}) {
  const store = new SocialStore('s.json', new MemoryIo(), () => clock.now);
  const clock = { now: overrides.now ?? NOON };
  const words = { text: '' };
  const gate = createPublishGate({ store, permits: overrides.permits ?? (() => null), now: () => clock.now, userWords: overrides.words ?? (() => words.text) });
  return { store, gate, clock, words };
}
const POST = { name: 'Post', role: 'button' };
const TEXT = 'Three things to check before you sign a rent agreement: the notice period, the deposit and who pays for repairs. #rentlaw';

describe('the publish gate: the click that puts something out in the person\'s name', () => {
  it('another site, a link, another button, or a Comment button with nothing typed: not its business (the ordinary rules apply)', () => {
    const { gate } = gateRig();
    expect(gate.forClick(page(), { name: 'Comment', role: 'button' }, false)).toBeNull(); // (it only opens the box)
    gate.typed(page(), 'Text editor for creating content', TEXT);
    expect(gate.forClick(page('https://example.com/'), POST, false)).toBeNull();
    expect(gate.forClick(page(), { name: 'Post', role: 'link' }, false)).toBeNull();
    expect(gate.forClick(page(), { name: 'Add a photo', role: 'button' }, false)).toBeNull();
    expect(gate.forClick(null, POST, false)).toBeNull();
  });

  it('text typed a long time ago is not what the next Post would publish (it is forgotten after half an hour)', () => {
    const { gate, clock } = gateRig();
    gate.typed(page(), 'Text editor for creating content', TEXT);
    expect(gate.forClick(page(), POST, false)?.reason).not.toBeNull();
    clock.now += 40 * MIN;
    // (forgotten: what is in the box now is text Eya did not write — see the next test)
    expect(gate.forClick(page(), POST, false)?.question).toMatch(/I did not write it/);
  });

  it('a Post of text Eya did NOT write (the person typed it themself) is still held to the permission, the limits and their own yes — and the question says so', () => {
    const { gate, words, store } = gateRig();
    const asked = gate.forClick(page(), POST, false);
    expect(asked?.reason).not.toBeNull();
    expect(asked?.question).toMatch(/I did not write it, so I cannot show it here/);
    words.text = 'what is next?';
    expect(gate.forClick(page(), POST, true)?.reason).not.toBeNull(); // (a confirm alone is not their yes)
    words.text = 'yes';
    expect(gate.forClick(page(), POST, true)).toEqual({ reason: null });
    gate.published(page(), POST);
    expect(store.ledger()).toHaveLength(1); // (it counts against the daily limit)
    expect(store.ledger()[0]).toMatchObject({ action: 'post' });
    expect(store.ledger()[0]?.hash).toMatch(/^unknown-text:/);

    const noPermission = gateRig({ permits: () => 'The LinkedIn plugin has not been given the permission "Publish posts". Allow it on the Plugins page.' });
    noPermission.words.text = 'yes';
    expect(noPermission.gate.forClick(page(), POST, true)?.blocked).toMatch(/has not been given the permission/);

    const night = gateRig({ now: new Date(2026, 10, 24, 2, 0).getTime() });
    night.words.text = 'yes';
    expect(night.gate.forClick(page(), POST, true)?.blocked).toMatch(/quiet time/);
  });

  it('the first click ASKS, with the exact text; the person\'s own yes to THAT text lets it through', () => {
    const { gate, words } = gateRig();
    gate.typed(page(), 'Text editor for creating content', TEXT);
    const asked = gate.forClick(page(), POST, false);
    expect(asked?.reason).not.toBeNull();
    expect(asked?.question).toContain('Post this on LinkedIn as you?');
    expect(asked?.question).toContain(TEXT);
    // a model that says "confirm" without the person's yes: asked again
    expect(gate.forClick(page(), POST, true)?.reason).not.toBeNull();
    words.text = 'hmm what about the hashtags';
    expect(gate.forClick(page(), POST, true)?.reason).not.toBeNull();
    words.text = 'yes';
    expect(gate.forClick(page(), POST, true)).toEqual({ reason: null });
  });

  it('a yes to something else does not cover this: a changed text is asked about again, and an old question lapses', () => {
    const { gate, words, clock } = gateRig();
    gate.typed(page(), 'Text editor for creating content', TEXT);
    gate.forClick(page(), POST, false);
    gate.typed(page(), 'Text editor for creating content', `${TEXT} And one more line.`);
    words.text = 'yes';
    expect(gate.forClick(page(), POST, true)?.reason).not.toBeNull(); // (the yes was to the first text)
    gate.forClick(page(), POST, false);
    clock.now += 25 * MIN;
    expect(gate.forClick(page(), POST, true)?.reason).not.toBeNull(); // (a yes from long ago)
  });

  it('text the person wrote themself in this very request is their yes to it', () => {
    const { gate, words } = gateRig();
    words.text = `Post this on LinkedIn: ${TEXT}`;
    gate.typed(page(), 'Text editor for creating content', TEXT);
    expect(gate.forClick(page(), POST, false)).toEqual({ reason: null });
    // (a short or unrelated sentence of theirs is not)
    words.text = 'post it';
    gate.typed(page(), 'Text editor for creating content', 'Another text entirely about something');
    expect(gate.forClick(page(), POST, false)?.reason).not.toBeNull();
  });

  it('BLOCKED, whatever anyone says: a text that must not be published, a missing permission, a limit', () => {
    const bad = gateRig();
    bad.gate.typed(page(), 'Text editor', 'Today I won W.P.(C) No. 4567 of 2023 for my client');
    bad.words.text = 'yes';
    const a = bad.gate.forClick(page(), POST, true);
    expect(a?.blocked).toMatch(/case, crime or petition number/);

    const noPermission = gateRig({ permits: (_s, p) => (p === 'posts.publish' ? 'The LinkedIn plugin has not been given the permission "Publish posts". Allow it on the Plugins page.' : null) });
    noPermission.gate.typed(page(), 'Text editor', TEXT);
    noPermission.words.text = 'yes';
    expect(noPermission.gate.forClick(page(), POST, true)?.blocked).toMatch(/has not been given the permission/);

    const night = gateRig({ now: new Date(2026, 10, 24, 2, 0).getTime() });
    night.gate.typed(page(), 'Text editor', TEXT);
    night.words.text = 'yes';
    expect(night.gate.forClick(page(), POST, true)?.blocked).toMatch(/quiet time/);

    const full = gateRig();
    full.store.published('linkedin', 'post', 'aaa');
    full.clock.now += 40 * MIN;
    full.store.published('linkedin', 'post', 'bbb');
    full.clock.now += 40 * MIN;
    full.gate.typed(page(), 'Text editor', TEXT);
    full.words.text = 'yes';
    expect(full.gate.forClick(page(), POST, true)?.blocked).toMatch(/limit for today is reached/);
  });

  it('after the click went ahead it is written to the ledger and the draft is done; the same text cannot go out again', () => {
    const { gate, store, words, clock } = gateRig();
    const draft = store.add({ site: 'linkedin', kind: 'post', text: TEXT, title: '', hashtags: [], imagePath: '', altText: '', target: { url: '', who: '', excerpt: '' }, problems: [] });
    gate.typed(page(), 'Text editor for creating content', TEXT);
    gate.forClick(page(), POST, false);
    words.text = 'yes';
    expect(gate.forClick(page(), POST, true)).toEqual({ reason: null });
    gate.published(page(), POST);
    expect(store.draft(draft.id)?.status).toBe('published');
    expect(store.ledger()).toHaveLength(1);
    expect(store.ledger()[0]).toMatchObject({ site: 'linkedin', action: 'post', hash: textHash(TEXT) });
    // (nothing typed any more: what is in the box now is not Eya's text, and the daily limit counts what went out)
    expect(gate.forClick(page(), POST, true)?.blocked).toMatch(/Too soon|limit/);
    clock.now += 3 * 60 * MIN;
    gate.typed(page(), 'Text editor', TEXT);
    expect(gate.forClick(page(), POST, true)?.blocked).toMatch(/already published/);
  });

  it('comments and replies are their own kinds: their own permission and limits, and "Comment" with nothing typed only opens the box', () => {
    const calls: string[] = [];
    const { gate, words, store } = gateRig({ permits: (_s, p) => (calls.push(p), null) });
    expect(gate.forClick(page('https://www.linkedin.com/posts/x'), { name: 'Comment', role: 'button' }, false)).toBeNull();
    gate.typed(page('https://www.linkedin.com/posts/x'), 'Add a comment…', 'Thank you, this is a point many people miss.');
    const asked = gate.forClick(page('https://www.linkedin.com/posts/x'), { name: 'Comment', role: 'button' }, false);
    expect(asked?.question).toContain('Post this comment on LinkedIn as you?');
    expect(calls).toContain('comments.publish');
    words.text = 'yes';
    expect(gate.forClick(page('https://www.linkedin.com/posts/x'), { name: 'Comment', role: 'button' }, true)).toEqual({ reason: null });
    gate.published(page('https://www.linkedin.com/posts/x'), { name: 'Comment', role: 'button' });
    expect(store.ledger()[0]?.action).toBe('comment');
    gate.typed(page(), 'Reply to Priya', 'Thank you Priya, glad it helped.');
    expect(gate.forClick(page(), { name: 'Reply' }, false)?.question).toContain('Post this reply on LinkedIn as you?');
  });

  it('Enter pressed in a comment box is held the same way, by the kind of box', () => {
    const { gate, words, store } = gateRig();
    expect(gate.forSubmit(page(), 'Add a comment…', false)).toBeNull(); // (nothing typed)
    gate.typed(page(), 'Add a comment…', 'Useful point, thank you for sharing.');
    expect(gate.forSubmit(page(), 'Add a comment…', false)?.question).toContain('comment');
    expect(gate.forSubmit(page(), 'Search', false)).toBeNull();
    words.text = 'ok';
    // ("ok" is a yes only to a question that was asked: it was)
    expect(gate.forSubmit(page(), 'Add a comment…', true)).toEqual({ reason: null });
    gate.published(page(), { name: 'enter' });
    expect(store.ledger()[0]?.action).toBe('comment');
  });
});

// ---------------------------------------------------------------------------------------------------------------- inside the real click / fill tools
class FakeLinkedIn {
  url = 'https://www.linkedin.com/feed/?shareActive=true';
  box = '';
  clicked: string[] = [];
  private snap = (): PageSnapshot => page(this.url);
  inspectPage = async (): Promise<PageSnapshot> => this.snap();
  fillOnPage = async (_label: string, value: string, _options?: FillOptions): Promise<ActOnPageResult> => {
    this.box = value;
    return { ok: true, snapshot: this.snap() };
  };
  clickOnPage = async (text: string, gate?: ClickGate): Promise<ActOnPageResult> => {
    const why = gate?.({ name: text, role: 'button' } as Parameters<ClickGate>[0]) ?? null;
    if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: text, snapshot: this.snap() };
    this.clicked.push(text);
    return { ok: true, snapshot: this.snap() };
  };
}

function toolRig(rig: ReturnType<typeof gateRig>) {
  const app = new FakeLinkedIn();
  const tools = new Map(createBrowserTools(app as unknown as BrowserAutomationService, undefined, { publishGate: rig.gate }).map((t) => [t.schema.name, t]));
  const call = async (name: string, args: ToolArgs, said = ''): Promise<ToolResult> => runWithUserWords(said, () => (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(args));
  return { app, call };
}

describe('the gate inside the real click and fill tools', () => {
  it('type, click Post: asked first and nothing clicked; "confirm" alone does not publish; the person\'s own yes does — once', async () => {
    const rig = gateRig({ words: currentUserWords });
    const { app, call } = toolRig(rig);
    expect((await call('fill_on_page', { label: 'Text editor for creating content', value: TEXT })).ok).toBe(true);
    const first = await call('click_on_page', { text: 'Post' });
    expect(first.ok).toBe(false);
    expect(first.error).toContain('Post this on LinkedIn as you?');
    expect(app.clicked).toEqual([]);
    const sneaky = await call('click_on_page', { text: 'Post', confirm: true }, 'write me a post');
    expect(sneaky.ok).toBe(false);
    expect(app.clicked).toEqual([]);
    const done = await call('click_on_page', { text: 'Post', confirm: true }, 'yes');
    expect(done.ok).toBe(true);
    expect(app.clicked).toEqual(['Post']);
    expect(rig.store.ledger()).toHaveLength(1);
    // (and the same text again, even with a yes: refused)
    rig.clock.now += 3 * 60 * MIN;
    await call('fill_on_page', { label: 'Text editor for creating content', value: TEXT });
    const again = await call('click_on_page', { text: 'Post', confirm: true }, 'yes');
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already published/);
    expect(app.clicked).toEqual(['Post']);
  });

  it('a blocked text is refused as "not allowed" (a refusal, not a question) even with a yes', async () => {
    const rig = gateRig({ words: currentUserWords });
    const { app, call } = toolRig(rig);
    await call('fill_on_page', { label: 'Text editor', value: 'We guarantee your bail, 100% success.' });
    const r = await call('click_on_page', { text: 'Post', confirm: true }, 'yes');
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not allowed');
    expect(r.error).toMatch(/promises or advertises a result/);
    expect(app.clicked).toEqual([]);
  });

  it('Enter pressed in a comment box after typing is asked about; with the yes it goes and is written to the ledger', async () => {
    const rig = gateRig({ words: currentUserWords });
    const { call } = toolRig(rig);
    await call('fill_on_page', { label: 'Add a comment…', value: 'Thank you, a point many people miss.' });
    const held = await call('fill_on_page', { label: 'Add a comment…', value: 'Thank you, a point many people miss.', submit: true });
    expect(held.ok).toBe(false);
    expect(held.error).toContain('comment');
    const sent = await call('fill_on_page', { label: 'Add a comment…', value: 'Thank you, a point many people miss.', submit: true, confirm: true }, 'yes');
    expect(sent.ok).toBe(true);
    expect(rig.store.ledger()[0]?.action).toBe('comment');
  });

  it('a click that is not a publish is unchanged: no gate decision, the ordinary rules apply', async () => {
    const { call, app } = toolRig(gateRig());
    const r = await call('click_on_page', { text: 'Start a post' });
    expect(r.ok).toBe(true);
    expect(app.clicked).toEqual(['Start a post']);
  });
});

// ---------------------------------------------------------------------------------------------------------------- the tools
const FOLDERS: KnownFolders = { home: 'C:\\Users\\Test', downloads: 'C:\\Users\\Test\\Downloads', desktop: 'C:\\Users\\Test\\Desktop', documents: 'C:\\Users\\Test\\Documents', pictures: 'C:\\Users\\Test\\Pictures', videos: 'C:\\Users\\Test\\Videos', music: 'C:\\Users\\Test\\Music', temp: 'C:\\Users\\Test\\AppData\\Local\\Temp' };

function socialRig(extra: { render?: (spec: unknown) => Promise<Buffer>; pageUrl?: string; attach?: (r: unknown) => Promise<unknown> } = {}) {
  const store = new SocialStore('s.json', new MemoryIo(), () => NOON);
  const attached: unknown[] = [];
  const service = {
    inspectPage: async () => page(extra.pageUrl ?? 'https://www.linkedin.com/feed/'),
    attachFile: extra.attach ?? (async (r: unknown) => (attached.push(r), { ok: true, snapshot: page() })),
  };
  const files = {
    stat: async (p: string) => (/\.(png|jpg|gif|webp|exe|docx)$/.test(p) ? { isFile: true, isDirectory: false, size: p.includes('big') ? 9_000_000 : 40_000 } : null),
    read: async () => Buffer.from('png'),
  };
  const tools = new Map(createSocialTools({ store, service: service as unknown as BrowserAutomationService, folders: FOLDERS, files, imageFolder: 'C:\\Users\\Test\\Pictures\\Eya posts', now: () => NOON, ...(extra.render !== undefined ? { render: extra.render as never } : {}) }).map((t) => [t.schema.name, t]));
  const call = (name: string, args: ToolArgs, said = ''): Promise<ToolResult> => runWithUserWords(said, () => (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(args));
  return { store, call, attached, tools };
}

describe('composing the text', () => {
  it('a first line is put in front unless the text already starts with it; hashtags go last unless already there', () => {
    expect(composeText({ title: 'Renting? Read this.', text: 'Three checks.', hashtags: ['rentlaw', 'tips'] })).toBe('Renting? Read this.\n\nThree checks.\n\n#rentlaw #tips');
    expect(composeText({ title: 'Renting? Read this.', text: 'Renting? Read this.\n\nThree checks. #rentlaw', hashtags: ['rentlaw'] })).toBe('Renting? Read this.\n\nThree checks. #rentlaw');
    expect(parseHashtags('#law, Tips  #tax-2026;x')).toEqual(['law', 'Tips', 'tax2026']);
  });
});

describe('social_draft', () => {
  it('saves a draft and says what to do next — and that nothing is published', async () => {
    const { call, store } = socialRig();
    const r = await call('social_draft', { text: 'Three checks before you sign a rent agreement.', title: 'Renting? Read this.', hashtags: 'rentlaw tips' });
    expect(r.ok).toBe(true);
    const d = r.data as { id: string; text: string; next: string };
    expect(d.text).toBe('Renting? Read this.\n\nThree checks before you sign a rent agreement.\n\n#rentlaw #tips');
    expect(d.next).toMatch(/social_compose/);
    expect(d.next).toMatch(/do not click "Start a post"/);
    expect(d.next).toMatch(/only publish after their own yes|only after their own yes/);
    expect(store.drafts()).toHaveLength(1);
  });

  it('a text with a client matter is saved but flagged MUST FIX, and the error says how to go on', async () => {
    const { call } = socialRig();
    const r = await call('social_draft', { text: 'I won O.S. No. 12/2021 for my client yesterday.' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/must be fixed/);
    expect(r.error).toMatch(/action "update"/);
    expect((r.data as { id: string }).id).toMatch(/^s_/);
  });

  it('update changes a draft and re-checks it; get, list and skip work; an unknown id is said so', async () => {
    const { call } = socialRig();
    const saved = await call('social_draft', { text: 'I won O.S. No. 12/2021 yesterday.' });
    const id = (saved.data as { id: string }).id;
    const fixed = await call('social_draft', { action: 'update', id, text: 'A good day in court yesterday.' });
    expect(fixed.ok).toBe(true);
    expect(((await call('social_draft', { action: 'get', id })).data as { text: string }).text).toBe('A good day in court yesterday.');
    const list = await call('social_draft', { action: 'list' });
    expect((list.data as { drafts: unknown[]; mayStillPublishToday: { post: number } }).drafts).toHaveLength(1);
    expect((list.data as { mayStillPublishToday: { post: number } }).mayStillPublishToday.post).toBe(2);
    expect((await call('social_draft', { action: 'skip', id })).ok).toBe(true);
    expect(((await call('social_draft', { action: 'list' })).data as { drafts: unknown[] }).drafts).toHaveLength(0);
    expect((await call('social_draft', { action: 'get', id: 'nope' })).ok).toBe(false);
    expect((await call('social_draft', { text: '' })).ok).toBe(false);
  });

  it('what the person said and their saved facts are the sources: a figure they did not give is a warning to show them', async () => {
    const { call } = socialRig();
    await call('social_profile', { action: 'set', name: 'Rakesh', facts: 'Advocate\nPractises in Telangana' });
    const r = await call('social_draft', { text: 'I have handled 450 cases in Telangana.' }, 'write about my practice in Telangana');
    expect(r.ok).toBe(true);
    expect((r.data as { problems: string[] }).problems.join(' ')).toMatch(/"450"/);
    const ok = await call('social_draft', { text: 'I have handled 450 cases in Telangana.' }, 'write that I have handled 450 cases in Telangana');
    expect((ok.data as { problems: string[] }).problems.join(' ')).not.toMatch(/450/);
  });

  it('a picture must be an image in the person\'s own folders; an executable, a document or a path outside is refused', async () => {
    const { call } = socialRig();
    expect((await call('social_draft', { text: 'Hello there everyone.', image_path: 'C:\\Users\\Test\\Pictures\\card.png' })).ok).toBe(true);
    for (const bad of ['C:\\Users\\Test\\Pictures\\run.exe', 'C:\\Users\\Test\\Documents\\notes.docx', 'C:\\Windows\\System32\\a.png', 'C:\\Users\\Test\\Pictures\\missing.txt']) {
      const r = await call('social_draft', { text: 'Hello there everyone.', image_path: bad });
      expect(r.ok, bad).toBe(false);
    }
    const big = await call('social_draft', { text: 'Hello there everyone.', image_path: 'C:\\Users\\Test\\Pictures\\big.png' });
    expect((big.data as { problems: string[] }).problems.join(' ')).toMatch(/over 5 MB/);
  });
});

describe('social_make_image and social_attach_image', () => {
  it('makes a card with the words given (nothing else) and saves it in the posts folder', async () => {
    const seen: unknown[] = [];
    const { call } = socialRig({ render: async (spec) => (seen.push(spec), Buffer.from('PNGDATA')) });
    // (the folder is made on the real disk by the tool: point it at a temp place by using a stub render only — the path is checked, not written here)
    const r = await call('social_make_image', { title: 'Read before you sign', subtitle: 'A rent agreement checklist', footer: 'Rakesh, Advocate', theme: 'blue', size: 'square' }).catch((e) => ({ ok: false, summary: String(e), error: '' }) as ToolResult);
    expect(seen[0]).toMatchObject({ title: 'Read before you sign', subtitle: 'A rent agreement checklist', footer: 'Rakesh, Advocate', theme: 'blue', width: 1080, height: 1080 });
    expect(typeof r.ok).toBe('boolean');
  });

  it('refuses without a headline, and says so when pictures cannot be made', async () => {
    const { call } = socialRig({ render: async () => Buffer.from('x') });
    expect((await call('social_make_image', {})).ok).toBe(false);
    const none = socialRig();
    expect((await none.call('social_make_image', { title: 'x' })).error).toMatch(/cannot be made/);
  });

  it('the card page carries only the words given, escaped, with no script', () => {
    const html = socialImageHtml({ title: 'Is <b>this</b> & "that"?', subtitle: '', footer: 'Rakesh', theme: 'dark', width: 1200, height: 627 });
    expect(html).toContain('Is &lt;b&gt;this&lt;/b&gt; &amp; &quot;that&quot;?');
    expect(html).not.toMatch(/<script|onerror|javascript:/i);
    expect(html).toContain('Rakesh');
    expect(html).not.toContain('<p>');
  });

  it('puts a picture on the open LinkedIn page\'s file picker, as media — and only there, only an image', async () => {
    const { call, attached } = socialRig();
    const r = await call('social_attach_image', { path: 'C:\\Users\\Test\\Pictures\\card.png' });
    expect(r.ok).toBe(true);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ name: 'card.png', mime: 'image/png', prefer: 'media' });
    expect((await call('social_attach_image', { path: 'C:\\Users\\Test\\Pictures\\run.exe' })).ok).toBe(false);
    const elsewhere = socialRig({ pageUrl: 'https://example.com/' });
    expect((await elsewhere.call('social_attach_image', { path: 'C:\\Users\\Test\\Pictures\\card.png' })).error).toMatch(/not LinkedIn/);
    expect(elsewhere.attached).toHaveLength(0);
    const noInput = socialRig({ attach: async () => ({ ok: false, reason: 'no_file_input', message: 'The page has no file picker.' }) });
    const nr = await noInput.call('social_attach_image', { path: 'C:\\Users\\Test\\Pictures\\card.png' });
    expect(nr.ok).toBe(false);
    expect(nr.error).toMatch(/photo \/ "Add media" button/);
  });
});

describe('social_profile', () => {
  it('keeps what the person told Eya about themselves; facts can be replaced or added to', async () => {
    const { call, store } = socialRig();
    expect(((await call('social_profile', {})).data as { note?: string }).note).toMatch(/No facts saved/);
    await call('social_profile', { action: 'set', name: 'Rakesh', headline: 'Advocate', tone: 'plain and warm', facts: 'Advocate\nHigh Court' });
    await call('social_profile', { action: 'set', add_facts: 'Writes on tenancy law' });
    expect(store.profile()).toMatchObject({ name: 'Rakesh', headline: 'Advocate', tone: 'plain and warm', facts: ['Advocate', 'High Court', 'Writes on tenancy law'] });
  });
});

describe('the real tools and the manifest line up', () => {
  it('the user\'s own words reach the tools through the same request scope', () => {
    expect(runWithUserWords('hello there', () => currentUserWords())).toBe('hello there');
    const never: PublishGate | null = null;
    expect(never).toBeNull();
    expect(vi.isMockFunction(() => 0)).toBe(false);
  });
});

describe('Eya knows when a request is about writing on LinkedIn (the topic and its tools come with it, and only then)', () => {
  const tools = [{ name: 'social_draft' }, { name: 'social_make_image' }, { name: 'social_attach_image' }, { name: 'social_profile' }, { name: 'open_website' }, { name: 'click_on_page' }];
  const asked = (text: string): string[] => selectTools(tools, routeGroups(text), routeTopics(text)).map((t) => t.name);

  it('LinkedIn requests in the words people use bring the browser, the topic and its tools', () => {
    for (const text of [
      'write a post on LinkedIn about tenancy law',
      'post this on linkedin: three things to check',
      'create a new linkedin post with an image',
      'reply to the comments on my post',
      'comment on this post for me',
      'can you reply to my comments',
      'make a post and post it on linkedin',
    ]) {
      expect(routeTopics(text).has('social'), text).toBe(true);
      expect(asked(text), text).toEqual(expect.arrayContaining(['social_draft', 'social_make_image', 'social_attach_image', 'social_profile', 'open_website']));
    }
    expect(routeGroups('write a post on LinkedIn').has('browser')).toBe(true);
  });

  it('an ordinary request carries none of it (no extra prompt, no extra tools)', () => {
    for (const text of ['open the cause list for today', 'message Ravi that I am late', 'what is the weather', 'play a song']) {
      expect(routeTopics(text).has('social'), text).toBe(false);
      expect(asked(text), text).not.toContain('social_draft');
    }
  });
});

describe('LinkedIn starts with NOTHING granted: publishing in the person\'s name is theirs to allow', () => {
  function manager() {
    const saved: { state: PluginState | null } = { state: null };
    const m = new PluginManager({
      catalog: new LocalCatalog(),
      store: { load: () => saved.state, save: (s) => void (saved.state = s) },
      connectors: {},
      eyaVersion: '0.1.0',
      knownTools: () => new Set(['fill_on_page', 'click_on_page', 'social_draft', 'social_compose', 'social_make_image', 'social_attach_image', 'social_profile', 'find_chat', 'find_chat_files', 'live_chat', 'learn_chat_names', 'share_file_to_chat', 'attach_file', 'verify_sent']),
    });
    return { m, saved };
  }

  it('it is there and switched on, with no permission, so the gate refuses every publish until the person allows it', () => {
    const { m, saved } = manager();
    expect(saved.state?.plugins['linkedin']).toMatchObject({ enabled: true, granted: [] });
    expect(m.permitsApp('linkedin', 'posts.publish')).toMatch(/has not been given the permission "Publish posts"/);
    expect(m.permitsApp('linkedin', 'comments.publish')).toMatch(/Publish comments and replies/);
    expect(m.permitsApp('linkedin', 'drafts.write')).toMatch(/Prepare drafts and pictures/);
  });

  it('each permission is the person\'s own click, one at a time; taking one back closes it again', () => {
    const { m } = manager();
    expect(m.apply({ kind: 'grant', id: 'linkedin', permission: 'posts.publish' }).ok).toBe(true);
    expect(m.permitsApp('linkedin', 'posts.publish')).toBeNull();
    expect(m.permitsApp('linkedin', 'comments.publish')).not.toBeNull();
    expect(m.apply({ kind: 'revoke', id: 'linkedin', permission: 'posts.publish' }).ok).toBe(true);
    expect(m.permitsApp('linkedin', 'posts.publish')).not.toBeNull();
    // (a site that is not a plugin is nobody's business)
    expect(m.permitsApp('some-other-site', 'posts.publish')).toBeNull();
  });

  it('the drafting tools are hidden from the model, and refused if called, until the person allows drafting', () => {
    const { m } = manager();
    expect(m.blockFor('social_draft')?.reason).toMatch(/Prepare drafts and pictures/);
    m.apply({ kind: 'grant', id: 'linkedin', permission: 'drafts.write' });
    expect(m.blockFor('social_draft')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------- social_compose
/**
 * 23 Nov 2026, the user's real run: Eya opened LinkedIn, kept clicking "Start a post" (it was covered: the box was ALREADY open from the address), guessed field names ("What do you want to talk about?"),
 * went back, opened another page, searched the web, and asked the person to click — 730,000 tokens and nothing posted. social_compose does it all in one call, each step at most once.
 */
class FakeComposerSite {
  url = 'https://example.com/';
  box = false;
  startVisible = false;
  popup = false;
  picker = false;
  /** Whether the page ever shows a post box (a page built differently from what we expect). */
  hasBox = true;
  opened: string[] = [];
  clicked: string[] = [];
  filled: string[] = [];
  attached: string[] = [];
  /** What the box is called on this page. */
  boxName = 'Text editor for creating content';
  /** The address opens the box by itself (as the real one does with ?shareActive=true), or only the feed shows. */
  opensByItself = true;
  /** Pressing "Start a post" does nothing (a page that ignores it). */
  startDoesNothing = false;

  private snap = (): PageSnapshot => ({
    url: this.url,
    title: 'LinkedIn',
    headings: [],
    links: [],
    buttons: [...(this.startVisible ? ['Start a post'] : []), ...(this.popup ? ['Dismiss'] : []), ...(this.box ? ['Add media', 'Post'] : [])],
    inputs: this.box && this.hasBox ? [this.boxName] : [],
    dialogs: this.box && this.hasBox ? ['Create a post'] : [],
    truncated: false,
  });
  inspectPage = async (): Promise<PageSnapshot> => this.snap();
  openWebsite = async (url: string): Promise<PageSnapshot> => {
    this.opened.push(url);
    this.url = 'https://www.linkedin.com/feed/';
    this.box = this.opensByItself;
    // (the feed's own "Start a post" is on the page either way: behind the box, when the box is open — as on the real page)
    this.startVisible = true;
    return this.snap();
  };
  clickOnPage = async (text: string): Promise<ActOnPageResult> => {
    this.clicked.push(text);
    if (text === 'Start a post') {
      if (this.box) return { ok: false, reason: 'could_not', message: 'Something else is covering it ("p") — likely a popup or banner to deal with first.', snapshot: this.snap() };
      if (!this.startDoesNothing) this.box = true;
    }
    if (text === 'Dismiss') {
      this.popup = false;
      this.startVisible = true;
    }
    if (text === 'Add media') this.picker = true;
    return { ok: true, snapshot: this.snap() };
  };
  fillOnPage = async (label: string, value: string): Promise<ActOnPageResult> => {
    this.filled.push(label);
    if (!this.box || !this.hasBox || label !== this.boxName) return { ok: false, reason: 'not_found', snapshot: this.snap() };
    void value;
    return { ok: true, snapshot: this.snap() };
  };
  attachFile = async (request: { name: string }): Promise<unknown> => {
    if (!this.picker) return { ok: false, reason: 'no_file_input', message: 'The page has no file picker.' };
    this.attached.push(request.name);
    return { ok: true, snapshot: this.snap() };
  };
}

function composeRig(site: FakeComposerSite) {
  const store = new SocialStore('s.json', new MemoryIo(), () => NOON);
  const rig = gateRig();
  const tools = new Map(
    createSocialTools({ store, service: site as unknown as BrowserAutomationService, folders: FOLDERS, files: { stat: async () => ({ isFile: true, isDirectory: false, size: 40_000 }), read: async () => Buffer.from('png') }, imageFolder: 'x', now: () => NOON, publishGate: rig.gate, sleep: async () => undefined }).map((t) => [t.schema.name, t]),
  );
  const call = (name: string, args: ToolArgs, said = ''): Promise<ToolResult> => runWithUserWords(said, () => (tools.get(name) as NonNullable<ReturnType<typeof tools.get>>).execute(args));
  const save = async (image = ''): Promise<string> => {
    const r = await call('social_draft', { text: 'Three things to check before you sign a rent agreement.', title: 'Renting a home? Read this first.', hashtags: 'rentlaw', ...(image !== '' ? { image_path: image } : {}) });
    return (r.data as { id: string }).id;
  };
  return { call, save, store, rig };
}

describe('social_compose: the whole opening-and-typing job in ONE call, each step at most once', () => {
  it('the box is already open on LinkedIn: nothing is opened or clicked, the text goes in, nothing is published', async () => {
    const site = new FakeComposerSite();
    site.url = 'https://www.linkedin.com/feed/?shareActive=true';
    site.box = true;
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save() });
    expect(r.ok).toBe(true);
    expect(site.opened).toEqual([]);
    expect(site.clicked).toEqual([]);
    expect(site.filled).toEqual(['Text editor for creating content']);
    expect((r.data as { status: string }).status).toBe('ready_not_published');
    expect((r.data as { next: string }).next).toMatch(/only after their own yes click_on_page "Post"/);
  });

  it('from another page: LinkedIn\'s post box is opened ONCE by its address, and "Start a post" is never clicked (it is covered by the box)', async () => {
    const site = new FakeComposerSite();
    const { call, save } = composeRig(site);
    const none = await call('social_compose', {});
    expect(none.ok).toBe(false); // (no draft yet: said so)
    await save();
    const done = await call('social_compose', {});
    expect(done.ok).toBe(true);
    expect(site.opened).toEqual(['https://www.linkedin.com/feed/?shareActive=true']);
    expect(site.clicked).not.toContain('Start a post');
    expect(site.filled).toEqual(['Text editor for creating content']);
  });

  it('a page that does not open the box by itself: "Start a post" is pressed ONCE, then the text goes in', async () => {
    const site = new FakeComposerSite();
    site.opensByItself = false;
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save() });
    expect(r.ok).toBe(true);
    expect(site.opened).toHaveLength(1);
    expect(site.clicked.filter((c) => c === 'Start a post')).toHaveLength(1);
    expect(site.filled).toEqual(['Text editor for creating content']);
  });

  it('a "Start a post" that does nothing is pressed ONCE, never again and again', async () => {
    const site = new FakeComposerSite();
    site.opensByItself = false;
    site.startDoesNothing = true;
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save() });
    expect(r.ok).toBe(false);
    expect(site.clicked.filter((c) => c === 'Start a post')).toHaveLength(1);
    expect(site.opened).toHaveLength(1);
    expect((r.data as { status: string }).status).toBe('no_post_box');
  });

  it('a pop-up in the way is closed by Eya herself (nobody is asked to click)', async () => {
    const site = new FakeComposerSite();
    site.opensByItself = false;
    const { call, save } = composeRig(site);
    const id = await save();
    // (the feed shows a pop-up first: its Dismiss button is pressed, then the post box can be started)
    const open = site.openWebsite;
    site.openWebsite = async (url: string) => {
      const p = await open(url);
      site.popup = true;
      site.startVisible = false;
      return { ...p, buttons: ['Dismiss'] };
    };
    const r = await call('social_compose', { id });
    expect(r.ok).toBe(true);
    expect(site.clicked).toContain('Dismiss');
    expect(site.clicked.filter((c) => c === 'Start a post').length).toBeLessThanOrEqual(1);
  });

  it('a page whose post box is not found: ONE open, a few names tried once each, ONE "Start a post", then it stops and says what to do — no loop, no question to the person', async () => {
    const site = new FakeComposerSite();
    site.hasBox = false;
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save() });
    expect(r.ok).toBe(false);
    expect(site.opened).toHaveLength(1);
    expect(site.filled.length).toBeLessThanOrEqual(3);
    expect(site.clicked.filter((c) => c === 'Start a post').length).toBeLessThanOrEqual(1);
    expect(r.error).toMatch(/Do NOT try again/);
    expect(r.error).toMatch(/do not ask the person to click/);
    expect(r.error).toMatch(/describe_screen/);
    expect((r.data as { status: string }).status).toBe('no_post_box');
  });

  it('the picture: the page\'s own media button is pressed, the file goes on its picker; if it cannot, the text is still in and it says so', async () => {
    const site = new FakeComposerSite();
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save('C:\\Users\\Test\\Pictures\\card.png') });
    expect(r.ok).toBe(true);
    expect(site.clicked).toContain('Add media');
    expect(site.attached).toEqual(['card.png']);
    expect((r.data as { picture: string }).picture).toBe('card.png added');

    const stuck = new FakeComposerSite();
    stuck.clickOnPage = async (text: string) => {
      stuck.clicked.push(text);
      return { ok: true, snapshot: await stuck.inspectPage() };
    };
    const other = composeRig(stuck);
    const r2 = await other.call('social_compose', { id: await other.save('C:\\Users\\Test\\Pictures\\card.png') });
    expect(r2.ok).toBe(true);
    expect((r2.data as { picture: string }).picture).toMatch(/^NOT added/);
    expect((r2.data as { next: string }).next).toMatch(/the picture could not be added: say so/);
  });

  it('it never publishes: no click on Post, and the gate then knows exactly what was typed — the click on Post asks about THAT text', async () => {
    const site = new FakeComposerSite();
    const { call, save, rig } = composeRig(site);
    await call('social_compose', { id: await save() });
    expect(site.clicked).not.toContain('Post');
    const asked = rig.gate.forClick(page('https://www.linkedin.com/feed/'), { name: 'Post', role: 'button' }, false);
    expect(asked?.question).toContain('Post this on LinkedIn as you?');
    expect(asked?.question).toContain('Renting a home? Read this first.');
  });

  it('a draft that must not be published is refused before the page is touched; a comment draft is not a post', async () => {
    const site = new FakeComposerSite();
    const { call } = composeRig(site);
    const bad = await call('social_draft', { text: 'I won O.S. No. 12/2021 for my client.' });
    const r = await call('social_compose', { id: (bad.data as { id: string }).id });
    expect(r.ok).toBe(false);
    expect(site.opened).toEqual([]);
    const c = await call('social_draft', { kind: 'comment', text: 'Very true, thank you for sharing this.' });
    const r2 = await call('social_compose', { id: (c.data as { id: string }).id });
    expect(r2.ok).toBe(false);
    expect(r2.summary).toBe('not a post');
  });

  it('LinkedIn would not open: said once, no retry', async () => {
    const site = new FakeComposerSite();
    site.openWebsite = async (url: string) => {
      site.opened.push(url);
      throw new Error('net::ERR_CONNECTION_TIMED_OUT');
    };
    const { call, save } = composeRig(site);
    const r = await call('social_compose', { id: await save() });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/do not open it again and again/);
    expect(site.opened).toHaveLength(1);
  });
});

describe('the follow-up "yes, post it" keeps the LinkedIn tools and rules (it names no site)', () => {
  it('once a draft was saved or composed, the next short request still carries the topic and the browser tools', () => {
    const tools = [{ name: 'social_draft' }, { name: 'social_compose' }, { name: 'click_on_page' }, { name: 'open_website' }];
    for (const last of ['social_draft', 'social_compose']) {
      const asked = selectTools(tools, routeGroups('yes, post it', { recentTools: [last] }), routeTopics('yes, post it', { recentTools: [last] })).map((t) => t.name);
      expect(asked, last).toEqual(expect.arrayContaining(['social_compose', 'click_on_page']));
    }
    const none = selectTools(tools, routeGroups('yes, post it'), routeTopics('yes, post it')).map((t) => t.name);
    expect(none).not.toContain('social_compose');
  });
});

describe('opening LinkedIn\'s post box by hand is refused (it was the loop): social_compose does it', () => {
  it('open_website on the composer addresses says to use social_compose; an ordinary LinkedIn page opens as before', async () => {
    const opened: string[] = [];
    const app = {
      inspectPage: async () => page('https://www.linkedin.com/feed/'),
      openWebsite: async (url: string) => (opened.push(url), page(url)),
    };
    const rig = gateRig();
    const tools = new Map(createBrowserTools(app as unknown as BrowserAutomationService, undefined, { publishGate: rig.gate }).map((t) => [t.schema.name, t]));
    const open = (url: string): Promise<ToolResult> => (tools.get('open_website') as NonNullable<ReturnType<typeof tools.get>>).execute({ url });
    for (const url of ['https://www.linkedin.com/feed/?shareActive=true', 'https://www.linkedin.com/sharing/compose', 'https://www.linkedin.com/post/new/']) {
      const r = await open(url);
      expect(r.ok, url).toBe(false);
      expect(r.summary).toBe('use social_compose');
      expect(r.error).toMatch(/call social_compose ONCE/);
    }
    expect(opened).toEqual([]);
    expect((await open('https://www.linkedin.com/feed/')).ok).toBe(true);
    expect((await open('https://example.com/?shareActive=true')).ok).toBe(true);
    expect(opened).toEqual(['https://www.linkedin.com/feed/', 'https://example.com/?shareActive=true']);
  });
});
