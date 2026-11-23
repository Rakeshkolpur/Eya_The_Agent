import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OwnerNotes, MAX_SAVED_NOTES } from '../src/main/livechat/OwnerNotes';
import { LiveChatHub } from '../src/main/livechat/LiveChatHub';
import { parseNotesCommand } from '../src/main/local/chatIntents';
import { LiveChatPage } from '../src/renderer/pages/LiveChatPage';
import type { EyaControl } from '../src/renderer/control';
import { EMPTY_LIVE_CHAT_VIEW, parseLiveChatRequest } from '../src/shared/liveChat';
import { FakeSwitch, MemoryIo, rig, settle } from './liveChatFixtures';

/**
 * "If they said anything to tell Rakesh, make it a note — an important message — and keep it": every thing someone in a live chat asks Eya to pass on is kept in one file
 * (who it was from, when, what), from every live chat together, until the person clears it; it stays after the live chat ends and after a restart.
 */

const book = (io = new MemoryIo(), start = 1_800_000_000_000) => {
  let t = start;
  let n = 0;
  return { io, notes: new OwnerNotes('notes.json', io, () => (t += 1000), () => `n${++n}`) };
};

describe('the kept notes', () => {
  it('a note keeps who it is from, when and what; newest last; a number only by its last digits is the caller\'s doing', () => {
    const { notes } = book();
    notes.add({ from: 'Priya Rao', text: 'Please call her tonight' });
    notes.add({ from: 'the number ending 8501', text: 'sent a document called plan.pdf', kind: 'file' });
    expect(notes.list().map((n) => [n.from, n.text, n.kind, n.done])).toEqual([
      ['Priya Rao', 'Please call her tonight', 'said', false],
      ['the number ending 8501', 'sent a document called plan.pdf', 'file', false],
    ]);
    expect(notes.list()[1]!.at).toBeGreaterThan(notes.list()[0]!.at);
  });

  it('empty words are not a note; long ones are cut; line breaks become spaces', () => {
    const { notes } = book();
    expect(notes.add({ from: 'A', text: '   ' })).toBeNull();
    notes.add({ from: 'A', text: 'one\n\ntwo   three' });
    notes.add({ from: 'A', text: 'x'.repeat(900) });
    expect(notes.list()[0]!.text).toBe('one two three');
    expect(notes.list()[1]!.text.length).toBe(400);
  });

  it('it is kept in a file and is still there after a restart', () => {
    const { io, notes } = book();
    notes.add({ from: 'Priya Rao', text: 'Call her tonight' });
    const again = new OwnerNotes('notes.json', io);
    expect(again.list().map((n) => n.text)).toEqual(['Call her tonight']);
  });

  it('done / not done / delete / clear finished / clear all', () => {
    const { notes } = book();
    const a = notes.add({ from: 'A', text: 'one' })!;
    const b = notes.add({ from: 'B', text: 'two' })!;
    notes.add({ from: 'C', text: 'three' });
    expect(notes.done(a.id)).toBe(true);
    expect(notes.open().map((n) => n.text)).toEqual(['two', 'three']);
    expect(notes.done(a.id, false)).toBe(true);
    expect(notes.open()).toHaveLength(3);
    notes.done(a.id);
    expect(notes.clear('done')).toBe(1);
    expect(notes.list().map((n) => n.text)).toEqual(['two', 'three']);
    expect(notes.remove(b.id)).toBe(true);
    expect(notes.remove('nope')).toBe(false);
    expect(notes.clear('all')).toBe(1);
    expect(notes.list()).toEqual([]);
    expect(notes.done('nope')).toBe(false);
  });

  it('only so many are kept; the finished ones go first', () => {
    const { notes } = book();
    const first = notes.add({ from: 'A', text: 'old and finished' })!;
    notes.done(first.id);
    for (let i = 0; i < MAX_SAVED_NOTES; i += 1) notes.add({ from: 'A', text: `note ${i}` });
    expect(notes.list()).toHaveLength(MAX_SAVED_NOTES);
    expect(notes.list().some((n) => n.text === 'old and finished')).toBe(false);
    expect(notes.list()[0]!.text).toBe('note 0');
  });

  it('a file that is not valid is ignored; bad entries are skipped; a listener hears every change', () => {
    const io = new MemoryIo();
    io.files.set('notes.json', '{not json');
    expect(new OwnerNotes('notes.json', io).list()).toEqual([]);
    io.files.set('notes.json', JSON.stringify([{ id: 'x', at: 1, from: 'A', text: 'ok' }, { id: 5 }, 'junk']));
    const notes = new OwnerNotes('notes.json', io);
    expect(notes.list().map((n) => n.text)).toEqual(['ok']);
    let heard = 0;
    notes.onChange(() => (heard += 1));
    notes.add({ from: 'A', text: 'two' });
    notes.clear('all');
    expect(heard).toBe(2);
  });
});

describe('a live chat keeps what someone asks it to pass on', () => {
  it('"tell Rakesh …" is spoken to Rakesh AND kept, with who it was from', async () => {
    const { notes } = book();
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ notes, enable: sw.control });
    r.chat.open = 'Priya Rao';
    r.chat.title = 'Priya Rao';
    r.chat.openOutcome = { kind: 'opened', label: 'Priya Rao', verified: true };
    r.ai.say('Hi! 😊 How are you doing today?');
    await r.controller.start('Priya Rao');
    await settle(40);
    r.ai.say('Sure, I will tell him', { for_owner: 'she asks you to call her tonight' });
    r.chat.incoming('please tell Rakesh to call me tonight');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(notes.list().map((n) => [n.from, n.text, n.kind])).toEqual([['Priya Rao', 'she asks you to call her tonight', 'said']]);
    expect(r.said).toHaveLength(1);
  });

  it('a number is kept only by its last four digits', async () => {
    const { notes } = book();
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ notes, enable: sw.control });
    r.chat.open = '+91 98765 08501';
    r.chat.title = '+91 98765 08501';
    r.chat.openOutcome = { kind: 'opened', label: '+91 98765 08501', verified: true };
    r.ai.say('Hello!');
    await r.controller.start('+91 98765 08501');
    await settle(40);
    r.ai.say('ok, I will tell him', { for_owner: 'she called and wants you to ring back' });
    r.chat.incoming('tell Rakesh I called');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(notes.list()).toHaveLength(1);
    expect(notes.list()[0]!.from).toBe('the number ending 8501');
    expect(JSON.stringify(notes.list())).not.toMatch(/98765|\+91/);
  });

  it('nothing for Rakesh, nothing kept', async () => {
    const { notes } = book();
    const sw = new FakeSwitch();
    sw.on = true;
    const r = rig({ notes, enable: sw.control });
    r.chat.open = 'Priya Rao';
    r.chat.title = 'Priya Rao';
    r.chat.openOutcome = { kind: 'opened', label: 'Priya Rao', verified: true };
    r.ai.say('Hi!');
    await r.controller.start('Priya Rao');
    await settle(40);
    r.ai.say('I am good, thanks!');
    r.chat.incoming('hi, how are you');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(notes.list()).toEqual([]);
  });
});

describe('the notes on the page and through the hub', () => {
  it('the hub shows the kept notes whether or not a live chat is running, and handles done / delete / clear', async () => {
    const { notes } = book();
    const a = notes.add({ from: 'Priya Rao', text: 'call her' })!;
    notes.add({ from: 'Rahul', text: 'bring the file' });
    const hub = new LiveChatHub({ make: () => rig().controller, multi: () => true, notes });
    expect(hub.view().active).toBe(false);
    expect(hub.view().savedNotes?.map((n) => n.text)).toEqual(['call her', 'bring the file']);
    let pushed = 0;
    hub.onChange(() => (pushed += 1));
    expect((await hub.handle({ kind: 'note_done', id: a.id })).ok).toBe(true);
    expect(hub.view().savedNotes?.[0]?.done).toBe(true);
    expect(pushed).toBeGreaterThan(0);
    expect((await hub.handle({ kind: 'note_delete', id: a.id })).ok).toBe(true);
    expect((await hub.handle({ kind: 'note_done', id: 'nope' })).ok).toBe(false);
    expect((await hub.handle({ kind: 'notes_clear' })).message).toBe('Cleared 1 note.');
    expect(hub.view().savedNotes).toEqual([]);
    expect((await hub.handle({ kind: 'notes_clear' })).message).toBe('There was nothing to clear.');
    hub.dispose();
  });

  it('the page asks are checked: an id, and nothing else', () => {
    expect(parseLiveChatRequest({ kind: 'note_done', id: 'n1' })).toEqual({ kind: 'note_done', id: 'n1' });
    expect(parseLiveChatRequest({ kind: 'note_done', id: 'n1', done: false })).toEqual({ kind: 'note_done', id: 'n1', done: false });
    expect(parseLiveChatRequest({ kind: 'note_done' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'note_delete', id: 'x'.repeat(200) })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'notes_clear', which: 'done' })).toEqual({ kind: 'notes_clear', which: 'done' });
    expect(parseLiveChatRequest({ kind: 'notes_clear', which: 'everything' })).toEqual({ kind: 'notes_clear' });
  });

  it('the Live chat page shows the notes with a live chat running or not, newest first, with Done / Delete / Clear', () => {
    const view = { ...EMPTY_LIVE_CHAT_VIEW, savedNotes: [
      { id: 'n1', at: Date.now() - 60_000, from: 'Rahul', text: 'bring the file', kind: 'said' as const, done: true },
      { id: 'n2', at: Date.now(), from: 'Priya Rao', text: 'call her tonight', kind: 'said' as const, done: false },
    ] };
    const m = renderToStaticMarkup(React.createElement(LiveChatPage, { c: { liveChat: view, liveChatAct: async () => ({ ok: true, message: '', view }) } as unknown as EyaControl }));
    expect(m).toContain('Notes for you');
    expect(m.indexOf('Priya Rao')).toBeLessThan(m.indexOf('Rahul'));
    expect(m).toMatch(/Done<\/button>/);
    expect(m).toMatch(/Not done<\/button>/);
    expect(m).toMatch(/Clear finished/);
    expect(m).toMatch(/Clear all/);
    const none = renderToStaticMarkup(React.createElement(LiveChatPage, { c: { liveChat: { ...EMPTY_LIVE_CHAT_VIEW, savedNotes: [] }, liveChatAct: async () => ({ ok: true, message: '', view }) } as unknown as EyaControl }));
    expect(none).not.toContain('Notes for you');
  });
});

describe('asking for the notes', () => {
  it.each([
    ['show my notes', 'show'],
    ['read my notes', 'show'],
    ['show me my live chat notes', 'show'],
    ['what are my notes', 'show'],
    ['any messages for me', 'show'],
    ['do I have any notes from the live chat?', 'show'],
    ['clear my notes', 'clear'],
    ['please delete all my notes', 'clear'],
  ])('%s → %s', (said, what) => {
    expect(parseNotesCommand(said)).toBe(what);
  });

  it.each(['make a note that I called Rahul', 'note this down', 'take notes', 'my notes are in the folder', 'open notepad', 'show my files', 'delete my files', ''])('%s is not about the notes from the live chats', (said) => {
    expect(parseNotesCommand(said)).toBeNull();
  });
});
