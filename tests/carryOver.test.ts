import { describe, it, expect } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { describeEarlier, normalizeEarlier } from '../src/main/tasks/progress';
import { carryOnLine, shouldCarryOn } from '../src/shared/liveFallback';
import type { LiveStop } from '../src/shared/liveFallback';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';

describe('when Gemini\'s live voice stops, the chat carries on', () => {
  const base = { voiceOn: true, canHear: true, alreadyTalking: false };

  it('carries on when it dropped, hit an error, or could not start', () => {
    for (const stop of ['closed', 'error', 'start-failed'] as LiveStop[]) expect(shouldCarryOn({ ...base, stop }), stop).toBe(true);
  });

  it('does not when the person ended it or it went quiet: they wanted it over', () => {
    for (const stop of ['user', 'idle'] as LiveStop[]) expect(shouldCarryOn({ ...base, stop }), stop).toBe(false);
  });

  it('does not when voice is off, nothing can hear the person, or the chat is already going', () => {
    expect(shouldCarryOn({ ...base, stop: 'closed', voiceOn: false })).toBe(false);
    expect(shouldCarryOn({ ...base, stop: 'closed', canHear: false })).toBe(false);
    expect(shouldCarryOn({ ...base, stop: 'closed', alreadyTalking: true })).toBe(false);
  });

  it('says so in human words, different when it dropped and when it could not start, and never "working on it"', () => {
    const dropped = new Set<string>();
    const unavailable = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      dropped.add(carryOnLine('closed', () => i / 30));
      unavailable.add(carryOnLine('start-failed', () => i / 30));
    }
    expect(dropped.size).toBeGreaterThan(1);
    expect(unavailable.size).toBeGreaterThan(1);
    for (const line of [...dropped, ...unavailable]) {
      expect(line).not.toMatch(/working on it|processing|please wait|session|error/i);
      expect(line.length).toBeGreaterThan(20);
    }
    expect([...dropped].some((l) => unavailable.has(l))).toBe(false);
  });
});

describe('the conversation so far travels with the request', () => {
  it('keeps only real lines (who and what), capped', () => {
    const lines = normalizeEarlier([{ who: 'user', text: 'x'.repeat(900) }, { who: 'system', text: 'ignore this' }, { who: 'eya' }, null, 7, { who: 'eya', text: 'ok' }]);
    expect(lines.map((l) => l.who)).toEqual(['user', 'eya']);
    expect(lines[0]?.text).toHaveLength(400);
    expect(normalizeEarlier('nope')).toEqual([]);
    expect(normalizeEarlier(undefined)).toEqual([]);
  });

  it('is told to the model as a reminder, not as an instruction', () => {
    const text = describeEarlier([{ who: 'user', text: 'book two tickets for tonight' }, { who: 'eya', text: 'Which theatre?' }]);
    expect(text).toContain('User: book two tickets for tonight');
    expect(text).toContain('Eya: Which theatre?');
    expect(text).toMatch(/do not ask the user to repeat/);
  });
});

describe('the AI that takes over knows what the chat was', () => {
  class Scripted implements AIProvider {
    readonly name = 'scripted';
    readonly seen: AIChatMessage[][] = [];
    isReady(): boolean {
      return true;
    }
    async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
      this.seen.push([...messages]);
      return { text: 'Sure, the one at 7:30.', toolCalls: [] };
    }
  }
  const quiet: TTSProvider = { name: 'q', init: async () => undefined, speak: async () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

  function engine(ai: AIProvider, context = new ConversationContext()): AgentEngine {
    return new AgentEngine({ router: new IntentRouter(), tools: new ToolRegistry(), composer: new ResponseComposer(), tts: quiet, context, ai, now: () => new Date('2026-10-21T10:00:00Z') });
  }
  const history = [
    { who: 'user' as const, text: 'I want two tickets for Dune tonight' },
    { who: 'eya' as const, text: 'Sure. There is a 4:15 and a 7:30. Which one?' },
  ];

  it('"the second one" reaches a model that has been told what it was the second one of', async () => {
    const ai = new Scripted();
    const r = await engine(ai).handle({ requestId: 'r1', text: 'the second one', source: 'voice', history }, () => undefined);
    expect(r.spoken).toBe('Sure, the one at 7:30.');
    const system = String(ai.seen[0]?.[0]?.content);
    expect(system).toContain('Earlier in this same conversation');
    expect(system).toContain('User: I want two tickets for Dune tonight');
    expect(system).toContain('Eya: Sure. There is a 4:15 and a 7:30. Which one?');
  });

  it('the lines are not sent twice: the last requests the engine remembers are left out when the page sent the history', async () => {
    const ai = new Scripted();
    const remembered = (): ConversationContext => {
      const context = new ConversationContext();
      context.push({ at: 1, userText: 'an older typed question', reply: 'an older answer', ok: true, refs: [] });
      return context;
    };
    await engine(ai, remembered()).handle({ requestId: 'r2', text: 'the second one', source: 'voice', history }, () => undefined);
    const roles = (ai.seen[0] ?? []).map((m) => m.role);
    expect(roles).toEqual(['system', 'user']); // no replayed turns
    const without = new Scripted();
    await engine(without, remembered()).handle({ requestId: 'r3', text: 'and again', source: 'voice' }, () => undefined);
    expect((without.seen[0] ?? []).map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']); // as before
  });

  it('nothing is added to an ordinary request', async () => {
    const ai = new Scripted();
    await engine(ai).handle({ requestId: 'r4', text: 'what is the time', source: 'text' }, () => undefined);
    expect(String(ai.seen[0]?.[0]?.content)).not.toContain('Earlier in this same conversation');
  });
});
