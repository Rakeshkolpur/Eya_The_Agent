import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../src/main/memory/MemoryService';
import { createMemoryTools } from '../src/main/tools/impl/memoryTools';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { riskLevelFor } from '../src/main/permissions/PermissionManager';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { NewStep } from '../src/main/memory/types';

const dirs: string[] = [];
const services: MemoryService[] = [];
let tools: ToolRegistry;
let calls: Array<{ name: string; args: ToolArgs }>;
let site: (name: string, args: ToolArgs) => ToolResult;

const page = (extra: Record<string, unknown> = {}): ToolResult => ({
  ok: true,
  summary: 'ok',
  data: { currentPage: { url: 'https://tshc.gov.in/', title: 'Cause List - High Court', headings: ['Cause List'], links: [], buttons: [], inputs: [], ...extra } },
});

function fake(name: string, args: Tool['schema']['args']): Tool {
  return {
    schema: { name, description: name, args },
    async execute(a) {
      calls.push({ name, args: a });
      return site(name, a);
    },
  };
}

const step = (action: NewStep['action'], target: string, verifyKind: NewStep['verifyKind'] = 'none', verifyText = ''): NewStep => ({ action, target, value: '', submit: false, verifyKind, verifyText });

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'eya-tools-'));
  dirs.push(dir);
  const svc = MemoryService.open(join(dir, 'data', 'eya_memory.db'), { tools, sleep: async () => undefined });
  services.push(svc);
  for (const t of createMemoryTools(svc)) tools.register(t);
  return svc;
}

beforeEach(() => {
  tools = new ToolRegistry();
  calls = [];
  site = () => page();
  tools.register(fake('open_website', { url: { type: 'string', required: true }, browser: { type: 'string' } }));
  tools.register(fake('click_on_page', { text: { type: 'string', required: true } }));
  tools.register(fake('inspect_page', {}));
});

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('remember / forget / list', () => {
  it('keeps a fact or a preference, updates it when said again, and refuses a secret', async () => {
    const svc = open();
    expect(await tools.invoke('remember', { text: "Ravi is my brother's contact" })).toMatchObject({ ok: true, summary: 'remembered' });
    expect(await tools.invoke('remember', { text: 'always save downloaded PDFs to Desktop', kind: 'preference' })).toMatchObject({ ok: true });
    expect(svc.memories.list('preference')).toHaveLength(1);
    expect(svc.memories.list('fact')).toHaveLength(1);
    const secret = await tools.invoke('remember', { text: 'my bank password is hunter2' });
    expect(secret).toMatchObject({ ok: false, summary: 'not remembered' });
    expect(svc.memories.count()).toBe(2);
    const listed = await tools.invoke('list_memories', {});
    expect(listed.data?.['count']).toBe(2);
    expect(JSON.stringify(listed.data)).not.toContain('hunter2');
  });

  it('forgets by a few words, and says so when there is nothing by that name', async () => {
    const svc = open();
    svc.memories.save('fact', 'Ravi', "Ravi is my brother's contact");
    expect(await tools.invoke('forget_memory', { what: 'Ravi' })).toMatchObject({ ok: true });
    expect(svc.memories.count()).toBe(0);
    expect(await tools.invoke('forget_memory', { what: 'Zorro' })).toMatchObject({ ok: false, summary: 'nothing to forget' });
  });

  it('rejects arguments it does not know, like every other tool', async () => {
    open();
    expect(await tools.invoke('remember', { text: 'x', secret: 'y' })).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(await tools.invoke('remember', {})).toMatchObject({ ok: false, summary: 'invalid arguments' });
  });
});

describe('run_routine', () => {
  const seed = (svc: MemoryService) =>
    svc.skills.create({
      name: 'check_cause_list',
      triggers: ['check cause list', "today's cause list"],
      steps: [step('open_url', 'https://tshc.gov.in/', 'url_contains', 'tshc.gov.in'), step('click_text', 'Cause List', 'page_contains', 'cause')],
    });

  it('runs it by name or by the words the user said, with the ordinary tools', async () => {
    const svc = open();
    seed(svc);
    const byName = await tools.invoke('run_routine', { routine: 'check_cause_list' });
    expect(byName).toMatchObject({ ok: true, summary: 'routine done', data: { routine: 'check_cause_list', routineStatus: 'done', say: 'Done.' } });
    const byWords = await tools.invoke('run_routine', { routine: "check today's cause list" });
    expect(byWords.ok).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(['open_website', 'click_on_page', 'open_website', 'click_on_page']);
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ useCount: 2, successCount: 2 });
  });

  it('says plainly when there is no such routine, and lists the ones there are', async () => {
    const svc = open();
    seed(svc);
    const r = await tools.invoke('run_routine', { routine: 'water the plants' });
    expect(r).toMatchObject({ ok: false, summary: 'no such routine' });
    expect(r.error).toContain('check cause list');
    expect(calls).toEqual([]);
  });

  it('refuses a routine that is switched off', async () => {
    const svc = open();
    const s = seed(svc);
    svc.skills.setEnabled(s.id, false);
    const r = await tools.invoke('run_routine', { routine: 'check_cause_list' });
    expect(r).toMatchObject({ ok: false, summary: 'routine not run' });
    expect(r.error).toContain('switched off');
    expect(calls).toEqual([]);
  });

  it('when a step\'s check fails it reports where it stopped and why, for the model to carry on from', async () => {
    const svc = open();
    seed(svc);
    site = () => page({ title: 'Page not found', headings: ['404'] });
    const r = await tools.invoke('run_routine', { routine: 'check_cause_list' });
    expect(r).toMatchObject({ ok: false, summary: 'routine stopped', data: { routine: 'check_cause_list', routineStatus: 'failed' } });
    expect(r.error).toContain('stopped at step 2 of 2 (1 done)');
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ failureCount: 1 });
  });

  it('a routine that stopped for the user\'s say-so is reported as needing the user, not as failed', async () => {
    const svc = open();
    seed(svc);
    site = (name) => (name === 'click_on_page' ? { ok: false, summary: 'needs confirmation', error: 'Ask.', data: { status: 'permission_required', question: 'Go ahead?' } } : page());
    const r = await tools.invoke('run_routine', { routine: 'check_cause_list' });
    expect(r.data?.['routineStatus']).toBe('needs_user');
    expect(r.error).toContain('Go ahead?');
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ failureCount: 0, successCount: 0, useCount: 1 });
  });

  it('a routine that failed under the model, which then finishes the job another way, is offered as an update — whole, not half', async () => {
    const svc = open();
    seed(svc);
    // The site breaks at the click and stays broken when the routine looks again (inspect_page), so the check really fails.
    let broken = false;
    site = (name, args) => {
      if (name === 'click_on_page' && args['text'] === 'Cause List') broken = true;
      return broken ? page({ title: 'Page not found', headings: ['404'] }) : page();
    };
    svc.beginTask('check cause list');
    const failed = await tools.invoke('run_routine', { routine: 'check_cause_list' });
    svc.observeTool('run_routine', { routine: 'check_cause_list' }, failed);
    const better: ToolResult = page({ title: 'Daily Cause List', headings: ['Daily Cause List'] });
    svc.observeTool('click_on_page', { text: 'Daily Cause List' }, better);
    const offer = svc.finishTask(true);
    expect(offer).toContain('update the routine "check_cause_list"');
    expect(await tools.invoke('answer_routine_suggestion', { answer: 'yes' })).toMatchObject({ ok: true });
    const steps = svc.skills.stepsOf(svc.skills.getByName('check_cause_list')?.id ?? 0);
    expect(steps.map((s) => s.target)).toEqual(['https://tshc.gov.in/', 'Daily Cause List']); // the part that worked, then the model's way
  });
});

describe('saving, answering the offer, changing and deleting routines', () => {
  const learned = (svc: MemoryService) => {
    for (let i = 0; i < 3; i += 1) {
      svc.beginTask('check cause list');
      svc.observeTool('open_website', { url: 'https://tshc.gov.in/' }, page());
      svc.observeTool('click_on_page', { text: 'Cause List' }, page());
      svc.finishTask(true);
    }
  };

  it('answer_routine_suggestion saves on yes, declines on no, and says when nothing was asked', async () => {
    const svc = open();
    expect(await tools.invoke('answer_routine_suggestion', { answer: 'yes' })).toMatchObject({ ok: false, summary: 'nothing pending' });
    learned(svc);
    expect(svc.hasPendingSuggestion()).toBe(true);
    expect(await tools.invoke('answer_routine_suggestion', { answer: 'yes' })).toMatchObject({ ok: true, summary: 'routine saved' });
    expect(svc.skills.count()).toBe(1);
    expect(await tools.invoke('answer_routine_suggestion', { answer: 'no' })).toMatchObject({ ok: false });
  });

  it('save_routine saves what was just done, and is honest when there is nothing to save', async () => {
    const svc = open();
    expect(await tools.invoke('save_routine', {})).toMatchObject({ ok: false, summary: 'not saved' });
    svc.beginTask('show the cause list');
    svc.observeTool('open_website', { url: 'https://tshc.gov.in/' }, page());
    svc.observeTool('click_on_page', { text: 'Cause List' }, page());
    svc.finishTask(true);
    const saved = await tools.invoke('save_routine', { name: 'morning list' });
    expect(saved).toMatchObject({ ok: true, data: { routine: 'morning list' } });
    expect(svc.skills.getByName('morning list')?.enabled).toBe(true);
  });

  it('update_routine switches a routine off and on, renames it, and edits its phrases', async () => {
    const svc = open();
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/')] });
    expect(await tools.invoke('update_routine', { routine: 'check cause list', enabled: false })).toMatchObject({ ok: true, data: { enabled: false } });
    expect(svc.matcher.match('check cause list')).toBeNull(); // off: not even matched
    await tools.invoke('update_routine', { routine: 'check_cause_list', enabled: true, add_phrase: 'court list please', name: 'court_list' });
    expect(svc.skills.getByName('court_list')?.enabled).toBe(true);
    expect(svc.matcher.match('court list please')?.skill.name).toBe('court_list');
    await tools.invoke('update_routine', { routine: 'court_list', remove_phrase: 'court list please' });
    expect(svc.matcher.match('court list please')).toBeNull();
    expect(await tools.invoke('update_routine', { routine: 'nope', enabled: true })).toMatchObject({ ok: false, summary: 'no such routine' });
    svc.skills.create({ name: 'other', triggers: ['do other'], steps: [step('open_app', 'Notepad')] });
    expect(await tools.invoke('update_routine', { routine: 'court_list', name: 'other' })).toMatchObject({ ok: false, summary: 'not changed' });
  });

  it('delete_routine asks first, deletes nothing without confirm, and deletes with it', async () => {
    const svc = open();
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/')] });
    const ask = await tools.invoke('delete_routine', { routine: 'check cause list' });
    expect(ask).toMatchObject({ ok: false, summary: 'needs confirmation', data: { status: 'permission_required', action: 'delete_routine' } });
    expect(ask.error).toContain('Do you want me to delete the routine "check cause list"?');
    expect(svc.skills.count()).toBe(1);
    expect(await tools.invoke('delete_routine', { routine: 'check cause list', confirm: false })).toMatchObject({ ok: false });
    expect(svc.skills.count()).toBe(1);
    expect(await tools.invoke('delete_routine', { routine: 'check cause list', confirm: true })).toMatchObject({ ok: true, summary: 'routine deleted' });
    expect(svc.skills.count()).toBe(0);
  });

  it('deleting a routine is a confirm-level action in the permission model, like deleting a file', () => {
    expect(riskLevelFor('delete_routine')).toBe('confirm');
  });

  it('list_routines describes each routine, its phrases, its steps and how it has gone', async () => {
    const svc = open();
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step('open_url', 'https://tshc.gov.in/'), step('click_text', 'Cause List')] });
    const r = await tools.invoke('list_routines', {});
    expect(r).toMatchObject({ ok: true, summary: '1 routine' });
    const routines = r.data?.['routines'] as Array<Record<string, unknown>>;
    expect(routines[0]).toMatchObject({ name: 'check_cause_list', enabled: true, phrases: ['check cause list'], timesRun: 0 });
    expect(routines[0]?.['steps']).toContain('click "Cause List"');
  });
});
