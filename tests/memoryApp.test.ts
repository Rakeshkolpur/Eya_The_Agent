import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/main/memory/sqlite';
import { MemoryService } from '../src/main/memory/MemoryService';
import type { MemoryEvent } from '../src/main/memory/MemoryService';
import { memoryDbPath, privateStepCheck, startMemory } from '../src/main/memory/startMemory';
import { applyPanelAction, MEMORY_UNAVAILABLE, snapshotOf } from '../src/main/memory/panel';
import { LiveTaskTracker } from '../src/main/live/liveTasks';
import { buildLiveConfig, runLiveTool } from '../src/main/live/liveBridge';
import { createMemoryTools } from '../src/main/tools/impl/memoryTools';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { NewStep } from '../src/main/memory/types';

const dirs: string[] = [];
const services: MemoryService[] = [];
let tools: ToolRegistry;
let toolLog: string[];

const page = (extra: Record<string, unknown> = {}): ToolResult => ({
  ok: true,
  summary: 'ok',
  data: { currentPage: { url: 'https://tshc.gov.in/', title: 'Cause List - High Court', headings: ['Cause List'], links: [], buttons: [], inputs: [], ...extra } },
});

function fake(name: string, args: Tool['schema']['args']): Tool {
  return {
    schema: { name, description: name, args },
    async execute(a) {
      toolLog.push(`${name}:${JSON.stringify(a)}`);
      return page();
    },
  };
}

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'eya-app-'));
  dirs.push(d);
  return d;
};

function open(events: MemoryEvent[] = []): MemoryService {
  const svc = MemoryService.open(join(tmp(), 'data', 'eya_memory.db'), { tools, sleep: async () => undefined, notify: (e) => events.push(e) });
  services.push(svc);
  return svc;
}

const step = (action: NewStep['action'], target: string): NewStep => ({ action, target, value: '', submit: false, verifyKind: 'none', verifyText: '' });

beforeEach(() => {
  tools = new ToolRegistry();
  toolLog = [];
  tools.register(fake('open_website', { url: { type: 'string', required: true } }));
  tools.register(fake('click_on_page', { text: { type: 'string', required: true } }));
  tools.register(fake('inspect_page', {}));
});

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('where the database lives, and starting without it', () => {
  it('is a file in Eya\'s own data folder, never a temp folder, unless told otherwise', () => {
    expect(memoryDbPath('C:\\Users\\me\\AppData\\Roaming\\Eya', {})).toBe(join('C:\\Users\\me\\AppData\\Roaming\\Eya', 'data', 'eya_memory.db'));
    expect(memoryDbPath('/x', { EYA_MEMORY_DB: 'D:\\mine\\mem.db' })).toBe('D:\\mine\\mem.db');
    expect(memoryDbPath('/x', { EYA_MEMORY_DB: '   ' })).toBe(join('/x', 'data', 'eya_memory.db'));
  });

  it('creates the database and its folder on first start, and keeps what was saved across restarts', () => {
    const dir = tmp();
    const path = join(dir, 'data', 'eya_memory.db');
    const first = startMemory({ dbPath: path, tools, policy: { appForUrl: () => null, appForWindow: () => null }, notify: () => undefined });
    expect(first).not.toBeNull();
    expect(existsSync(path)).toBe(true);
    first?.memories.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    first?.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/')] });
    first?.close();
    const second = startMemory({ dbPath: path, tools, policy: { appForUrl: () => null, appForWindow: () => null }, notify: () => undefined });
    services.push(second as MemoryService);
    expect(second?.memories.list().map((m) => m.value)).toEqual(['Always save downloaded PDFs to Desktop']);
    expect(second?.skills.getByName('check_cause_list')?.enabled).toBe(true);
  });

  it('returns null — and Eya carries on without memory — when the file cannot be used', () => {
    const dir = tmp();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where a folder is needed');
    expect(startMemory({ dbPath: join(blocker, 'data', 'eya_memory.db'), tools, policy: { appForUrl: () => null, appForWindow: () => null }, notify: () => undefined })).toBeNull();

    // A database written by a NEWER Eya is refused rather than guessed at (and left untouched).
    const newer = join(dir, 'newer.db');
    const db = openDatabase(newer);
    db.exec('PRAGMA user_version = 999');
    db.close();
    expect(startMemory({ dbPath: newer, tools, policy: { appForUrl: () => null, appForWindow: () => null }, notify: () => undefined })).toBeNull();
    const again = openDatabase(newer);
    expect(again.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(999);
    again.close();
  });

  it('a damaged file is set aside and a fresh database started, so Eya still has memory', () => {
    const dir = tmp();
    const path = join(dir, 'eya_memory.db');
    writeFileSync(path, 'this is not a sqlite database at all, just some text '.repeat(40));
    const svc = startMemory({ dbPath: path, tools, policy: { appForUrl: () => null, appForWindow: () => null }, notify: () => undefined });
    expect(svc).not.toBeNull();
    services.push(svc as MemoryService);
    svc?.memories.save('fact', 'Ravi', 'Ravi is my brother');
    expect(svc?.memories.count()).toBe(1);
  });

  it('a step in a chat app is private (never learned from); an ordinary site or app is not', () => {
    const isPrivate = privateStepCheck({
      appForUrl: (u) => (/web\.whatsapp\.com/.test(u) ? ({ id: 'whatsapp' } as never) : null),
      appForWindow: (w) => (/whatsapp/i.test(w.process) || /whatsapp/i.test(w.title) ? ({ id: 'whatsapp' } as never) : null),
    });
    expect(isPrivate(step('open_url', 'https://web.whatsapp.com/'))).toBe(true);
    expect(isPrivate(step('open_app', 'WhatsApp.exe'))).toBe(true);
    expect(isPrivate(step('open_url', 'https://tshc.gov.in/'))).toBe(false);
    expect(isPrivate(step('open_app', 'Notepad'))).toBe(false);
    expect(isPrivate(step('click_text', 'Cause List'))).toBe(false);
  });
});

describe('the Memory panel', () => {
  it('shows "unavailable" without a database, and refuses every action', () => {
    expect(snapshotOf(null)).toEqual(MEMORY_UNAVAILABLE);
    expect(applyPanelAction(null, { kind: 'delete_memory', id: 1 })).toMatchObject({ ok: false, message: 'Memory is not available right now.' });
  });

  it('adds, edits and forgets memories', () => {
    const svc = open();
    expect(applyPanelAction(svc, { kind: 'add_memory', type: 'preference', text: 'Always save PDFs to Desktop' }).ok).toBe(true);
    expect(applyPanelAction(svc, { kind: 'add_memory', type: 'fact', text: "Ravi is my brother's contact" }).ok).toBe(true);
    const pref = svc.memories.list('preference')[0];
    expect(snapshotOf(svc).memories.map((m) => [m.type, m.value])).toEqual([
      ['fact', "Ravi is my brother's contact"], // newest first
      ['preference', 'Always save PDFs to Desktop'],
    ]);
    expect(applyPanelAction(svc, { kind: 'edit_memory', id: pref?.id ?? 0, text: 'Always save PDFs to Documents' }).ok).toBe(true);
    expect(svc.memories.get(pref?.id ?? 0)?.value).toBe('Always save PDFs to Documents');
    expect(applyPanelAction(svc, { kind: 'add_memory', type: 'fact', text: 'my card number is 4111 1111 1111 1111' })).toMatchObject({ ok: false });
    expect(applyPanelAction(svc, { kind: 'delete_memory', id: pref?.id ?? 0 }).ok).toBe(true);
    expect(applyPanelAction(svc, { kind: 'delete_memory', id: pref?.id ?? 0 })).toMatchObject({ ok: false, message: 'That memory is gone.' });
    expect(svc.memories.count()).toBe(1);
  });

  it('shows routines with their phrases, steps in words, and history; switches them, renames them, edits phrases, deletes them', () => {
    const svc = open();
    const made = svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/'), step('click_text', 'Cause List')] });
    const view = snapshotOf(svc).routines[0];
    expect(view).toMatchObject({ name: 'check_cause_list', enabled: true, triggers: ['check cause list'], useCount: 0, lastUsedAt: null });
    expect(view?.steps).toEqual(['1. open https://tshc.gov.in/', '2. click "Cause List"']);

    expect(applyPanelAction(svc, { kind: 'set_enabled', id: made.id, enabled: false }).snapshot.routines[0]?.enabled).toBe(false);
    expect(svc.matcher.match('check cause list')).toBeNull(); // off means off
    applyPanelAction(svc, { kind: 'set_enabled', id: made.id, enabled: true });
    expect(applyPanelAction(svc, { kind: 'rename_routine', id: made.id, name: 'court list' }).ok).toBe(true);
    expect(applyPanelAction(svc, { kind: 'add_phrase', id: made.id, text: 'court list please' }).snapshot.routines[0]?.triggers).toEqual(['check cause list', 'court list please']);
    expect(svc.matcher.match('court list please')?.skill.name).toBe('court list');
    expect(applyPanelAction(svc, { kind: 'remove_phrase', id: made.id, text: 'court list please' }).snapshot.routines[0]?.triggers).toEqual(['check cause list']);

    svc.skills.create({ name: 'other', triggers: ['do other'], steps: [step('open_app', 'Notepad')] });
    expect(applyPanelAction(svc, { kind: 'rename_routine', id: made.id, name: 'other' })).toMatchObject({ ok: false });
    expect(applyPanelAction(svc, { kind: 'add_phrase', id: made.id, text: 'do other' })).toMatchObject({ ok: false }); // that phrase already runs another routine

    expect(applyPanelAction(svc, { kind: 'delete_routine', id: made.id }).ok).toBe(true);
    expect(applyPanelAction(svc, { kind: 'delete_routine', id: made.id })).toMatchObject({ ok: false, message: 'That routine is gone.' });
    expect(svc.skills.count()).toBe(1);
  });

  it('answers an open offer from its buttons, and sees the offer in the snapshot', () => {
    const events: MemoryEvent[] = [];
    const svc = open(events);
    for (let i = 0; i < 3; i += 1) {
      svc.beginTask('check cause list');
      svc.observeTool('open_website', { url: 'https://tshc.gov.in/' }, page());
      svc.observeTool('click_on_page', { text: 'Cause List' }, page());
      svc.finishTask(true, { announce: false });
    }
    expect(snapshotOf(svc).suggestion).toMatchObject({ kind: 'save' });
    expect(events.some((e) => e.type === 'suggestion')).toBe(false); // announce: false — the reply already said it
    expect(events.some((e) => e.type === 'changed')).toBe(true); // …but the panel is told, to show Yes / No
    expect(applyPanelAction(svc, { kind: 'answer_suggestion', answer: 'yes' })).toMatchObject({ ok: true });
    expect(svc.skills.count()).toBe(1);
    expect(snapshotOf(svc).suggestion).toBeNull();
  });

  it('ignores anything malformed without throwing or changing a thing', () => {
    const svc = open();
    svc.memories.save('fact', 'Ravi', 'Ravi is my brother');
    for (const bad of [null, undefined, 7, 'delete_memory', [], {}, { kind: 'nope' }, { kind: 'delete_memory' }, { kind: 'delete_memory', id: '1' }, { kind: 'delete_memory', id: 1.5 }, { kind: 'delete_memory', id: -3 },
      { kind: 'add_memory', type: 'secret', text: 'x' }, { kind: 'add_memory', type: 'fact' }, { kind: 'set_enabled', id: 1, enabled: 'yes' }, { kind: 'answer_suggestion', answer: 'maybe' }]) {
      expect(() => applyPanelAction(svc, bad)).not.toThrow();
      expect(applyPanelAction(svc, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(svc.memories.count()).toBe(1);
  });
});

describe('a live conversation: tasks are noticed and the offer is the app\'s to make', () => {
  const heardCauseList = "check today's cause list";

  /** One live task: the model opens the site and clicks through, on one spoken request. */
  let nextTurn = 0;
  async function liveTask(tracker: LiveTaskTracker, heard: string, turn: number = (nextTurn += 1)): Promise<void> {
    const sink = (name: string, args: ToolArgs) => runLiveTool(tools, { name, args, heard, turn }, 5_000, tracker);
    await sink('open_website', { url: 'https://tshc.gov.in/' });
    await sink('click_on_page', { text: 'Cause List' });
  }

  it('counts each spoken request as one task and, the third time, announces the offer (the live model never hears it)', async () => {
    const events: MemoryEvent[] = [];
    const svc = open(events);
    const tracker = new LiveTaskTracker(svc, 60_000);
    await liveTask(tracker, heardCauseList);
    await liveTask(tracker, 'check the cause list'); // a new turn closes the first task
    await liveTask(tracker, 'check cause list');
    expect(events.some((e) => e.type === 'suggestion')).toBe(false); // the third task is still open
    tracker.flush();
    expect(events).toContainEqual({ type: 'suggestion', text: "You've done this several times. Would you like me to save it as a routine?" });
    expect(svc.hasPendingSuggestion()).toBe(true);
  });

  it('the model\'s tool call for "yes" finds the task it is about, because the previous task is closed before the call runs', async () => {
    const svc = open();
    for (const t of createMemoryTools(svc)) tools.register(t);
    const tracker = new LiveTaskTracker(svc, 60_000);
    await liveTask(tracker, heardCauseList);
    await liveTask(tracker, 'check the cause list');
    await liveTask(tracker, 'check cause list');
    // The user says "yes" (a new turn); the model calls answer_routine_suggestion. Nothing has flushed yet — the call itself must.
    const reply = await runLiveTool(tools, { name: 'answer_routine_suggestion', args: { answer: 'yes' }, heard: 'yes please', turn: (nextTurn += 1) }, 5_000, tracker);
    expect(JSON.parse(reply.content)).toMatchObject({ ok: true, summary: 'routine saved' });
    expect(svc.skills.listDetails()[0]?.steps.map((s) => s.target)).toEqual(['https://tshc.gov.in/', 'Cause List']);
  });

  it('"save this as a routine", said after one live task, saves that task', async () => {
    const svc = open();
    for (const t of createMemoryTools(svc)) tools.register(t);
    const tracker = new LiveTaskTracker(svc, 60_000);
    await liveTask(tracker, 'show me the cause list');
    const reply = await runLiveTool(tools, { name: 'save_routine', args: { name: 'cause list' }, heard: 'save this as a routine called cause list', turn: (nextTurn += 1) }, 5_000, tracker);
    expect(JSON.parse(reply.content)).toMatchObject({ ok: true, data: { routine: 'cause list' } });
  });

  it('the same words said twice in a row are two requests, not one: the turn number tells them apart', async () => {
    const events: MemoryEvent[] = [];
    const svc = open(events);
    const tracker = new LiveTaskTracker(svc, 60_000);
    await liveTask(tracker, 'check cause list', 1);
    await liveTask(tracker, 'check cause list', 2);
    await liveTask(tracker, 'check cause list', 3);
    tracker.flush();
    expect(events).toContainEqual({ type: 'suggestion', text: "You've done this several times. Would you like me to save it as a routine?" });
    expect(svc.skills.count()).toBe(0);
    expect(svc.recorder.lastTask()?.steps).toHaveLength(2); // two steps each time, never "open, click, open, click"
  });

  it('a transcript that arrives in pieces stays one task, and the fuller wording is the one kept (when there is no turn number)', async () => {
    const svc = open();
    const tracker = new LiveTaskTracker(svc, 60_000);
    await runLiveTool(tools, { name: 'open_website', args: { url: 'https://tshc.gov.in/' }, heard: 'check' }, 5_000, tracker);
    await runLiveTool(tools, { name: 'click_on_page', args: { text: 'Cause List' }, heard: "check today's cause list" }, 5_000, tracker);
    tracker.flush();
    expect(svc.recorder.lastTask()?.request).toBe("check today's cause list");
    expect(svc.recorder.lastTask()?.steps).toHaveLength(2);
  });

  it('with no transcript at all it still works: the quiet period closes the task', async () => {
    const svc = open();
    const tracker = new LiveTaskTracker(svc, 25);
    await runLiveTool(tools, { name: 'open_website', args: { url: 'https://tshc.gov.in/' } }, 5_000, tracker);
    await new Promise((r) => setTimeout(r, 120));
    // No wording was ever heard, so there is nothing to name a routine after and nothing is kept.
    expect(svc.recorder.lastTask()).toBeNull();
    expect(svc.candidates.count()).toBe(0);
  });

  it('the quiet period ends a task by itself, so an offer is not held until the next thing the user says', async () => {
    const events: MemoryEvent[] = [];
    const svc = open(events);
    const tracker = new LiveTaskTracker(svc, 30);
    await liveTask(tracker, heardCauseList);
    await liveTask(tracker, 'check the cause list');
    await liveTask(tracker, 'check cause list');
    await new Promise((r) => setTimeout(r, 150));
    expect(events.some((e) => e.type === 'suggestion')).toBe(true);
  });

  it('a task whose last call failed is not counted', async () => {
    const svc = open();
    tools.register({
      schema: { name: 'broken_click', description: 'x', args: {} },
      async execute() {
        return { ok: false, summary: 'not found', error: 'no such button' };
      },
    });
    const tracker = new LiveTaskTracker(svc, 60_000);
    for (let i = 0; i < 4; i += 1) {
      await runLiveTool(tools, { name: 'open_website', args: { url: 'https://tshc.gov.in/' }, heard: `try ${i} cause list` }, 5_000, tracker);
      await runLiveTool(tools, { name: 'broken_click', args: {}, heard: `try ${i} cause list` }, 5_000, tracker);
    }
    tracker.flush();
    expect(svc.hasPendingSuggestion()).toBe(false);
  });

  it('a memory that breaks never breaks a tool call', async () => {
    const broken = {
      beginTask: () => {
        throw new Error('db locked');
      },
      observeTool: () => undefined,
      finishTask: () => null,
    };
    const tracker = new LiveTaskTracker(broken, 60_000, () => undefined);
    const reply = await runLiveTool(tools, { name: 'open_website', args: { url: 'https://tshc.gov.in/' }, heard: 'open it' }, 5_000, tracker);
    expect(JSON.parse(reply.content)).toMatchObject({ ok: true });
    expect(() => tracker.flush()).not.toThrow();
  });

  it('the tool request carries "heard" to the tracker but a tool never sees it as an argument', async () => {
    const svc = open();
    const tracker = new LiveTaskTracker(svc, 60_000);
    await runLiveTool(tools, { name: 'open_website', args: { url: 'https://tshc.gov.in/' }, heard: 'open the court site' }, 5_000, tracker);
    expect(toolLog).toEqual(['open_website:{"url":"https://tshc.gov.in/"}']);
  });
});

describe('the live conversation\'s instructions', () => {
  const gemini = { liveUrl: () => 'wss://example/live?key=K' };
  const NOW = () => new Date('2026-10-04T10:00:00Z');

  it('carry the user\'s preferences and the routines Eya can run, after her usual instructions', () => {
    const svc = open();
    svc.memories.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/')] });
    const cfg = buildLiveConfig({ gemini, tools, env: {}, now: NOW, memory: svc }, 'Aoede');
    const plain = buildLiveConfig({ gemini, tools, env: {}, now: NOW }, 'Aoede');
    expect(cfg?.systemInstruction.startsWith(plain?.systemInstruction ?? '?')).toBe(true);
    expect(cfg?.systemInstruction).toContain('Preference: Always save downloaded PDFs to Desktop');
    expect(cfg?.systemInstruction).toContain('call run_routine');
    expect(cfg?.systemInstruction).toContain('check cause list');
  });

  it('are unchanged when there is nothing to add, and when memory itself fails', () => {
    const svc = open();
    const plain = buildLiveConfig({ gemini, tools, env: {}, now: NOW }, 'Aoede');
    expect(buildLiveConfig({ gemini, tools, env: {}, now: NOW, memory: svc }, 'Aoede')?.systemInstruction).toBe(plain?.systemInstruction);
    const broken = { promptBlock: () => { throw new Error('boom'); }, beginTask: () => undefined, observeTool: () => undefined, finishTask: () => null };
    expect(buildLiveConfig({ gemini, tools, env: {}, now: NOW, memory: broken }, 'Aoede')?.systemInstruction).toBe(plain?.systemInstruction);
  });
});

describe('chat names in the Memory panel', () => {
  it('shows what Eya holds and whether she is remembering, and nothing else from a chat app', () => {
    const svc = open();
    expect(snapshotOf(svc).chatNames).toEqual({ learning: 'unasked', names: [] });
    svc.contacts.setLearning('on');
    svc.contacts.learn('whatsapp', ['Ravi Kumar', 'Amma']);
    svc.contacts.addAlias('whatsapp', 'Amma', 'Mom');
    const view = snapshotOf(svc).chatNames;
    expect(view.learning).toBe('on');
    expect(view.names.map((n) => [n.app, n.name, n.aliases])).toEqual([
      ['WhatsApp', 'Amma', ['Mom']],
      ['WhatsApp', 'Ravi Kumar', []],
    ]);
    expect(Object.keys(view.names[0] ?? {}).sort()).toEqual(['aliases', 'app', 'id', 'name', 'uses']);
  });

  it('lets the user switch it on and off, forget one name, or forget them all', () => {
    const svc = open();
    expect(applyPanelAction(svc, { kind: 'set_chat_names', on: true }).ok).toBe(true);
    expect(svc.contacts.learning()).toBe('on');
    svc.contacts.learn('whatsapp', ['Ravi Kumar', 'Amma', 'Priya Singh']);
    const amma = svc.contacts.list('whatsapp').find((c) => c.name === 'Amma');
    expect(applyPanelAction(svc, { kind: 'forget_chat_name', id: amma?.id ?? -1 }).ok).toBe(true);
    expect(applyPanelAction(svc, { kind: 'forget_chat_name', id: amma?.id ?? -1 })).toMatchObject({ ok: false, message: 'That name is already gone.' });
    expect(snapshotOf(svc).chatNames.names).toHaveLength(2);
    expect(applyPanelAction(svc, { kind: 'forget_chat_names' }).snapshot.chatNames.names).toHaveLength(0);
    expect(svc.contacts.learning()).toBe('on');
    svc.contacts.learn('whatsapp', ['Sita']);
    expect(applyPanelAction(svc, { kind: 'set_chat_names', on: false }).snapshot.chatNames).toEqual({ learning: 'off', names: [] });
    expect(applyPanelAction(svc, { kind: 'set_chat_names', on: 'yes' as never }).ok).toBe(false);
  });

  it('tells the panel when the names change', () => {
    const events: MemoryEvent[] = [];
    const svc = open(events);
    svc.contacts.setLearning('on');
    svc.contacts.learn('whatsapp', ['Ravi Kumar']);
    expect(events.filter((e) => e.type === 'changed').length).toBeGreaterThanOrEqual(2);
  });

  it('never puts a chat name in the instructions given to the model', () => {
    const svc = open();
    svc.contacts.setLearning('on');
    svc.contacts.learn('whatsapp', ['Ravi Kumar', 'Amma']);
    svc.memories.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    expect(svc.promptBlock('message Ravi that hi')).not.toMatch(/Ravi Kumar|Amma/);
    const cfg = buildLiveConfig({ gemini: { liveUrl: () => 'wss://example/live?key=K' }, tools, env: {}, now: () => new Date('2026-10-04T10:00:00Z'), memory: svc }, 'Aoede');
    expect(cfg?.systemInstruction ?? '').not.toMatch(/Ravi Kumar|Amma/);
  });
});
