import { describe, expect, it } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { AUTO_LOOKS_PER_REQUEST, lookQuestion, newLookState, shouldLook, withScreenLook } from '../src/main/agent/autoLook';
import { ConversationContext } from '../src/main/context/ConversationContext';
import type { AIChatMessage, AICompletion, AIProvider, AIToolSpec } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/main/settings/appSettings';
import { cleanSettingsPatch } from '../src/main/windows/snapshots';
import type { AgentRequest, AgentResult } from '../src/shared/types';

const notFound = (text: string): ToolResult => ({ ok: false, summary: 'not found', error: `"${text}" isn't visible on the current page.` });
const fine: ToolResult = { ok: true, summary: 'clicked' };

describe('when the screen is looked at by herself', () => {
  it('a missing buying / cart / sign-in / checkout control is looked for at once; anything else on the second miss in a row', () => {
    for (const text of ['Buy at ₹14,249', 'Add to cart', 'Place order', 'Proceed to checkout', 'Login', 'Continue']) {
      expect(shouldLook(newLookState(), 'click_on_page', { text }, notFound(text)), text).toBe(true);
    }
    const s = newLookState();
    expect(shouldLook(s, 'click_on_page', { text: 'Lavender Frost' }, notFound('x'))).toBe(false);
    expect(shouldLook(s, 'click_on_page', { text: 'Lavender Frost' }, notFound('x'))).toBe(true);
  });

  it('a click that worked starts the count again; only a click or fill that found nothing counts', () => {
    const s = newLookState();
    expect(shouldLook(s, 'click_on_page', { text: 'Lavender Frost' }, notFound('x'))).toBe(false);
    expect(shouldLook(s, 'click_on_page', { text: 'Lavender Frost' }, fine)).toBe(false);
    expect(shouldLook(s, 'click_on_page', { text: 'Lavender Frost' }, notFound('x'))).toBe(false); // the first miss again, not the second
    expect(shouldLook(newLookState(), 'find_on_page', { text: 'Buy now' }, notFound('x'))).toBe(false); // (finding is not clicking)
    expect(shouldLook(newLookState(), 'inspect_page', { text: 'Buy now' }, notFound('x'))).toBe(false);
    expect(shouldLook(newLookState(), 'click_on_page', { text: 'Buy' }, { ok: false, summary: 'needs confirmation', error: 'ask' })).toBe(false);
    expect(shouldLook(newLookState(), 'fill_on_page', { label: 'Search' }, { ok: false, summary: 'not found', error: 'no field' })).toBe(false); // (a field that is not a deciding word: first miss)
    expect(shouldLook(newLookState(), 'fill_on_page', { label: 'Phone number to login' }, { ok: false, summary: 'not found', error: 'no field' })).toBe(true);
  });

  it(`never more than ${AUTO_LOOKS_PER_REQUEST} times for one request`, () => {
    const s = newLookState();
    let looks = 0;
    for (let i = 0; i < 6; i += 1) {
      if (shouldLook(s, 'click_on_page', { text: 'Buy now' }, notFound('Buy now'))) {
        looks += 1;
        s.looks += 1;
      }
    }
    expect(looks).toBe(AUTO_LOOKS_PER_REQUEST);
  });

  it('asks the picture a plain question about the control and what covers it; the answer is added to the failed step', () => {
    const q = lookQuestion('Buy at ₹14,249');
    expect(q).toMatch(/"Buy at ₹14,249" \(or the button that does that\)/);
    expect(q).toMatch(/pop-up, a sign-in box, a cookie notice/);
    const r = withScreenLook(notFound('Buy at ₹14,249'), 'A blue box reading Buy at ₹14,249 under the price.');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/isn't visible/);
    expect(r.error).toMatch(/looked at the screen myself, without asking the user.*blue box/);
    expect(r.data?.['screenLook']).toBe('A blue box reading Buy at ₹14,249 under the price.');
  });

  it('is a setting that is ON by default and survives being read back; only a real boolean changes it', () => {
    expect(DEFAULT_APP_SETTINGS.autoScreenLook).toBe(true);
    expect(parseAppSettings({ autoScreenLook: false }).autoScreenLook).toBe(false);
    expect(parseAppSettings({}).autoScreenLook).toBe(true);
    expect(parseAppSettings({ autoScreenLook: 'no' }).autoScreenLook).toBe(true);
    expect(cleanSettingsPatch({ autoScreenLook: false }).patch.autoScreenLook).toBe(false);
    expect(cleanSettingsPatch({ autoScreenLook: 'off' }).patch.autoScreenLook).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------------------------------ through the real engine
class Scripted implements AIProvider {
  readonly name = 'scripted';
  readonly sent: AIChatMessage[][] = [];
  constructor(private readonly script: AICompletion[]) {}
  isReady(): boolean {
    return true;
  }
  async complete(messages: readonly AIChatMessage[], _tools: readonly AIToolSpec[]): Promise<AICompletion> {
    this.sent.push([...messages]);
    const next = this.script.shift();
    if (next === undefined) throw new Error('script exhausted');
    return next;
  }
}
const quietTTS: TTSProvider = { name: 'quiet', init: async () => undefined, speak: async () => undefined, prefetch: () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };
const call = (name: string, args: ToolArgs, id = `c${Math.random().toString(36).slice(2, 6)}`): AICompletion => ({ text: '', toolCalls: [{ id, name, args }] });
const say = (text: string): AICompletion => ({ text, toolCalls: [] });
const ARGS = { text: { type: 'string' as const }, label: { type: 'string' as const }, query: { type: 'string' as const }, url: { type: 'string' as const } };
const tool = (name: string, respond: (args: ToolArgs) => ToolResult): Tool => ({ schema: { name, description: name, args: ARGS, status: `${name}…` }, execute: async (args) => respond(args) });

function engine(script: AICompletion[], autoLook?: (q: string) => Promise<string | null>, click: (a: ToolArgs) => ToolResult = (a) => notFound(String(a['text']))) {
  const ai = new Scripted(script);
  const tools = new ToolRegistry();
  tools.register(tool('click_on_page', click));
  tools.register(tool('fill_on_page', () => ({ ok: false, summary: 'not found', error: 'No field matching that is visible.' })));
  tools.register(tool('inspect_page', () => ({ ok: true, summary: 'page' })));
  tools.register(tool('open_website', () => ({ ok: true, summary: 'opened' })));
  const e = new AgentEngine({
    router: new IntentRouter(),
    tools,
    composer: new ResponseComposer(),
    tts: quietTTS,
    context: new ConversationContext(),
    ai,
    ...(autoLook !== undefined ? { autoLook } : {}),
    now: () => new Date('2026-11-07T10:00:00Z'),
  });
  return { e, ai };
}
const send = (e: AgentEngine, text: string): Promise<AgentResult> =>
  e.handle({ requestId: `r${Math.random().toString(36).slice(2, 6)}`, text, source: 'text', mode: 'agent' } as AgentRequest, () => undefined);
const toolMessages = (ai: Scripted): string[] => ai.sent.flatMap((m) => m.filter((x) => x.role === 'tool').map((x) => String(x.content)));

describe('a click that finds nothing, through the engine', () => {
  it('"Buy at ₹14,249" is not found → Eya looks at the screen herself, and the model\'s next step is made from what it shows', async () => {
    const questions: string[] = [];
    const s = engine(
      [call('click_on_page', { text: 'Buy at ₹14,249' }), say('The page shows a blue Buy button under the price; I will press that.')],
      async (q) => (questions.push(q), 'A blue box reading "Buy at ₹14,249" under the price, with an offers panel below it.'),
    );
    await send(s.e, 'press the buy button on this phone page');
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatch(/"Buy at ₹14,249"/);
    const seenByModel = toolMessages(s.ai).join('\n');
    expect(seenByModel).toMatch(/looked at the screen myself, without asking the user/);
    expect(seenByModel).toMatch(/blue box reading/);
  });

  it('nothing is looked at when the setting is off or it is not her business (the look answers null): the step is reported as it was', async () => {
    let asked = 0;
    const s = engine([call('click_on_page', { text: 'Buy now' }), say('I could not find it.')], async () => (asked++, null));
    await send(s.e, 'press the buy button on this phone page');
    expect(asked).toBe(1); // (asked once; it answered "no look")
    const seenByModel = toolMessages(s.ai).join('\n');
    expect(seenByModel).toMatch(/isn't visible on the current page/);
    expect(seenByModel).not.toMatch(/looked at the screen myself/);
  });

  it('a look that fails does not break the task', async () => {
    const s = engine([call('click_on_page', { text: 'Place order' }), say('Not found; I will tell you.')], async () => {
      throw new Error('no picture reader');
    });
    const r = await send(s.e, 'place the order on this page');
    expect(r.spoken ?? '').toMatch(/Not found/);
  });

  it('a click that works is never followed by a look; without the dependency nothing changes', async () => {
    let asked = 0;
    const ok = engine([call('click_on_page', { text: 'Add to cart' }), say('Added.')], async () => (asked++, 'x'), () => fine);
    await send(ok.e, 'add it to the cart');
    expect(asked).toBe(0);
    const none = engine([call('click_on_page', { text: 'Add to cart' }), say('Not found.')]);
    await send(none.e, 'add it to the cart');
    expect(toolMessages(none.ai).join('\n')).not.toMatch(/looked at the screen myself/);
  });

  it(`stops at ${AUTO_LOOKS_PER_REQUEST} looks even if the model keeps trying`, async () => {
    let asked = 0;
    const s = engine(
      [call('click_on_page', { text: 'Buy now' }), call('click_on_page', { text: 'Buy now' }), call('click_on_page', { text: 'Buy at ₹1' }), call('click_on_page', { text: 'Place order' }), say('Giving up.')],
      async () => (asked++, 'a blue box'),
    );
    await send(s.e, 'press the buy button on this phone page');
    expect(asked).toBe(AUTO_LOOKS_PER_REQUEST);
  });
});
