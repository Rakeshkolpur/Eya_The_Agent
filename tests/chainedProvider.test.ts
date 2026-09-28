import { describe, it, expect } from 'vitest';
import { ChainedAIProvider } from '../src/main/providers/ai/ChainedAIProvider';
import type { AICompletion, AIProvider } from '../src/main/providers/ai/AIProvider';

function provider(name: string, outcome: AICompletion | Error): AIProvider {
  return {
    name,
    isReady: () => true,
    complete: async () => {
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

const answer = (text: string): AICompletion => ({ text, toolCalls: [] });

describe('ChainedAIProvider', () => {
  it('uses the first provider that works', async () => {
    const chain = new ChainedAIProvider([provider('a', answer('from a')), provider('b', answer('from b'))]);
    expect((await chain.complete([], [])).text).toBe('from a');
  });

  it('falls through to the backup when the primary fails', async () => {
    const chain = new ChainedAIProvider([provider('a', new Error('gemini http 503')), provider('b', answer('from b'))]);
    expect((await chain.complete([], [])).text).toBe('from b');
  });

  it("reports the primary's error, not the offline backup's, when both fail", async () => {
    const chain = new ChainedAIProvider([
      provider('gemini', new Error('gemini http 429: quota exceeded')),
      provider('ollama', new Error('fetch failed')),
    ]);
    await expect(chain.complete([], [])).rejects.toThrow(/429/);
  });

  it('needs at least one provider', () => {
    expect(() => new ChainedAIProvider([])).toThrow();
  });
});
