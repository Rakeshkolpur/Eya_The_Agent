import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import type { AgentMemory } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { MemoryService } from '../src/main/memory/MemoryService';
import { createMemoryTools } from '../src/main/tools/impl/memoryTools';
import type { AIChatMessage, AICompletion, AIProvider, AIToolCall } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import type { AgentUpdate } from '../src/shared/types';

const call = (name: string, args: Record<string, unknown> = {}): AIToolCall => ({ id: `id_${name}_${Math.random().toString(36).slice(2, 6)}`, name, args });
const step = (toolCalls: AIToolCall[], text = ''): AICompletion => ({ text, toolCalls });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });

class ScriptedAI implements AIProvider {
  readonly name = 'scripted';
  readonly seen: AIChatMessage[][] = [];
  constructor(private script: Array<AICompletion | Error>) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
    this.seen.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    if (next instanceof Error) throw next;
    return next;
  }
  get calls(): number {
    return this.seen.length;
  }
}

class FakeTTS implements TTSProvider {
  readonly name = 'fake';
  readonly spoken: string[] = [];
  init = async (): Promise<void> => undefined;
  speak = async (text: string): Promise<void> => {
    this.spoken.push(text);
  };
  stop = (): void => undefined;
  isReady = (): boolean => true;
  dispose = async (): Promise<void> => undefined;
}

const dirs: string[] = [];
const services: MemoryService[] = [];
let tools: ToolRegistry;
let toolLog: Array<{ name: string; args: ToolArgs }>;
let tts: FakeTTS;
let updates: AgentUpdate[];
/** What the pretend site does: by default every click lands on the right page; tests override this to break things. */
let site: (name: string, args: ToolArgs) => ToolResult;

const page = (extra: Record<string, unknown> = {}): ToolResult => ({
  ok: true,
  summary: 'ok',
  data: { currentPage: { url: 'https://tshc.gov.in/', title: 'Telangana High Court', headings: ['Welcome'], links: ['Cause List'], buttons: [], inputs: [], ...extra } },
});

const happySite = (name: string, args: ToolArgs): ToolResult => {
  if (name === 'click_on_page' && args['text'] === 'Cause List') return page({ title: 'Cause List - High Court', headings: ['Cause List'], links: ['Entire Causelist'] });
  if (name === 'click_on_page' && args['text'] === 'Entire Causelist') return page({ title: 'Cause List - High Court', headings: ['Cause List', 'Entire Causelist'], links: [] });
  if (name === 'click_on_page' && args['text'] === 'Daily Cause List') return page({ title: 'Daily Cause List - High Court', headings: ['Daily Cause List'], links: [] });
  return page();
};

function fake(name: string, schemaArgs: Tool['schema']['args']): Tool {
  return {
    schema: { name, description: name, args: schemaArgs, status: `running ${name}` },
    async execute(args) {
      toolLog.push({ name, args });
      return site(name, args);
    },
  };
}

interface Rig {
  readonly svc: MemoryService;
  readonly engine: AgentEngine;
}

function rig(ai: AIProvider | undefined, memory?: AgentMemory): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'eya-eng-'));
  dirs.push(dir);
  const svc = MemoryService.open(join(dir, 'data', 'eya_memory.db'), { tools, sleep: async () => undefined });
  services.push(svc);
  for (const t of createMemoryTools(svc)) tools.register(t);
  const engine = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts,
    context: new ConversationContext(),
    ...(ai !== undefined ? { ai } : {}),
    memory: memory ?? svc,
    now: () => new Date('2026-10-04T10:00:00Z'),
  });
  return { svc, engine };
}

const run = (engine: AgentEngine, text: string, live = false) =>
  engine.handle({ requestId: 'r1', text, source: live ? 'voice' : 'text', ...(live ? { live: true } : {}) }, (u) => updates.push(u));

const names = () => toolLog.map((c) => c.name);

/** What the model does for the cause-list request: open the site, click through, and report. */
const causeListRun = (): AICompletion[] => [
  step([call('open_website', { url: 'https://tshc.gov.in/' })]),
  step([call('click_on_page', { text: 'Cause List' })]),
  step([call('click_on_page', { text: 'Entire Causelist' })]),
  say("Here is today's cause list."),
];

beforeEach(() => {
  tools = new ToolRegistry();
  toolLog = [];
  tts = new FakeTTS();
  updates = [];
  site = happySite;
  tools.register(fake('open_website', { url: { type: 'string', required: true }, browser: { type: 'string' }, isolated: { type: 'boolean' } }));
  tools.register(fake('click_on_page', { text: { type: 'string', required: true }, confirm: { type: 'boolean' } }));
  tools.register(fake('inspect_page', {}));
  tools.register(fake('find_on_page', { query: { type: 'string' } }));
  tools.register(fake('open_application', { name: { type: 'string', required: true } }));
});

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the order: deterministic first, then saved routines, and only then the model', () => {
  it('"open notepad" is the instant app shortcut: memory is never asked and no model is called', async () => {
    const ai = new ScriptedAI([]);
    let asked = 0;
    const spy: AgentMemory = {
      tryHandle: async () => {
        asked += 1;
        return null;
      },
      beginTask: () => undefined,
      observeTool: () => undefined,
      finishTask: () => null,
      promptBlock: () => '',
      possibleRoutineHint: () => null,
    };
    const { engine } = rig(ai, spy);
    const t0 = performance.now();
    const result = await run(engine, 'open notepad');
    const ms = performance.now() - t0;
    expect(result.ok).toBe(true);
    expect(names()).toEqual(['open_application']);
    expect(asked).toBe(0);
    expect(ai.calls).toBe(0);
    expect(ms).toBeLessThan(250);
  });

  it('a command nobody saved still goes to the model, which does it with its normal tools', async () => {
    const ai = new ScriptedAI([step([call('open_website', { url: 'https://example.org/' })]), say('Opened the example site.')]);
    const { engine } = rig(ai);
    const result = await run(engine, 'open the example website');
    expect(ai.calls).toBe(2);
    expect(names()).toEqual(['open_website']);
    expect(result).toMatchObject({ ok: true, spoken: 'Opened the example site.' });
    expect(tts.spoken).toEqual(['Opened the example site.']);
  });

  it('a saved routine runs without any model call: the same tools, in order, "Done."', async () => {
    const ai = new ScriptedAI([]);
    const { engine, svc } = rig(ai);
    svc.skills.create({
      name: 'check_todays_cause_list',
      triggers: ["Check today's Telangana High Court cause list", 'check cause list'],
      steps: [
        { action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'url_contains', verifyText: 'tshc.gov.in' },
        { action: 'click_text', target: 'Cause List', value: '', submit: false, verifyKind: 'none', verifyText: '' },
        { action: 'click_text', target: 'Entire Causelist', value: '', submit: false, verifyKind: 'page_contains', verifyText: 'causelist' },
      ],
    });
    const t0 = performance.now();
    const result = await run(engine, "Hey Eya, check today's Telangana High Court cause list please");
    const ms = performance.now() - t0;
    expect(ai.calls).toBe(0); // the model was never asked
    expect(names()).toEqual(['open_website', 'click_on_page', 'click_on_page']);
    expect(toolLog.map((c) => c.args)).toEqual([{ url: 'https://tshc.gov.in/' }, { text: 'Cause List' }, { text: 'Entire Causelist' }]);
    expect(result).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(tts.spoken).toEqual(['Done.']);
    expect(svc.skills.getByName('check_todays_cause_list')).toMatchObject({ useCount: 1, successCount: 1 });
    expect(ms).toBeLessThan(500);
  });

  it('a routine that is switched off is not run: the request goes to the model like any other', async () => {
    const ai = new ScriptedAI([say('I am not sure how to do that.')]);
    const { engine, svc } = rig(ai);
    const s = svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [{ action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    svc.skills.setEnabled(s.id, false);
    await run(engine, 'check cause list');
    expect(names()).toEqual([]);
    expect(ai.calls).toBe(1);
  });

  it('memory commands are answered locally with no model: what you remember, your routines, remembering a fact', async () => {
    const ai = new ScriptedAI([]);
    const { engine, svc } = rig(ai);
    expect((await run(engine, 'Remember that Ravi is my brother\'s contact')).spoken).toBe("Okay, I'll remember that.");
    expect((await run(engine, 'what do you remember')).spoken).toContain("Fact: Ravi is my brother's contact");
    expect((await run(engine, 'show my routines')).spoken).toContain('no saved routines');
    expect(svc.memories.count()).toBe(1);
    expect(ai.calls).toBe(0);
  });

  it('what the user asked to remember, and the routines it can run, are given to the model', async () => {
    const ai = new ScriptedAI([say('Okay.')]);
    const { engine, svc } = rig(ai);
    svc.memories.save('preference', 'downloaded pdfs', 'Always save downloaded PDFs to Desktop');
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [{ action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'none', verifyText: '' }] });
    await run(engine, 'download the orders pdf from the court site');
    const system = ai.seen[0]?.[0]?.content ?? '';
    expect(system).toContain('Preference: Always save downloaded PDFs to Desktop');
    expect(system).toContain('call run_routine');
    expect(system).toContain('check cause list');
  });

  it('memory trouble never stops Eya answering: a memory that throws is skipped', async () => {
    const ai = new ScriptedAI([say('Sure thing.')]);
    const broken: AgentMemory = {
      tryHandle: async () => {
        throw new Error('database is locked');
      },
      beginTask: () => {
        throw new Error('boom');
      },
      observeTool: () => {
        throw new Error('boom');
      },
      finishTask: () => {
        throw new Error('boom');
      },
      promptBlock: () => {
        throw new Error('boom');
      },
      possibleRoutineHint: () => {
        throw new Error('boom');
      },
    };
    const { engine } = rig(ai, broken);
    const result = await run(engine, 'tell me a joke');
    expect(result).toMatchObject({ ok: true, spoken: 'Sure thing.' });
  });

  it('and with no memory at all, nothing changes', async () => {
    const ai = new ScriptedAI([say('Hello.')]);
    const engine = new AgentEngine({ router: new IntentRouter(), tools, composer: new ResponseComposer(), tts, context: new ConversationContext(), ai });
    expect((await run(engine, 'say hello')).spoken).toBe('Hello.');
  });
});

describe('always-on listening', () => {
  it('a routine whose wording starts like chatter ("today\'s cause list") still runs, and a bare "yes" answers a pending offer', async () => {
    const ai = new ScriptedAI([...causeListRun(), ...causeListRun(), ...causeListRun()]);
    const { engine, svc } = rig(ai);
    await run(engine, "today's cause list");
    await run(engine, "today's cause list");
    const third = await run(engine, "today's cause list");
    expect(third.spoken).toContain("You've done this several times. Would you like me to save it as a routine?");
    const saved = await run(engine, 'yes', true); // always-on: "yes" is normally dropped as chatter
    expect(saved.spoken).toContain('Saved as');
    expect(svc.skills.count()).toBe(1);
    const callsBefore = ai.calls;
    const again = await run(engine, "today's cause list", true);
    expect(again).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(ai.calls).toBe(callsBefore);
  });

  it('without a pending question a bare "yes" is still dropped as chatter, and a long ramble never reaches memory', async () => {
    const ai = new ScriptedAI([]);
    let asked = 0;
    const spy: AgentMemory = { tryHandle: async () => (asked += 1, null), beginTask: () => undefined, observeTool: () => undefined, finishTask: () => null, promptBlock: () => '', possibleRoutineHint: () => null };
    const { engine } = rig(ai, spy);
    expect((await run(engine, 'yes', true)).error).toBe('ignored');
    expect(asked).toBe(1); // memory was asked about "yes" (and said no); the chatter filter then dropped it
    const ramble = 'so yesterday I was telling my brother that the cause list at the high court never loads when I need it most';
    expect((await run(engine, ramble, true)).error).toBe('ignored');
    expect(asked).toBe(1); // too long to be a command: memory is not asked, and neither is the model
    expect(ai.calls).toBe(0);
  });
});

describe('learning a repeated task, end to end', () => {
  it('the third time the same task works, Eya asks; "yes" saves it; the fourth time she just does it with no model', async () => {
    const ai = new ScriptedAI([...causeListRun(), ...causeListRun(), ...causeListRun()]);
    const { engine, svc } = rig(ai);

    const first = await run(engine, "Check today's Telangana High Court cause list");
    expect(first.spoken).toBe("Here is today's cause list.");
    const second = await run(engine, 'check the high court cause list');
    expect(second.spoken).toBe("Here is today's cause list.");
    expect(svc.skills.count()).toBe(0);

    const third = await run(engine, 'check todays cause list');
    expect(third.spoken).toBe("Here is today's cause list. You've done this several times. Would you like me to save it as a routine?");
    expect(tts.spoken.at(-1)).toBe(third.spoken); // she says the offer out loud, in the same breath

    const yes = await run(engine, 'yes please');
    expect(yes.spoken).toContain('Saved as "check todays telangana high court cause list"'); // named from the first wording used
    const routine = svc.skills.listDetails()[0];
    expect(routine?.steps.map((s) => `${s.action}:${s.target}`)).toEqual(['open_url:https://tshc.gov.in/', 'click_text:Cause List', 'click_text:Entire Causelist']);
    expect(routine?.triggers).toHaveLength(3);

    // Now it is hers: no model.
    const calls = ai.calls;
    toolLog.length = 0;
    const fourth = await run(engine, "Check today's Telangana High Court cause list");
    expect(fourth).toMatchObject({ ok: true, spoken: 'Done.' });
    expect(ai.calls).toBe(calls);
    expect(names()).toEqual(['open_website', 'click_on_page', 'click_on_page']);
    expect(svc.skills.getByName(routine?.name ?? '')).toMatchObject({ useCount: 1, successCount: 1 });
  });

  it('"no" turns it down for good: she never asks again', async () => {
    const ai = new ScriptedAI(Array.from({ length: 9 }, causeListRun).flat());
    const { engine, svc } = rig(ai);
    for (let i = 0; i < 2; i += 1) await run(engine, 'check cause list');
    const third = await run(engine, 'check cause list');
    expect(third.spoken).toContain('save it as a routine');
    expect((await run(engine, 'no thanks')).spoken).toBe("Okay, I won't ask about that again.");
    for (let i = 0; i < 4; i += 1) expect((await run(engine, 'check cause list')).spoken).toBe("Here is today's cause list.");
    expect(svc.skills.count()).toBe(0);
  });

  it('a task that fails, or ends asking the user something, is not counted and gets no offer', async () => {
    const asks = (): AICompletion[] => [step([call('open_website', { url: 'https://tshc.gov.in/' })]), step([call('click_on_page', { text: 'Cause List' })]), say('Which court do you mean?')];
    const ai = new ScriptedAI([...asks(), ...asks(), ...asks(), ...asks()]);
    const { engine, svc } = rig(ai);
    for (let i = 0; i < 4; i += 1) expect((await run(engine, 'open cause list')).spoken).toBe('Which court do you mean?');
    expect(svc.candidates.count()).toBe(0);
  });

  it('the model can ask for a saved routine itself with run_routine, and nothing is learned from that', async () => {
    const ai = new ScriptedAI([step([call('run_routine', { routine: 'check cause list' })]), say('Done, the list is open.')]);
    const { engine, svc } = rig(ai);
    svc.skills.create({ name: 'check_cause_list', triggers: ['check cause list'], steps: [{ action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'url_contains', verifyText: 'tshc.gov.in' }] });
    // Said in a way the matcher alone is not sure enough to run, so it goes to the model, which calls the tool.
    const result = await run(engine, 'could you maybe pull up that court listing thing');
    expect(result.spoken).toBe('Done, the list is open.');
    expect(names()).toEqual(['open_website']);
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ useCount: 1, successCount: 1 });
    expect(svc.candidates.count()).toBe(0);
  });
});

describe('when a routine cannot finish', () => {
  async function withRoutine() {
    const ai = new ScriptedAI([]);
    const r = rig(ai);
    r.svc.skills.create({
      name: 'check_cause_list',
      triggers: ['check cause list'],
      steps: [
        { action: 'open_url', target: 'https://tshc.gov.in/', value: '', submit: false, verifyKind: 'url_contains', verifyText: 'tshc.gov.in' },
        { action: 'click_text', target: 'Cause List', value: '', submit: false, verifyKind: 'none', verifyText: '' },
        { action: 'click_text', target: 'Entire Causelist', value: '', submit: false, verifyKind: 'page_contains', verifyText: 'causelist' },
      ],
    });
    return { ...r, ai };
  }

  it('a failed check stops it, records the failure, and the normal agent carries on from there — then offers to update the routine', async () => {
    const { engine, svc, ai } = await withRoutine();
    site = (name, args) => (name === 'click_on_page' && args['text'] === 'Entire Causelist' ? page({ title: 'Page not found', headings: ['404'], links: [] }) : happySite(name, args));
    ai['script'].push(step([call('click_on_page', { text: 'Daily Cause List' })]), say("Here is today's list."));
    toolLog.length = 0;
    const result = await run(engine, 'check cause list');

    // The routine ran its three steps, looked twice more at the page it did not expect (inspect_page), and stopped; then the model finished the job with one more click.
    expect(names()).toEqual(['open_website', 'click_on_page', 'click_on_page', 'inspect_page', 'inspect_page', 'click_on_page']);
    expect(ai.calls).toBe(2);
    const system = ai.seen[0]?.[0]?.content ?? '';
    expect(system).toContain('A saved routine, "check_cause_list", was started for this request and stopped at step 3 of 3 (2 done)');
    expect(system).toContain('never confirm anything for the user');
    expect(ai.seen[0]?.at(-1)).toMatchObject({ role: 'user', content: 'check cause list' }); // the user is not asked to repeat anything
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ useCount: 1, failureCount: 1, successCount: 0 });
    expect(result.spoken).toBe("Here's today's list. That worked a little differently this time. Would you like me to update the routine \"check_cause_list\" with what I just did?".replace("Here's", 'Here is'));

    // Yes: the routine becomes the steps that worked — the ones before the break, then the model's own.
    expect((await run(engine, 'yes')).spoken).toContain('updated');
    const steps = svc.skills.stepsOf(svc.skills.getByName('check_cause_list')?.id ?? 0);
    expect(steps.map((s) => s.target)).toEqual(['https://tshc.gov.in/', 'Cause List', 'Daily Cause List']);
  });

  it('a routine that needs the user\'s say-so hands the question to the agent, and never confirms for them', async () => {
    const { engine, svc, ai } = await withRoutine();
    site = (name, args) => (name === 'click_on_page' && args['text'] === 'Cause List' ? { ok: false, summary: 'needs confirmation', error: 'Ask the user.', data: { status: 'permission_required', question: 'Submit the form?' } } : happySite(name, args));
    ai['script'].push(say('This would submit the form. Shall I go ahead?'));
    toolLog.length = 0;
    const result = await run(engine, 'check cause list');
    expect(result.spoken).toBe('This would submit the form. Shall I go ahead?');
    expect(toolLog.every((c) => c.args['confirm'] === undefined)).toBe(true); // a routine never says yes for the user
    expect(ai.seen[0]?.[0]?.content).toContain("it needs the user's say-so: Submit the form?");
    expect(svc.skills.getByName('check_cause_list')).toMatchObject({ useCount: 1, successCount: 0, failureCount: 0 });
    expect(svc.candidates.count()).toBe(0);
  });
});
