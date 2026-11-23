import { describe, expect, it } from 'vitest';
import type { LiveChatMessage } from '../src/main/browser/BrowserAutomationService';
import { AUTO_DEFAULTS, autoFrom, autoGate } from '../src/main/livechat/auto';
import { buildDraftMessages, generateDraft, parseDraftAnswer } from '../src/main/livechat/draft';
import { baseline, inventedFacts, markHandled, needsReply, rollContext, scan, transcript, unhandled, unmark } from '../src/main/livechat/messages';
import { afterRestart, canMove, newSession, parseSession, scrub } from '../src/main/livechat/session';
import type { StoredDraft, StoredSession } from '../src/main/livechat/session';
import { EMPTY_LIVE_CHAT_VIEW, parseLiveChatRequest } from '../src/shared/liveChat';
import { FakeAI } from './liveChatFixtures';

const msg = (id: string, dir: 'in' | 'out', text: string, kind: LiveChatMessage['kind'] = 'text'): LiveChatMessage => ({ id, dir, kind, text, at: '' });
const NOW = 1_800_000_000_000;
const draft = (over: Partial<StoredDraft> = {}): StoredDraft => ({ id: 'd', text: 'Hi', status: 'ready', createdAt: NOW, by: 'eya', confidence: 'high', commitment: false, note: null, basedOn: ['false_1'], ...over });

describe('autoGate: whether ONE reply may go without the person', () => {
  const auto = (over: Partial<NonNullable<ReturnType<typeof autoFrom>>> = {}) => ({ ...autoFrom(NOW, { maxReplies: 2, maxMinutes: 10, minGapSeconds: 30 }), ...over });

  it('a plain, high-confidence reply of Eya’s own, within the limits, may', () => {
    expect(autoGate(auto(), draft(), NOW)).toEqual({ ok: true });
  });
  it('not switched on: stop', () => {
    expect(autoGate(null, draft(), NOW)).toMatchObject({ ok: false, stop: expect.stringMatching(/not switched on/) });
  });
  it('the reply limit is a hard stop', () => {
    expect(autoGate(auto({ repliesSent: 2 }), draft(), NOW)).toMatchObject({ ok: false, stop: expect.stringMatching(/2 automatic replies/) });
  });
  it('with no limit set (the default) there is no count and no time to run out: it goes on until the person pauses or stops it', () => {
    const open = autoFrom(NOW, {});
    expect(autoGate({ ...open, repliesSent: 5000 }, draft(), NOW + 30 * 24 * 60 * 60_000)).toEqual({ ok: true });
    expect(autoGate({ ...open, repliesSent: 5000, lastSentAt: NOW + 30 * 24 * 60 * 60_000 - 3_000 }, draft(), NOW + 30 * 24 * 60 * 60_000)).toMatchObject({ ok: false, wait: expect.any(Number) }); // (only the gap between two replies)
  });
  it('the time limit is a hard stop', () => {
    expect(autoGate(auto(), draft(), NOW + 11 * 60_000)).toMatchObject({ ok: false, stop: expect.stringMatching(/time you allowed/) });
  });
  it('the gap makes it wait, by exactly what is left', () => {
    expect(autoGate(auto({ lastSentAt: NOW - 10_000 }), draft(), NOW)).toEqual({ ok: false, wait: 20_000 });
    expect(autoGate(auto({ lastSentAt: NOW - 31_000 }), draft(), NOW)).toEqual({ ok: true });
  });
  it('a reply the person wrote or edited is never auto-sent (in either way)', () => {
    expect(autoGate(auto(), draft({ by: 'you' }), NOW)).toMatchObject({ ok: false });
    expect(autoGate(auto({ holdBack: true }), draft({ by: 'you' }), NOW)).toMatchObject({ ok: false });
  });

  describe('by default the person is watching the chat: a reply goes out as the message comes in, not held back for how it reads', () => {
    it('autoFrom does not hold back unless asked', () => {
      expect(autoFrom(NOW, {}).holdBack).toBe(false);
      expect(autoFrom(NOW, { holdBack: true }).holdBack).toBe(true);
    });
    it('a promise, a doubtful reply, a figure, a link, an address and a long reply all go', () => {
      expect(autoGate(auto(), draft({ commitment: true }), NOW)).toEqual({ ok: true });
      expect(autoGate(auto(), draft({ confidence: 'medium' }), NOW)).toEqual({ ok: true });
      expect(autoGate(auto(), draft({ confidence: 'low' }), NOW)).toEqual({ ok: true });
      for (const text of ['See you at 5000 hours', 'Open https://x.example', 'Mail a@b.com', 'The bank is closed today', 'x'.repeat(260)]) {
        expect(autoGate(auto(), draft({ text }), NOW), text.slice(0, 20)).toEqual({ ok: true });
      }
    });
    it('the limits still hold: the count, the time and the gap', () => {
      expect(autoGate(auto({ repliesSent: 2 }), draft({ commitment: true }), NOW)).toMatchObject({ ok: false, stop: expect.stringMatching(/2 automatic replies/) });
      expect(autoGate(auto(), draft({ commitment: true }), NOW + 11 * 60_000)).toMatchObject({ ok: false, stop: expect.stringMatching(/time you allowed/) });
      expect(autoGate(auto({ lastSentAt: NOW - 10_000 }), draft({ commitment: true }), NOW)).toEqual({ ok: false, wait: 20_000 });
    });
    it('what is never sent by itself, however it is asked: a password, a code, a card or account number, an Aadhaar number', () => {
      // (THIS reply waits for the person; automatic replies stay on for the next message: one word like "password" in a harmless answer must not end the live chat)
      for (const text of ['My OTP is fine', 'Tell me your password', 'Send the card number', 'What is your account number?', 'Share your aadhaar', 'The one-time code is here', 'cvv please']) {
        expect(autoGate(auto(), draft({ text }), NOW), text).toMatchObject({ ok: false, hold: expect.stringMatching(/private/) });
      }
    });
  });

  describe('held back for the person when asked (holdBack)', () => {
    it('a commitment or a doubtful reply is not sent', () => {
      expect(autoGate(auto({ holdBack: true }), draft({ commitment: true }), NOW)).toMatchObject({ ok: false });
      expect(autoGate(auto({ holdBack: true }), draft({ confidence: 'medium' }), NOW)).toMatchObject({ ok: false });
      expect(autoGate(auto({ holdBack: true }), draft({ confidence: 'low' }), NOW)).toMatchObject({ ok: false });
    });
    it('whatever the model says about itself, a reply with a figure, a link, something private, or a long one is not sent by itself', () => {
      for (const text of ['Send me 5000', 'Open https://x.example', 'My OTP is fine', 'Tell me your password', 'Mail a@b.com', 'The bank is closed', 'x'.repeat(260)]) {
        expect(autoGate(auto({ holdBack: true }), draft({ text }), NOW), text.slice(0, 20)).toMatchObject({ ok: false });
      }
      // plain replies, with a one- or two-digit number, are fine
      expect(autoGate(auto({ holdBack: true }), draft({ text: 'Give me 5 minutes' }), NOW)).toEqual({ ok: true });
      expect(autoGate(auto({ holdBack: true }), draft({ text: 'Good morning!' }), NOW)).toEqual({ ok: true });
    });
  });

  it('the settings are kept inside sensible bounds', () => {
    expect(autoFrom(NOW, {})).toMatchObject({ maxReplies: null, until: null, minGapMs: AUTO_DEFAULTS.minGapSeconds * 1000, repliesSent: 0, lastSentAt: null });
    expect(autoFrom(NOW, { maxReplies: 5000, maxMinutes: 99999, minGapSeconds: 0 })).toMatchObject({ maxReplies: 1000, minGapMs: 5000, until: NOW + 24 * 60 * 60_000 });
    expect(autoFrom(NOW, { maxReplies: 3, maxMinutes: 30 })).toMatchObject({ maxReplies: 3, until: NOW + 30 * 60_000 });
  });
});

describe('scan: what is new', () => {
  const old = [msg('false_1', 'in', 'Hello'), msg('true_2', 'out', 'Hi')];

  it('the first look makes everything old', () => {
    const t = baseline(old);
    expect(scan(t, old)).toMatchObject({ fresh: [], edited: [], outgoing: [] });
  });

  it('a new incoming message is fresh — and stays fresh until it is handled, however often it is read', () => {
    const t = baseline(old);
    const read = [...old, msg('false_3', 'in', 'Free today?')];
    const first = scan(t, read);
    expect(first.fresh.map((m) => m.id)).toEqual(['false_3']);
    const second = scan(first.next, read);
    expect(second.fresh.map((m) => m.id)).toEqual(['false_3']); // not handled yet: still waiting (a failed draft is tried again)
    const handled = markHandled(second.next, ['false_3']);
    expect(scan(handled, read).fresh).toEqual([]);
    expect(unhandled(handled, read)).toEqual([]);
  });

  it('what the account sent is outgoing, once', () => {
    const t = baseline(old);
    const read = [...old, msg('true_3', 'out', 'On my way')];
    const first = scan(t, read);
    expect(first.outgoing.map((m) => m.id)).toEqual(['true_3']);
    expect(scan(first.next, read).outgoing).toEqual([]);
    expect(first.fresh).toEqual([]);
  });

  it('an edit is noticed, only for a message already seen, and only incoming', () => {
    const t = baseline(old);
    const read = [msg('false_1', 'in', 'Hello there'), msg('true_2', 'out', 'Hi (edited)')];
    const s = scan(t, read);
    expect(s.edited.map((m) => m.id)).toEqual(['false_1']);
  });

  it('un-marking makes a handled message fresh again', () => {
    const t = baseline(old);
    expect(unhandled(unmark(t, ['false_1']), old).map((m) => m.id)).toEqual(['false_1']);
  });

  it('what is kept is bounded', () => {
    const many = Array.from({ length: 500 }, (_, i) => msg(`false_${i}`, 'in', `m${i}`));
    const t = baseline(many);
    expect(t.handled.length).toBeLessThanOrEqual(300);
    expect(Object.keys(t.hashes).length).toBeLessThanOrEqual(300);
  });
});

describe('needsReply and inventedFacts', () => {
  it('words and questions may need one; stickers, voice notes, deleted messages and acknowledgements do not', () => {
    expect(needsReply([msg('1', 'in', 'Are you free?')])).toMatchObject({ needed: true, why: 'a question' });
    expect(needsReply([msg('1', 'in', 'Send me the file')])).toMatchObject({ needed: true });
    expect(needsReply([msg('1', 'in', '', 'sticker')]).needed).toBe(false);
    expect(needsReply([msg('1', 'in', '', 'deleted')]).why).toMatch(/deleted/);
    expect(needsReply([msg('1', 'in', 'ok')]).needed).toBe(false);
    expect(needsReply([msg('1', 'in', 'Thank you 🙏')]).needed).toBe(false);
    expect(needsReply([msg('1', 'in', 'okay, thanks'), msg('2', 'in', 'what time?')]).needed).toBe(true);
    expect(needsReply([]).needed).toBe(false);
  });

  it('a reply may not bring in a figure, time, amount or link the conversation does not have', () => {
    expect(inventedFacts('See you at 5:30', 'Are you free today?')).toBe('5:30');
    expect(inventedFacts('I will send 2500', 'The fee is 2500')).toBeNull();
    expect(inventedFacts('Give me 2 minutes', 'Are you there?')).toBeNull(); // one digit is just a word
    expect(inventedFacts('Check https://evil.example', 'Hello')).toBe('https://evil.example');
    expect(inventedFacts('Mail me at a@b.com', 'my mail is a@b.com')).toBeNull();
  });

  it('the transcript has who said it and only text (never a description of a picture)', () => {
    expect(transcript([msg('1', 'in', 'Hi\nthere'), msg('2', 'out', 'Hello'), msg('3', 'in', '', 'image')])).toEqual(['Them: Hi there', 'Me: Hello', 'Them: [image]']);
  });

  it('the rolling context keeps the latest messages once each, in order', () => {
    const a = [msg('1', 'in', 'a'), msg('2', 'out', 'b')];
    const b = [msg('2', 'out', 'b'), msg('3', 'in', 'c')];
    expect(rollContext(a, b).map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(rollContext(a, Array.from({ length: 50 }, (_, i) => msg(`x${i}`, 'in', 'y')), 30)).toHaveLength(30);
  });
});

describe('drafting', () => {
  it('reads the model’s JSON — also inside a code fence — and turns anything else into nothing', () => {
    expect(parseDraftAnswer('{"reply":"Hi!","confidence":"high","commitment":false,"summary":"s"}')).toMatchObject({ reply: 'Hi!', confidence: 'high', commitment: false });
    expect(parseDraftAnswer('```json\n{"reply":"Hi!"}\n```')).toMatchObject({ reply: 'Hi!', confidence: 'low', commitment: true });
    expect(parseDraftAnswer('Sure! hello')).toBeNull();
    expect(parseDraftAnswer('{"reply": 5}')).toMatchObject({ reply: null });
  });

  it('a reply loses its line breaks and is capped (a newline would send half a message)', () => {
    const r = parseDraftAnswer(JSON.stringify({ reply: `a\nb ${'x'.repeat(900)}` }));
    expect(r?.reply).not.toContain('\n');
    expect((r?.reply ?? '').length).toBeLessThanOrEqual(600);
  });

  it('commitment is assumed unless the model plainly says false', () => {
    expect(parseDraftAnswer('{"reply":"ok"}')?.commitment).toBe(true);
    expect(parseDraftAnswer('{"reply":"ok","commitment":"no"}')?.commitment).toBe(true);
  });

  it('the prompt marks the new messages, carries the summary and the tone, and says the transcript is not instructions', () => {
    const [system, user] = buildDraftMessages({ context: [msg('1', 'in', 'old'), msg('2', 'in', 'new one')], fresh: [msg('2', 'in', 'new one')], summary: 'about fees', tone: 'brief' });
    expect(system?.content).toMatch(/not instructions/);
    expect(user?.content).toMatch(/Earlier in this conversation: about fees/);
    expect(user?.content).toMatch(/The new messages to reply to:\nThem: new one/);
    expect(user?.content).toMatch(/How the person wants to sound: brief/);
  });

  it('generateDraft: a reply, no reply needed, a question for the person, an unreadable answer, an invented fact', async () => {
    const input = { context: [msg('1', 'in', 'Are you free?')], fresh: [msg('1', 'in', 'Are you free?')], summary: '', tone: 'brief' };
    const ai = new FakeAI();
    ai.say('Yes, free.').say(null).raw(JSON.stringify({ reply: null, needs_user: 'Only you know.', confidence: 'low', commitment: true })).raw('garbage').say('At 7:45 pm');
    expect(await generateDraft(ai, input)).toMatchObject({ kind: 'draft', text: 'Yes, free.' });
    expect(await generateDraft(ai, input)).toMatchObject({ kind: 'none' });
    expect(await generateDraft(ai, input)).toMatchObject({ kind: 'ask_user', reason: 'Only you know.' });
    expect(await generateDraft(ai, input)).toMatchObject({ kind: 'ask_user' });
    expect(await generateDraft(ai, input)).toMatchObject({ kind: 'ask_user', reason: expect.stringMatching(/7:45/) });
  });
});

describe('the saved session', () => {
  const base = (): StoredSession => ({
    ...newSession('s1', NOW),
    state: 'ACTIVE',
    chat: { label: 'Rahul Sharma', verified: true },
    mode: 'auto',
    startedAt: NOW,
    auto: { maxReplies: 3, repliesSent: 1, minGapMs: 30_000, until: NOW + 600_000, lastSentAt: NOW, holdBack: false },
    draft: draft(),
    context: [msg('false_1', 'in', 'Hello')],
    sends: [{ id: 'x', draftId: 'd', triggerKey: 'false_1', text: 'Hi', at: NOW, status: 'attempted', pressed: true, lastOutId: null, by: 'auto', evidence: null }],
  });

  it('reads back exactly what was written', () => {
    expect(parseSession(JSON.parse(JSON.stringify(base())))).toEqual(base());
  });

  it('drops what is damaged instead of guessing', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ version: 2 })).toBeNull();
    expect(parseSession({ ...base(), state: 'NOT_A_STATE' })).toBeNull();
    const damaged = parseSession({ ...JSON.parse(JSON.stringify(base())), draft: { id: 1 }, context: [{ id: 5 }, { id: 'a', dir: 'in', kind: 'text', text: 'ok', at: '' }], sends: [{ nope: true }] });
    expect(damaged?.draft).toBeNull();
    expect(damaged?.context).toHaveLength(1);
    expect(damaged?.sends).toEqual([]);
  });

  it('after a restart: paused, auto off, a send that was going is uncertain — and nothing is sent', () => {
    const r = afterRestart({ ...base(), draft: draft({ status: 'sending' }) });
    expect(r).toMatchObject({ state: 'PAUSED', pause: 'restart', mode: 'assisted', auto: null });
    expect(r.draft?.status).toBe('uncertain');
    expect(r.sends[0]?.status).toBe('attempted'); // looked at before anything else, never resent
  });

  it('a session that was over stays over', () => {
    expect(afterRestart({ ...base(), state: 'STOPPED' }).state).toBe('STOPPED');
    expect(afterRestart({ ...base(), state: 'FAILED' }).state).toBe('FAILED');
  });

  it('scrubbing keeps that it happened, not the words', () => {
    const s = scrub(base());
    expect(JSON.stringify(s)).not.toContain('Hello');
    expect(s.draft).toBeNull();
    expect(s.sends[0]?.text).toBe('');
    expect(s.chat?.label).toBe('Rahul Sharma');
  });

  it('every state can end in STOPPED through STOPPING or directly where that is allowed', () => {
    for (const from of ['RESOLVING_CONTACT', 'CONNECTING', 'ACTIVE', 'PROCESSING_MESSAGE', 'DRAFT_READY', 'WAITING_FOR_APPROVAL', 'SENDING', 'VERIFYING', 'PAUSED', 'WAITING_FOR_USER', 'FAILED'] as const) {
      expect(canMove(from, 'STOPPING') || canMove(from, 'STOPPED'), from).toBe(true);
    }
  });
});

describe('what the page may ask for', () => {
  it('only the known requests, with their values kept in range', () => {
    expect(parseLiveChatRequest({ kind: 'start', name: ' Rahul ' })).toEqual({ kind: 'start', name: 'Rahul' });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Rahul', mode: 'auto' })).toEqual({ kind: 'start', name: 'Rahul' }); // auto is never a way to START
    expect(parseLiveChatRequest({ kind: 'start', name: '' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'set_mode', mode: 'auto' })).toBeNull(); // auto only through enable_auto
    expect(parseLiveChatRequest({ kind: 'enable_auto', confirmedAware: 'yes' })).toEqual({ kind: 'enable_auto', confirmedAware: false });
    expect(parseLiveChatRequest({ kind: 'enable_auto', confirmedAware: true, maxReplies: 99999, maxMinutes: -5, minGapSeconds: 1 })).toEqual({ kind: 'enable_auto', confirmedAware: true, maxReplies: 1000, maxMinutes: 1, minGapSeconds: 5 });
    expect(parseLiveChatRequest({ kind: 'send' })).toEqual({ kind: 'send' });
    expect(parseLiveChatRequest({ kind: 'delete_everything' })).toBeNull();
    expect(parseLiveChatRequest('send')).toBeNull();
    expect(parseLiveChatRequest({ kind: 'edit_draft', text: 'x'.repeat(2001) })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'choose', choice: 2 })).toEqual({ kind: 'choose', choice: 2 });
    expect(parseLiveChatRequest({ kind: 'choose', choice: 'two' })).toBeNull();
  });

  it('the empty view is not active and cannot send', () => {
    expect(EMPTY_LIVE_CHAT_VIEW).toMatchObject({ active: false, state: 'IDLE', sendAllowed: false, monitoring: 'off' });
  });
});
