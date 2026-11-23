import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IpcChannels } from '../src/shared/ipcContract';

const source = readFileSync(join(__dirname, '..', 'src', 'main', 'cardPreload.ts'), 'utf8');

describe("the suggestion card's preload", () => {
  it('imports nothing but electron (a shared import makes the bundler split a file a sandboxed preload cannot load, which broke the whole app once)', () => {
    const imports = [...source.matchAll(/^import\s+(?!type\b)[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(imports).toEqual(['electron']);
  });

  it('spells out the same five channel names the app uses', () => {
    const names = Object.fromEntries([...source.matchAll(/^\s{2}(\w+): '([^']+)',?$/gm)].map((m) => [m[1], m[2]]));
    expect(names).toEqual({
      state: IpcChannels.writingCardState,
      ready: IpcChannels.writingCardReady,
      act: IpcChannels.writingCardAct,
      size: IpcChannels.writingCardSize,
      hide: IpcChannels.writingCardHide,
    });
  });

  it('exposes only what the card page uses', () => {
    const api = source.slice(source.indexOf('exposeInMainWorld'));
    const exposed = [...api.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(exposed).toEqual(['onState', 'ready', 'act', 'size', 'hide']);
  });
});
