import { describe, it, expect } from 'vitest';
import { createClipboardTools } from '../src/main/tools/impl/clipboardTools';
import type { ClipboardLike } from '../src/main/tools/impl/clipboardTools';
import type { Tool, ToolArgs } from '../src/main/tools/types';

function fakeClipboard(initial = ''): ClipboardLike {
  let text = initial;
  return {
    readText: () => text,
    writeText: (t) => {
      text = t;
    },
    clear: () => {
      text = '';
    },
  };
}

function toolMap(clipboard: ClipboardLike): Record<string, Tool> {
  return Object.fromEntries(createClipboardTools(clipboard).map((t) => [t.schema.name, t]));
}

const call = (tool: Tool, args: ToolArgs = {}) => tool.execute(args);

describe('clipboard_read', () => {
  it('reads whatever text is on the clipboard', async () => {
    const tools = toolMap(fakeClipboard('hello there'));
    const result = await call(tools['clipboard_read']!);
    expect(result.ok).toBe(true);
    expect(result.data?.['text']).toBe('hello there');
  });

  it('reports an empty clipboard plainly, not as an error', async () => {
    const tools = toolMap(fakeClipboard(''));
    const result = await call(tools['clipboard_read']!);
    expect(result.ok).toBe(true);
    expect(result.data?.['empty']).toBe(true);
  });

  it('truncates very long clipboard text', async () => {
    const tools = toolMap(fakeClipboard('x'.repeat(10_000)));
    const result = await call(tools['clipboard_read']!);
    expect(result.data?.['truncated']).toBe(true);
    expect((result.data?.['text'] as string).length).toBeLessThan(10_000);
  });
});

describe('clipboard_write', () => {
  it('writes text and verifies it landed', async () => {
    const clipboard = fakeClipboard();
    const tools = toolMap(clipboard);
    const result = await call(tools['clipboard_write']!, { text: 'copied text' });
    expect(result.ok).toBe(true);
    expect(clipboard.readText()).toBe('copied text');
  });

  it('fails without text', async () => {
    const tools = toolMap(fakeClipboard());
    const result = await call(tools['clipboard_write']!, {});
    expect(result.ok).toBe(false);
  });

  it('reports failure honestly if the write did not actually take', async () => {
    const clipboard: ClipboardLike = {
      readText: () => 'unrelated',
      writeText: () => undefined, // pretend the OS silently dropped it
      clear: () => undefined,
    };
    const tools = toolMap(clipboard);
    const result = await call(tools['clipboard_write']!, { text: 'copied text' });
    expect(result.ok).toBe(false);
  });
});

describe('clipboard_clear', () => {
  it('empties the clipboard', async () => {
    const clipboard = fakeClipboard('something');
    const tools = toolMap(clipboard);
    const result = await call(tools['clipboard_clear']!);
    expect(result.ok).toBe(true);
    expect(clipboard.readText()).toBe('');
  });
});
