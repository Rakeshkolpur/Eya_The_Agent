import { describe, it, expect } from 'vitest';
import { ChatSession } from '../src/main/chat/chatSession';

function rig(ttl = 10 * 60_000) {
  const clock = { t: 1_000_000 };
  return { s: new ChatSession(() => clock.t, ttl), clock };
}

describe('the chat Eya is working in (memory only)', () => {
  it('remembers the chat that was opened, with the end of its number', () => {
    const { s } = rig();
    expect(s.chat()).toBeNull();
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma', phoneEnding: '432' });
    expect(s.chat()).toEqual({ app: 'WhatsApp', label: 'Rahul Sharma', phoneEnding: '432' });
  });

  it('forgets it after a while, so an old chat is never assumed to be the one in front', () => {
    const { s, clock } = rig(60_000);
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    clock.t += 59_000;
    expect(s.chat()).not.toBeNull();
    clock.t += 2_000;
    expect(s.chat()).toBeNull();
  });

  it('keeps the last few chats, most recent first, without repeats', () => {
    const { s } = rig();
    for (const name of ['A', 'B', 'C', 'A', 'D', 'E', 'F']) s.openedChat({ app: null, label: name });
    expect(s.recent()).toEqual(['F', 'E', 'D', 'A', 'C']);
  });

  it('forgets everything on clear (what happens when Communication Access is turned off)', () => {
    const { s } = rig();
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    s.attached('report.pdf');
    s.authorize({ chat: 'Rahul Sharma', file: 'report.pdf' });
    s.offerChoices([{ label: 'X' }]);
    s.clear();
    expect(s.chat()).toBeNull();
    expect(s.recent()).toEqual([]);
    expect(s.attachment()).toBeNull();
    expect(s.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(false);
    expect(s.pick(1)).toBeNull();
  });
});

describe('"which one did you mean?"', () => {
  it('numbers the candidates from 1 and hands one back by number', () => {
    const { s } = rig();
    const offered = s.offerChoices([{ label: 'Rahul Sharma', phoneEnding: '432' }, { label: 'Rahul Verma' }]);
    expect(offered).toEqual([{ choice: 1, label: 'Rahul Sharma', phoneEnding: '432' }, { choice: 2, label: 'Rahul Verma' }]);
    expect(s.pick(2)?.label).toBe('Rahul Verma');
    expect(s.pick(3)).toBeNull();
    expect(s.pick(0)).toBeNull();
  });

  it('a new list replaces the old one, and opening a chat ends the question', () => {
    const { s } = rig();
    s.offerChoices([{ label: 'A' }]);
    s.offerChoices([{ label: 'B' }]);
    expect(s.pick(1)?.label).toBe('B');
    s.openedChat({ app: null, label: 'B' });
    expect(s.pick(1)).toBeNull();
  });
});

describe('the send that was just made, and the marks before it', () => {
  it('a send being made uses up the yes, and the file becomes the one just sent, waiting to be checked', () => {
    const { s } = rig();
    s.openedChat({ app: null, label: 'Mum' });
    s.attached('a.pdf');
    s.authorize({ chat: 'Mum', file: 'a.pdf' });
    s.sendMade();
    expect(s.isAuthorized('Mum', 'a.pdf')).toBe(false);
    expect(s.attachment()).toBeNull();
    expect(s.lastSent()).toBe('a.pdf');
    s.spent();
    expect(s.lastSent()).toBeNull();
  });

  it('keeps the delivery marks seen before a send, for a while, and forgets them when the chat changes', () => {
    const { s, clock } = rig(60_000);
    s.openedChat({ app: null, label: 'Mum' });
    expect(s.baseline()).toBeNull();
    s.markBaseline(['read', 'sent']);
    expect(s.baseline()).toEqual(['read', 'sent']);
    clock.t += 61_000;
    expect(s.baseline()).toBeNull();
    s.markBaseline(['read']);
    s.openedChat({ app: null, label: 'Dad' });
    expect(s.baseline()).toBeNull();
  });

  it('a send that was made is forgotten if the user moves to another chat', () => {
    const { s } = rig();
    s.openedChat({ app: null, label: 'Mum' });
    s.attached('a.pdf');
    s.sendMade();
    s.openedChat({ app: null, label: 'Dad' });
    expect(s.lastSent()).toBeNull();
  });
});

describe('the user\'s yes covers exactly one send', () => {
  it('only the same chat AND the same file', () => {
    const { s } = rig();
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    s.authorize({ chat: 'Rahul Sharma', file: 'report.pdf' });
    expect(s.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(true);
    expect(s.isAuthorized('Rahul Verma', 'report.pdf')).toBe(false); // somebody else
    expect(s.isAuthorized('Rahul Sharma', 'other.pdf')).toBe(false); // something else
    expect(s.isAuthorized('Rahul Sharma')).toBe(false); // a typed message is not the file they agreed to
  });

  it('a yes to a message is not a yes to a file', () => {
    const { s } = rig();
    s.authorize({ chat: 'Mum' });
    expect(s.isAuthorized('Mum')).toBe(true);
    expect(s.isAuthorized('Mum', 'x.pdf')).toBe(false);
  });

  it('is used up once the send is done, and runs out on its own', () => {
    const { s, clock } = rig(60_000);
    s.authorize({ chat: 'Mum' });
    s.spent();
    expect(s.isAuthorized('Mum')).toBe(false);
    s.authorize({ chat: 'Mum' });
    clock.t += 61_000;
    expect(s.isAuthorized('Mum')).toBe(false);
  });

  it('is withdrawn when the user moves to a different chat', () => {
    const { s } = rig();
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    s.authorize({ chat: 'Rahul Sharma', file: 'report.pdf' });
    s.attached('report.pdf');
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Verma' });
    expect(s.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(false);
    expect(s.attachment()).toBeNull();
  });

  it('re-opening the same chat keeps the attachment and the yes', () => {
    const { s } = rig();
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    s.authorize({ chat: 'Rahul Sharma', file: 'report.pdf' });
    s.attached('report.pdf');
    s.openedChat({ app: 'WhatsApp', label: 'Rahul Sharma' });
    expect(s.isAuthorized('Rahul Sharma', 'report.pdf')).toBe(true);
    expect(s.attachment()).toBe('report.pdf');
  });
});
