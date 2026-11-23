import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryService } from '../src/main/memory/MemoryService';
import type { MemoryEvent } from '../src/main/memory/MemoryService';
import { parseControl, parseRemember } from '../src/main/memory/controlCommands';
import { signatureOf, significantWords, SUGGEST_EVERY, withChecks } from '../src/main/memory/taskRecorder';
import type { ToolInvoker } from '../src/main/memory/skillExecutor';
import type { NewStep } from '../src/main/memory/types';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

const dirs: string[] = [];
const services: MemoryService[] = [];

class Clock {
  t = new Date(2026, 9, 4, 9, 0).getTime();
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  nextDay() {
    this.t += 24 * 3_600_000;
  }
}

const ok = (data: Record<string, unknown> = {}): ToolResult => ({ ok: true, summary: 'ok', data });
const pageResult = (p: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolResult =>
  ok({ currentPage: { url: 'https://tshc.gov.in/', title: 'Telangana High Court', headings: ['Welcome'], links: ['Cause List'], buttons: [], inputs: [], ...p }, ...extra });

class FakeTools implements ToolInvoker {
  calls: Array<{ name: string; args: ToolArgs }> = [];
  responder: (name: string, args: ToolArgs, n: number) => ToolResult = () => pageResult();
  async invoke(name: string, args: ToolArgs): Promise<ToolResult> {
    this.calls.push({ name, args });
    return this.responder(name, args, this.calls.filter((c) => c.name === name).length);
  }
}

function rig(opts: { isPrivateStep?: (s: NewStep) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eya-svc-'));
  dirs.push(dir);
  const clock = new Clock();
  const tools = new FakeTools();
  const events: MemoryEvent[] = [];
  const svc = MemoryService.open(join(dir, 'data', 'eya_memory.db'), {
    tools,
    now: clock.now,
    notify: (e) => events.push(e),
    sleep: async () => undefined,
    ...(opts.isPrivateStep !== undefined ? { isPrivateStep: opts.isPrivateStep } : {}),
  });
  services.push(svc);
  return { svc, clock, tools, events, dir };
}

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Call = [name: string, args: ToolArgs, result?: ToolResult];

/** Pretends Eya did a task: the user asked something, these tools ran, and it worked (or not). Returns the offer, if one is made. */
function task(svc: MemoryService, request: string, calls: Call[], succeeded = true): string | null {
  svc.beginTask(request);
  for (const [name, args, result] of calls) svc.observeTool(name, args, result ?? pageResult());
  return svc.finishTask(succeeded);
}

/** The cause-list task as a model would do it the first few times: find the site, open it, look around, click through. */
const causeList = (finalLinks: string[] = ['Entire Causelist']): Call[] => [
  ['web_search', { query: 'telangana high court' }, ok({ answer: 'tshc.gov.in' })],
  ['open_website', { url: 'https://tshc.gov.in/' }, pageResult()],
  ['inspect_page', {}, pageResult()],
  ['click_on_page', { text: 'Cause List' }, pageResult({ title: 'Cause List - High Court', headings: ['Cause List'], links: finalLinks })],
  ['find_on_page', { query: 'Entire Causelist' }, ok({ matches: [{ name: 'Entire Causelist' }] })],
  ['click_on_page', { text: 'Entire Causelist' }, pageResult({ title: 'Cause List - High Court', headings: ['Cause List', 'Entire Causelist'], links: [] })],
];

describe('noticing a task repeated, and offering to save it', () => {
  it('stays quiet for the first two successful runs and makes the offer on the third, in the words asked for', () => {
    const { svc, events } = rig();
    expect(task(svc, "Check today's Telangana High Court cause list", causeList())).toBeNull();
    expect(task(svc, 'check the high court cause list', causeList())).toBeNull();
    const offer = task(svc, 'Check todays cause list', causeList());
    expect(SUGGEST_EVERY).toBe(3);
    expect(offer).toBe("You've done this several times. Would you like me to save it as a routine?");
    expect(events).toContainEqual({ type: 'suggestion', text: offer });
    expect(svc.hasPendingSuggestion()).toBe(true);
    expect(svc.currentSuggestion()).toEqual({ text: offer, kind: 'save' });
  });

  it('does not count a run that failed, or one that did something a routine cannot repeat or must not learn', () => {
    const { svc } = rig();
    const sendsAMessage: Call[] = [...causeList(), ['fill_on_page', { label: 'Search', value: 'orders' }], ['delete_file', { path: 'C:\\x\\a.pdf' }]];
    for (let i = 0; i < 4; i += 1) expect(task(svc, 'check cause list', sendsAMessage)).toBeNull(); // a delete is in the task: never learned
    for (let i = 0; i < 4; i += 1) expect(task(svc, 'check cause list', causeList(), false)).toBeNull(); // it failed
    expect(svc.candidates.count()).toBe(0);
  });

  it('never learns from a chat app, a sign-in wait, a send, a screenshot or an isolated window', () => {
    const { svc } = rig({ isPrivateStep: (s) => /web\.whatsapp\.com/.test(s.target) });
    const attempts: Call[][] = [
      [['open_website', { url: 'https://web.whatsapp.com/' }], ['click_on_page', { text: 'Mum' }]],
      [['open_website', { url: 'https://tshc.gov.in/' }], ['wait_for_user_in_browser', {}], ['click_on_page', { text: 'Cause List' }]],
      [['open_website', { url: 'https://tshc.gov.in/' }], ['take_screenshot', { confirm: true }]],
      [['open_website', { url: 'https://tshc.gov.in/', isolated: true }], ['click_on_page', { text: 'Cause List' }]],
      [['open_website', { url: 'https://x.example/?token=abcdef' }], ['click_on_page', { text: 'Go' }]],
      [['open_website', { url: 'https://user:pw@x.example/' }], ['click_on_page', { text: 'Go' }]],
      [['open_website', { url: 'https://tshc.gov.in/' }], ['fill_on_page', { label: 'Password', value: 'x' }]],
      [['open_website', { url: 'https://tshc.gov.in/' }], ['find_chat', { query: 'Rahul' }]],
    ];
    for (const calls of attempts) for (let i = 0; i < 4; i += 1) expect(task(svc, 'do the thing', calls)).toBeNull();
    expect(svc.candidates.count()).toBe(0);
  });

  it('a lone "open Notepad" is not worth a routine (it is already instant), and a request holding a number or secret is not kept', () => {
    const { svc } = rig();
    for (let i = 0; i < 4; i += 1) expect(task(svc, 'open notepad', [['open_application', { name: 'Notepad' }, ok()]])).toBeNull();
    for (let i = 0; i < 4; i += 1) expect(task(svc, 'check case 9876543210 status', causeList())).toBeNull();
    for (let i = 0; i < 4; i += 1) expect(task(svc, 'check my password cause list', causeList())).toBeNull();
    expect(svc.candidates.count()).toBe(0);
  });

  it('looking around (inspect, find, read, scroll, search) neither counts as a step nor spoils the task — only the doing counts', () => {
    const { svc } = rig();
    const a: Call[] = [['open_website', { url: 'https://tshc.gov.in/' }], ['click_on_page', { text: 'Cause List' }]];
    const b: Call[] = [['web_search', { query: 'x' }, ok()], ['open_website', { url: 'https://tshc.gov.in/' }], ['inspect_page', {}], ['read_page', {}, ok()], ['scroll_page', { direction: 'down' }], ['click_on_page', { text: 'Cause List' }], ['find_on_page', { query: 'z' }, ok()]];
    task(svc, 'one', a);
    task(svc, 'two', b);
    expect(task(svc, 'three', a)).toContain('several times');
  });

  it('a repeated step in a row counts once, and a different path to the same goal is a different task', () => {
    const { svc } = rig();
    const clicksTwice: Call[] = [['open_website', { url: 'https://tshc.gov.in/' }], ['click_on_page', { text: 'Cause List' }], ['click_on_page', { text: 'Cause List' }]];
    const clicksOnce: Call[] = [['open_website', { url: 'https://tshc.gov.in/' }], ['click_on_page', { text: 'Cause List' }]];
    task(svc, 'a', clicksTwice);
    task(svc, 'b', clicksOnce);
    expect(task(svc, 'c', clicksTwice)).toContain('several times'); // all three are the same two steps
    const other: Call[] = [['open_website', { url: 'https://tshc.gov.in/' }], ['click_on_page', { text: 'Orders' }]];
    expect(task(svc, 'd', other)).toBeNull();
  });

  it('a task that types today\'s date is still the same task tomorrow: the date becomes a placeholder', () => {
    const { svc, clock } = rig();
    const typesDate = (d: string): Call[] => [['open_website', { url: 'https://tshc.gov.in/causelist' }], ['fill_on_page', { label: 'Date', value: d, submit: true }]];
    task(svc, 'cause list for today', typesDate('04-10-2026'));
    clock.nextDay();
    task(svc, 'cause list for today', typesDate('05-10-2026'));
    clock.nextDay();
    expect(task(svc, 'cause list for today', typesDate('06-10-2026'))).toContain('several times');
    const saved = svc.acceptSuggestion();
    expect(saved.ok).toBe(true);
    const skill = svc.skills.listDetails()[0];
    expect(skill?.steps[1]).toMatchObject({ action: 'type_text', target: 'Date', value: '{{today:dd-mm-yyyy}}', submit: true });
  });

  it('keeps the checks that make a saved routine safe: the site, and a word every run\'s last page had', () => {
    const { svc } = rig();
    task(svc, 'a', causeList());
    task(svc, 'b', causeList());
    task(svc, 'c', causeList());
    svc.acceptSuggestion();
    const steps = svc.skills.listDetails()[0]?.steps ?? [];
    expect(steps.map((s) => [s.action, s.target])).toEqual([['open_url', 'https://tshc.gov.in/'], ['click_text', 'Cause List'], ['click_text', 'Entire Causelist']]);
    expect(steps[0]).toMatchObject({ verifyKind: 'url_contains', verifyText: 'tshc.gov.in' });
    expect(steps[2]).toMatchObject({ verifyKind: 'page_contains' });
    expect(['cause', 'causelist', 'court'].some((w) => steps[2]?.verifyText === w || steps[2]?.verifyText.includes(w))).toBe(true);
  });

  it('asks again at every third success until the answer is "no" — and then never again', () => {
    const { svc } = rig();
    const run = () => task(svc, 'check cause list', causeList());
    expect([run(), run(), run() !== null, run(), run(), run() !== null]).toEqual([null, null, true, null, null, true]);
    svc.declineSuggestion();
    expect([run(), run(), run(), run(), run(), run()]).toEqual([null, null, null, null, null, null]);
  });

  it('does not offer to save what is already saved', () => {
    const { svc } = rig();
    task(svc, 'check cause list', causeList());
    task(svc, 'check cause list', causeList());
    task(svc, 'check cause list', causeList());
    svc.acceptSuggestion();
    for (let i = 0; i < 6; i += 1) expect(task(svc, 'check cause list', causeList())).toBeNull();
  });

  it('a task answered by a saved routine is not "new" and is never counted', () => {
    const { svc } = rig();
    svc.beginTask('check cause list');
    svc.observeTool('run_routine', { routine: 'x' }, ok());
    svc.observeTool('open_website', { url: 'https://tshc.gov.in/' }, pageResult());
    svc.observeTool('click_on_page', { text: 'Cause List' }, pageResult());
    expect(svc.finishTask(true)).toBeNull();
    expect(svc.candidates.count()).toBe(0);
  });

  it('keeps no conversation: the database holds a signature, the steps and the short wordings used — nothing about what was said around them', () => {
    const { svc } = rig();
    task(svc, "Check today's cause list", causeList());
    const sig = signatureOf(svc.recorder.lastTask()?.steps ?? []);
    const cand = svc.candidates.get(sig);
    expect(cand?.phrases).toEqual([{ norm: 'check todays cause list', text: "Check today's cause list", count: 1 }]);
    expect(cand?.steps.map((s) => s.action)).toEqual(['open_url', 'click_text', 'click_text']);
  });

  it('forgets one-off tasks that never repeated once they are stale', () => {
    const { svc, clock } = rig();
    task(svc, 'a one off', causeList());
    expect(svc.candidates.count()).toBe(1);
    clock.advance(60 * 86_400_000);
    task(svc, 'something else entirely', [['open_website', { url: 'https://example.org/' }], ['click_on_page', { text: 'Other' }]]);
    expect(svc.candidates.count()).toBe(1); // the old one was dropped, the new one kept
  });

  it('shows how checks are derived and which words are safe to rest one on', () => {
    expect(significantWords({ title: 'Cause List - High Court of Telangana', headings: ['Cause List', 'Home'] })).toEqual(['cause', 'court', 'telangana']);
    expect(significantWords(undefined)).toEqual([]);
    const steps: NewStep[] = [{ action: 'click_text', target: 'x', value: '', submit: false, verifyKind: 'none', verifyText: '' }];
    expect(withChecks(steps, ['court', 'telangana'])[0]).toMatchObject({ verifyKind: 'page_contains', verifyText: 'telangana' });
    expect(withChecks(steps, [])[0]).toMatchObject({ verifyKind: 'none' });
  });
});

describe('saying yes, saying no, and saving on request', () => {
  const learn = (svc: MemoryService) => {
    task(svc, "Check today's cause list", causeList());
    task(svc, 'check high court cause list', causeList());
    task(svc, "today's cause list", causeList());
  };

  it('"yes" saves the routine: named from the wording used, with the wordings as triggers, and says how to use it', async () => {
    const { svc } = rig();
    learn(svc);
    const out = await svc.tryHandle('yes please');
    expect(out).toMatchObject({ kind: 'answered', ok: true });
    expect(out?.kind === 'answered' && out.spoken).toContain('Saved as');
    const skill = svc.skills.listDetails()[0];
    expect(skill?.name).toBe('check_todays_cause_list');
    expect([...(skill?.triggers ?? [])].sort()).toEqual(["Check today's cause list", 'check high court cause list', "today's cause list"].sort());
    expect(svc.hasPendingSuggestion()).toBe(false);
    expect(svc.candidates.count()).toBe(0);
  });

  it('"no" declines it for good', async () => {
    const { svc } = rig();
    learn(svc);
    const out = await svc.tryHandle('no thanks');
    expect(out).toMatchObject({ kind: 'answered' });
    expect(svc.skills.count()).toBe(0);
    for (let i = 0; i < 6; i += 1) expect(task(svc, 'check cause list', causeList())).toBeNull();
  });

  it('"yes" with nothing pending is not memory\'s to answer — it goes to the normal agent (it may be about a file)', async () => {
    const { svc } = rig();
    expect(await svc.tryHandle('yes')).toBeNull();
    expect(await svc.tryHandle('no')).toBeNull();
  });

  it('an offer that was never answered runs out after ten minutes', async () => {
    const { svc, clock } = rig();
    learn(svc);
    clock.advance(11 * 60_000);
    expect(svc.hasPendingSuggestion()).toBe(false);
    expect(await svc.tryHandle('yes')).toBeNull();
    expect(svc.skills.count()).toBe(0);
  });

  it('"save this as a routine" after one run saves it straight away, and can be given a name', async () => {
    const { svc } = rig();
    task(svc, 'show me the cause list', causeList());
    const out = await svc.tryHandle('Save this as a routine called morning list');
    expect(out).toMatchObject({ kind: 'answered', ok: true });
    expect(svc.skills.listDetails()[0]).toMatchObject({ name: 'morning list', triggers: ['show me the cause list'] });
    // Saving it twice does not make a second copy.
    task(svc, 'show me the cause list', causeList());
    const again = await svc.tryHandle('save this as a routine');
    expect(again?.kind === 'answered' && again.spoken).toContain('already have that');
    expect(svc.skills.count()).toBe(1);
  });

  it('"save this as a routine" with nothing to save says so, and "remember this" asks what to remember', async () => {
    const { svc } = rig();
    expect((await svc.tryHandle('save this as a routine')) as { spoken: string }).toMatchObject({ ok: false });
    const what = await svc.tryHandle('remember this');
    expect(what?.kind === 'answered' && what.spoken).toContain('What should I remember');
  });

  it('"don\'t remember this" turns down the last task and the offer for it; with nothing to turn down it is left to the agent', async () => {
    const { svc } = rig();
    expect(await svc.tryHandle("don't remember this")).toBeNull();
    task(svc, 'check cause list', causeList());
    const out = await svc.tryHandle("don't remember this");
    expect(out?.kind === 'answered' && out.spoken).toContain("won't");
    expect(svc.recorder.lastTask()).toBeNull();
    for (let i = 0; i < 5; i += 1) expect(task(svc, 'check cause list', causeList())).toBeNull();
  });

  it('a name already taken gets a number, and a wording that already runs another routine is left out', async () => {
    const { svc } = rig();
    svc.skills.create({ name: 'check_todays_cause_list', triggers: ["check today's cause list"], steps: [{ action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    learn(svc);
    await svc.tryHandle('yes');
    const made = svc.skills.getByName('check_todays_cause_list_2');
    expect(made).toBeDefined();
    expect(svc.skills.triggersOf(made?.id ?? 0)).not.toContain("Check today's cause list");
    expect(svc.skills.triggersOf(made?.id ?? 0).length).toBeGreaterThan(0);
  });
});

describe('running a saved routine locally', () => {
  async function saved() {
    const r = rig();
    task(r.svc, "Check today's cause list", causeList());
    task(r.svc, 'check cause list', causeList());
    task(r.svc, "today's cause list", causeList());
    await r.svc.tryHandle('yes');
    r.tools.calls.length = 0;
    r.tools.responder = (name, args) =>
      name === 'click_on_page' && args['text'] === 'Entire Causelist'
        ? pageResult({ title: 'Cause List - High Court', headings: ['Cause List', 'Entire Causelist'], links: [] })
        : name === 'click_on_page'
          ? pageResult({ title: 'Cause List - High Court', headings: ['Cause List'], links: ['Entire Causelist'] })
          : pageResult();
    return r;
  }

  it('recognises the saved wording and just does it: the same tools, in order, no thinking', async () => {
    const { svc, tools } = await saved();
    const out = await svc.tryHandle('Hey Eya, could you check the todays cause list for me?');
    expect(out).toMatchObject({ kind: 'answered', ok: true, spoken: 'Done.', routine: 'check_todays_cause_list' });
    expect(tools.calls).toEqual([
      { name: 'open_website', args: { url: 'https://tshc.gov.in/' } },
      { name: 'click_on_page', args: { text: 'Cause List' } },
      { name: 'click_on_page', args: { text: 'Entire Causelist' } },
    ]);
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 1, successCount: 1, failureCount: 0 });
  });

  it('records each success, and a routine that was just run is not "learned" again', async () => {
    const { svc } = await saved();
    await svc.tryHandle('check cause list');
    await svc.tryHandle('check cause list');
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 2, successCount: 2 });
    expect(svc.candidates.count()).toBe(0);
  });

  it('a different date is a different request: "tomorrow\'s" does not run the routine saved for "today\'s"', async () => {
    const { svc, tools } = await saved();
    expect(await svc.tryHandle("check tomorrow's cause list")).toBeNull();
    expect(tools.calls).toEqual([]);
  });

  it('a disabled routine is not run, and runs again once enabled', async () => {
    const { svc, tools } = await saved();
    const id = svc.skills.getByName('check_todays_cause_list')?.id ?? 0;
    svc.skills.setEnabled(id, false);
    expect(await svc.tryHandle('check cause list')).toBeNull();
    expect(tools.calls).toEqual([]);
    const refused = await svc.runSkill(svc.skills.get(id) as never);
    expect(refused).toMatchObject({ kind: 'answered', ok: false });
    expect(tools.calls).toEqual([]);
    svc.skills.setEnabled(id, true);
    expect(await svc.tryHandle('check cause list')).toMatchObject({ kind: 'answered', ok: true });
  });

  it('when a check fails it stops, records the failure, and hands over to the normal agent with what it learned', async () => {
    const { svc, tools } = await saved();
    tools.responder = () => pageResult({ title: 'Site is down', headings: ['Maintenance'], links: [] });
    const out = await svc.tryHandle('check cause list');
    expect(out?.kind).toBe('handoff');
    if (out?.kind !== 'handoff') throw new Error('expected a handoff');
    expect(out.routine).toBe('check_todays_cause_list');
    expect(out.hint).toContain('stopped at step 3 of 3 (2 done)'); // the open and the first click had no check that could fail; the last click's check could
    expect(out.hint).toContain('click "Cause List"');
    expect(out.hint).toMatch(/never confirm anything for the user/);
    expect(out.replacing).toMatchObject({ name: 'check_todays_cause_list' });
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 1, successCount: 0, failureCount: 1 });
    const runs = svc.skills.recentRuns(svc.skills.getByName('check_todays_cause_list')?.id ?? 0);
    expect(runs[0]).toMatchObject({ outcome: 'verify_failed', failedStep: 3 });
  });

  it('when the loop guard stops a step (the same thing was just done several times), it says so plainly — no handoff, and the routine is not blamed', async () => {
    const { svc, tools } = await saved();
    tools.responder = (name) => (name === 'click_on_page' ? { ok: false, summary: 'repeating itself', error: 'tried 2 times', data: { loopDetected: true, currentPage: {} } } : pageResult());
    const out = await svc.tryHandle('check cause list');
    expect(out).toMatchObject({ kind: 'answered', ok: false, routine: 'check_todays_cause_list' });
    expect(out?.kind === 'answered' && out.spoken).toContain('a few times in a row');
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 0, successCount: 0, failureCount: 0 });
  });

  it('stops for a question the tools must ask the user, hands it to the agent, and counts it as neither a success nor a failure', async () => {
    const { svc, tools } = await saved();
    tools.responder = (name) => (name === 'click_on_page' ? { ok: false, summary: 'needs confirmation', error: 'Ask the user.', data: { status: 'permission_required', question: 'Send it?' } } : pageResult());
    const out = await svc.tryHandle('check cause list');
    expect(out).toMatchObject({ kind: 'handoff' });
    expect(out?.kind === 'handoff' && out.hint).toContain("it needs the user's say-so: Send it?");
    expect(out?.kind === 'handoff' && out.replacing).toBeUndefined(); // nothing is wrong with the routine
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 1, successCount: 0, failureCount: 0 });
  });

  it('after a failure, if the normal agent finds a better way that works, it offers to update the routine — and accepting replaces the steps', async () => {
    const { svc, tools } = await saved();
    tools.responder = () => pageResult({ title: 'Site is down', headings: ['Maintenance'], links: [] });
    const out = await svc.tryHandle('check cause list');
    if (out?.kind !== 'handoff' || out.replacing === undefined) throw new Error('expected a handoff to replace');
    svc.beginTask('check cause list', { replacing: out.replacing });
    const better: Call[] = [['open_website', { url: 'https://tshc.gov.in/new-home' }], ['click_on_page', { text: 'Daily Cause List' }, pageResult({ title: 'Daily Cause List', headings: ['Daily Cause List'] })]];
    for (const [n, a, r] of better) svc.observeTool(n, a, r ?? pageResult());
    const offer = svc.finishTask(true);
    expect(offer).toContain('update the routine "check_todays_cause_list"');
    expect(svc.currentSuggestion()?.kind).toBe('update');
    const accepted = await svc.tryHandle('yes');
    expect(accepted?.kind === 'answered' && accepted.spoken).toContain('updated');
    const skill = svc.skills.getByName('check_todays_cause_list');
    expect(svc.skills.stepsOf(skill?.id ?? 0).map((s) => s.target)).toEqual(['https://tshc.gov.in/new-home', 'Daily Cause List']);
    expect(skill?.name).toBe('check_todays_cause_list'); // the same routine, a better workflow
  });

  it('a failure that the agent then repeats the same way is not offered as an "update"', async () => {
    const { svc, tools } = await saved();
    tools.responder = () => pageResult({ title: 'Down', headings: [], links: [] });
    const out = await svc.tryHandle('check cause list');
    if (out?.kind !== 'handoff' || out.replacing === undefined) throw new Error('expected a handoff to replace');
    svc.beginTask('check cause list', { replacing: out.replacing });
    svc.observeTool('open_website', { url: 'https://tshc.gov.in/' }, pageResult());
    svc.observeTool('click_on_page', { text: 'Cause List' }, pageResult());
    svc.observeTool('click_on_page', { text: 'Entire Causelist' }, pageResult());
    expect(svc.finishTask(true)).toBeNull();
  });
});

describe('what the model is told', () => {
  it('gets every preference, the facts that share a word with the request, and the routines it can run', () => {
    const { svc } = rig();
    svc.memories.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    svc.memories.save('fact', 'Ravi', "Ravi is my brother's contact");
    svc.memories.save('fact', 'dentist', 'Dr Rao, Banjara Hills');
    svc.skills.create({ name: 'check_todays_cause_list', triggers: ["check today's cause list", 'high court cause list'], steps: [{ action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    const block = svc.promptBlock('call Ravi');
    expect(block).toContain('Preference: Always save downloaded PDFs to Desktop');
    expect(block).toContain("Fact: Ravi is my brother's contact");
    expect(block).not.toContain('dentist');
    expect(block).not.toContain('Banjara');
    expect(block).toContain('check today');
    expect(block).toContain('call run_routine');
    expect(block).toContain('"check today\'s cause list"');
    expect(svc.promptBlock('call Ravi', { forLive: true })).toContain('Banjara'); // a live session cannot be re-briefed per request, so it carries them all
  });

  it('is empty when there is nothing to say, and leaves a disabled routine out', () => {
    const { svc } = rig();
    expect(svc.promptBlock('anything')).toBe('');
    const s = svc.skills.create({ name: 'r', triggers: ['do r'], steps: [{ action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    svc.skills.setEnabled(s.id, false);
    expect(svc.promptBlock('anything')).toBe('');
  });

  it('points out a routine that is close to what was said but not sure enough to run alone', () => {
    const { svc } = rig();
    svc.skills.create({ name: 'orders', triggers: ['check pending orders list'], steps: [{ action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    expect(svc.possibleRoutineHint('check the pending order list please')).toBeNull(); // that one is sure enough to just run
    expect(svc.possibleRoutineHint('weather in paris')).toBeNull();
  });
});

describe('managing memory by voice, locally', () => {
  const said = (svc: MemoryService, text: string) => svc.tryHandle(text);
  const spoken = (o: Awaited<ReturnType<MemoryService['tryHandle']>>) => (o?.kind === 'answered' ? o.spoken : '(not handled)');

  it('"remember that…" keeps a fact or a preference; saying it again updates it; passwords are refused', async () => {
    const { svc } = rig();
    expect(spoken(await said(svc, "Remember that Ravi is my brother's contact"))).toBe("Okay, I'll remember that.");
    expect(svc.memories.getByKey('fact', 'ravi')?.value).toBe("Ravi is my brother's contact");
    expect(spoken(await said(svc, 'Always save downloaded PDFs to Desktop'))).toBe('(not handled)'); // without "remember", it is just a request
    expect(spoken(await said(svc, 'Remember: always save downloaded PDFs to Desktop'))).toBe("Okay, I'll remember that.");
    expect(svc.memories.list('preference')[0]).toMatchObject({ key: 'save downloaded pdfs', value: 'always save downloaded PDFs to Desktop' });
    expect(spoken(await said(svc, 'remember that I always save downloaded PDFs to Documents'))).toBe("Okay, I'll remember that.");
    expect(spoken(await said(svc, 'remember that my bank password is hunter2'))).toContain("don't keep passwords");
    expect(svc.memories.count()).toBe(3);
  });

  it('"what do you remember?" lists what is kept, and says plainly when it is nothing', async () => {
    const { svc } = rig();
    expect(spoken(await said(svc, 'What do you remember?'))).toContain("haven't been asked to remember anything");
    svc.memories.save('preference', 'pdfs', 'Always save PDFs to Desktop');
    svc.memories.save('fact', 'Ravi', 'Ravi is my brother');
    const text = spoken(await said(svc, 'what do you know about me'));
    expect(text).toContain('I remember 2 things');
    expect(text).toContain('Preference: Always save PDFs to Desktop');
    expect(text).toContain('Fact: Ravi is my brother');
  });

  it('"show my saved routines" lists them, with any that are switched off', async () => {
    const { svc } = rig();
    expect(spoken(await said(svc, 'show my routines'))).toContain('no saved routines');
    const step: NewStep = { action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' };
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step] });
    const b = svc.skills.create({ name: 'morning_news', triggers: ['morning news'], steps: [step] });
    svc.skills.setEnabled(b.id, false);
    expect(spoken(await said(svc, 'Show my saved routines'))).toBe('You have 2 routines: check cause list, morning news (off).');
  });

  it('"forget …" removes a memory; if nothing by that name is remembered it is left to the agent (never a guess)', async () => {
    const { svc } = rig();
    svc.memories.save('fact', 'Ravi', 'Ravi is my brother');
    svc.memories.save('fact', 'dentist', 'Dr Rao, Banjara Hills');
    expect(spoken(await said(svc, 'forget Ravi'))).toContain('forgotten');
    expect(svc.memories.getByKey('fact', 'ravi')).toBeUndefined();
    expect(spoken(await said(svc, 'forget about the dentist'))).toContain('forgotten');
    expect(svc.memories.count()).toBe(0);
    expect(spoken(await said(svc, 'forget Zorro'))).toBe('(not handled)');
  });

  it('"delete that file" is a file request, never a memory command', async () => {
    const { svc } = rig();
    svc.memories.save('fact', 'report', 'the quarterly report is on the desktop');
    for (const text of ['delete that file report.pdf', 'remove the report', 'delete report', 'delete the folder']) expect(spoken(await said(svc, text)), text).toBe('(not handled)');
    expect(svc.memories.count()).toBe(1);
  });

  it('"delete the routine X" asks first; yes deletes it, no keeps it', async () => {
    const { svc } = rig();
    const step: NewStep = { action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' };
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [step] });
    expect(spoken(await said(svc, 'delete the routine check cause list'))).toBe('Delete the routine "check_cause_list"? Say yes to confirm.');
    expect(svc.skills.count()).toBe(1);
    expect(spoken(await said(svc, 'no'))).toContain('keep');
    expect(svc.skills.count()).toBe(1);
    await said(svc, 'forget the routine check cause list');
    expect(spoken(await said(svc, 'yes'))).toBe('Deleted the routine "check_cause_list".');
    expect(svc.skills.count()).toBe(0);
  });

  it('"forget this routine" means the one just used; with none, it asks which', async () => {
    const { svc, tools } = rig();
    const step: NewStep = { action: 'open_url', target: 'https://example.org/', value: '', submit: false, verifyKind: 'none', verifyText: '' };
    svc.skills.create({ name: 'open_example', triggers: ['open example site'], steps: [step] });
    tools.responder = () => pageResult({ url: 'https://example.org/' });
    expect(spoken(await said(svc, 'forget this routine'))).toContain('Which routine?');
    await said(svc, 'open example site');
    expect(spoken(await said(svc, 'forget this routine'))).toBe('Delete the routine "open_example"? Say yes to confirm.');
    await said(svc, 'yes');
    expect(svc.skills.count()).toBe(0);
  });

  it('a confirmation that was never answered runs out, and does not swallow a later "yes"', async () => {
    const { svc, clock } = rig();
    const step: NewStep = { action: 'open_app', target: 'Notepad', value: '', submit: false, verifyKind: 'none', verifyText: '' };
    svc.skills.create({ name: 'r1', triggers: ['do r1'], steps: [step] });
    await said(svc, 'delete the routine r1');
    clock.advance(3 * 60_000);
    expect(await said(svc, 'yes')).toBeNull();
    expect(svc.skills.count()).toBe(1);
  });

  it('tells the panel whenever something changes, and describes everything for it', async () => {
    const { svc, events } = rig();
    await said(svc, 'remember that Ravi is my brother');
    expect(events).toContainEqual({ type: 'changed' });
    const snap = svc.snapshot();
    expect(snap.memories).toHaveLength(1);
    expect(snap.routines).toEqual([]);
    expect(snap.suggestion).toBeNull();
  });
});

describe('the memory phrases, parsed', () => {
  it('splits what to remember into a short key and the statement', () => {
    expect(parseRemember("Ravi is my brother's contact")).toEqual({ type: 'fact', key: 'ravi', value: "Ravi is my brother's contact" });
    expect(parseRemember('Always save downloaded PDFs to Desktop.')).toEqual({ type: 'preference', key: 'save downloaded pdfs', value: 'Always save downloaded PDFs to Desktop' });
    expect(parseRemember('I prefer Edge for banking')).toMatchObject({ type: 'preference', key: 'edge' });
    expect(parseRemember('the dentist is Dr Rao')).toMatchObject({ type: 'fact', key: 'the dentist' });
    expect(parseRemember('   ')).toBeNull();
  });

  it('knows the control phrases, and only takes a bare yes or no when something was asked', () => {
    expect(parseControl('what do you remember', false)).toEqual({ kind: 'list_memories' });
    expect(parseControl('Show my routines', false)).toEqual({ kind: 'list_routines' });
    expect(parseControl('what routines do I have?', false)).toEqual({ kind: 'list_routines' });
    expect(parseControl('forget this routine', false)).toEqual({ kind: 'forget_routine', name: null });
    expect(parseControl('delete the routine check cause list', false)).toEqual({ kind: 'forget_routine', name: 'check cause list' });
    expect(parseControl('save this as a routine', false)).toEqual({ kind: 'save_routine', name: null });
    expect(parseControl("don't remember this", false)).toEqual({ kind: 'dont_remember' });
    expect(parseControl('remember this', false)).toEqual({ kind: 'remember_this' });
    expect(parseControl('yes', false)).toBeNull();
    expect(parseControl('yes', true)).toEqual({ kind: 'yes' });
    expect(parseControl('No thanks', true)).toEqual({ kind: 'no' });
    expect(parseControl('open notepad', true)).toBeNull();
    expect(parseControl('', true)).toBeNull();
  });
});
