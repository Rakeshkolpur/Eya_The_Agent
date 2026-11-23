import { describe, it, expect } from 'vitest';
import { AgentEngine } from '../src/main/agent/AgentEngine';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { ResponseComposer } from '../src/main/agent/ResponseComposer';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import { ConversationContext } from '../src/main/context/ConversationContext';
import { buildLiveConfig } from '../src/main/live/liveBridge';
import { DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, isEyaLanguage, languageRule } from '../src/shared/language';
import type { EyaLanguage } from '../src/shared/language';
import type { AIChatMessage, AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';
import type { TTSProvider } from '../src/main/providers/tts/TTSProvider';

describe('one language rule for every AI', () => {
  it('is English unless the person chose otherwise, and there is a rule for each choice', () => {
    expect(DEFAULT_LANGUAGE).toBe('english');
    expect(LANGUAGE_OPTIONS.map((o) => o.id)).toEqual(['english', 'hindi', 'telugu', 'auto']);
    expect(languageRule('english')).toMatch(/always answer in English.*never switch language on your own/);
    expect(languageRule('hindi')).toMatch(/always answer in Hindi/);
    expect(languageRule('telugu')).toMatch(/always answer in Telugu/);
    expect(languageRule('auto')).toMatch(/language the person speaks.*never change language between replies/);
    expect(isEyaLanguage('telugu')).toBe(true);
    expect(isEyaLanguage('tamil')).toBe(false);
  });
});

describe('every AI is told the rule', () => {
  class Scripted implements AIProvider {
    readonly name = 'scripted';
    seen: AIChatMessage[] = [];
    isReady(): boolean {
      return true;
    }
    async complete(messages: readonly AIChatMessage[]): Promise<AICompletion> {
      this.seen = [...messages];
      return { text: 'ok', toolCalls: [] };
    }
  }
  const quiet: TTSProvider = { name: 'q', init: async () => undefined, speak: async () => undefined, stop: () => undefined, isReady: () => true, dispose: async () => undefined };

  async function systemFor(language?: EyaLanguage): Promise<string> {
    const ai = new Scripted();
    const engine = new AgentEngine({ router: new IntentRouter(), tools: new ToolRegistry(), composer: new ResponseComposer(), tts: quiet, context: new ConversationContext(), ai, ...(language !== undefined ? { language: () => language } : {}) });
    await engine.handle({ requestId: 'r', text: 'tell me a short fact about elephants', source: 'text' }, () => undefined);
    return String(ai.seen[0]?.content);
  }

  it('the written answers: English by default, and the chosen language when there is one', async () => {
    expect(await systemFor()).toContain(languageRule('english'));
    expect(await systemFor('telugu')).toContain(languageRule('telugu'));
    expect(await systemFor('auto')).toContain(languageRule('auto'));
    expect(await systemFor('telugu')).not.toContain(languageRule('english'));
  });

  it('the live voice: English by default, and the chosen language when there is one', () => {
    const tools = new ToolRegistry();
    const plain = buildLiveConfig({ gemini: { liveUrl: () => 'wss://x' }, tools }, 'Kore');
    expect(plain?.systemInstruction).toContain(languageRule('english'));
    const hindi = buildLiveConfig({ gemini: { liveUrl: () => 'wss://x' }, tools, language: () => 'hindi' }, 'Kore');
    expect(hindi?.systemInstruction).toContain(languageRule('hindi'));
    expect(hindi?.systemInstruction).not.toContain(languageRule('english'));
  });
});
