import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { buildLiveConfig, runLiveTool } from '../src/main/live/liveBridge';
import { ToolRegistry } from '../src/main/tools/ToolRegistry';
import type { Tool } from '../src/main/tools/types';

function registry(): { tools: ToolRegistry; calls: Array<{ name: string; args: unknown }> } {
  const calls: Array<{ name: string; args: unknown }> = [];
  const tools = new ToolRegistry();
  const open: Tool = {
    schema: {
      name: 'open_application',
      description: 'open an app',
      args: { name: { type: 'string', required: true, description: 'which' } },
    },
    async execute(args) {
      calls.push({ name: 'open_application', args });
      return { ok: true, summary: 'open', data: { app: String(args['name']) } };
    },
  };
  tools.register(open);
  return { tools, calls };
}

const gemini = (url: string | null) => ({ liveUrl: () => url });
const NOW = () => new Date('2026-09-28T10:00:00Z');

describe('buildLiveConfig', () => {
  it('is null without a Gemini key, so Live is simply unavailable', () => {
    expect(buildLiveConfig({ gemini: gemini(null), tools: registry().tools }, 'Aoede')).toBeNull();
  });

  it('hands over the endpoint, models, voice, prompt and the same tools the typed path has', () => {
    const cfg = buildLiveConfig({ gemini: gemini('wss://example/live?key=K'), tools: registry().tools, env: {}, now: NOW }, 'Zephyr');
    expect(cfg?.url).toBe('wss://example/live?key=K');
    expect(cfg?.voice).toBe('Zephyr');
    expect(cfg?.models[0]).toBe('gemini-3.1-flash-live-preview');
    expect(cfg?.models).toContain('gemini-3.8-live');
    expect(cfg?.systemInstruction).toContain('Live conversation');
    expect(cfg?.systemInstruction).toContain('September 2026');
    expect(cfg?.tools.map((t) => t.name)).toEqual(['open_application']);
    expect(cfg?.tools[0]?.parameters).toMatchObject({ type: 'object', required: ['name'] });
  });

  it('lets EYA_LIVE_MODELS choose the models and their order', () => {
    const cfg = buildLiveConfig({ gemini: gemini('wss://x'), tools: registry().tools, env: { EYA_LIVE_MODELS: ' a , b ,, c ' } }, 'Aoede');
    expect(cfg?.models).toEqual(['a', 'b', 'c']);
  });

  it('never trusts the voice name it is given', () => {
    for (const bad of ['../../x', 'Aoede; drop', '', 5, null, undefined, 'x'.repeat(40)]) {
      expect(buildLiveConfig({ gemini: gemini('wss://x'), tools: registry().tools }, bad)?.voice, String(bad)).toBe('Aoede');
    }
  });
});

describe('runLiveTool', () => {
  it('runs the requested tool through the registry and returns its result as JSON', async () => {
    const { tools, calls } = registry();
    const out = await runLiveTool(tools, { name: 'open_application', args: { name: 'notepad' } });
    expect(calls).toEqual([{ name: 'open_application', args: { name: 'notepad' } }]);
    expect(JSON.parse(out.content)).toEqual({ ok: true, summary: 'open', data: { app: 'notepad' } });
  });

  it('applies the same argument checks as everywhere else', async () => {
    const { tools, calls } = registry();
    const missing = JSON.parse((await runLiveTool(tools, { name: 'open_application', args: {} })).content);
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/name/);
    const extra = JSON.parse((await runLiveTool(tools, { name: 'open_application', args: { name: 'x', sneaky: true } })).content);
    expect(extra.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports an unknown tool instead of crashing', async () => {
    const out = JSON.parse((await runLiveTool(registry().tools, { name: 'format_disk', args: {} })).content);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/No such tool/);
  });

  it('stops waiting on a tool that takes too long and says so, rather than leaving the model in silence', async () => {
    const tools = new ToolRegistry();
    tools.register({
      schema: { name: 'analyze_document', description: 'read a file', args: {} },
      execute: () => new Promise(() => undefined), // never answers
    });
    const started = Date.now();
    const out = JSON.parse((await runLiveTool(tools, { name: 'analyze_document', args: {} }, 30)).content);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/too long/);
  });

  it('does not cut off a tool that answers in time', async () => {
    const { tools, calls } = registry();
    const out = JSON.parse((await runLiveTool(tools, { name: 'open_application', args: { name: 'notepad' } }, 5_000)).content);
    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('survives malformed requests from the page', async () => {
    const { tools, calls } = registry();
    for (const bad of [null, undefined, 'open_application', 42, {}, { name: 5, args: {} }, { name: 'open_application' }, { name: 'open_application', args: null }, { name: 'open_application', args: [] }]) {
      const out = JSON.parse((await runLiveTool(tools, bad)).content);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(calls).toEqual([]);
  });
});
