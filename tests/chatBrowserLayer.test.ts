import { describe, it, expect } from 'vitest';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import { CommunicationAccessError } from '../src/main/browser/errors';
import { normalizePageState, stateToSnapshot } from '../src/main/chrome/pageState';

function rawState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { url: 'https://chat.example/', title: 'Chat', epoch: 1, headings: [], elements: [], dialogs: [], visibleText: '', bodyText: '', tables: [], focused: null, scroll: { y: 0, max: 0, atBottom: true }, challenge: null, loading: false, notes: [], ...over };
}

class Bridge implements BridgeLike {
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  handler: (op: string, args: Record<string, unknown>) => unknown = () => ({});
  isConnected() {
    return true;
  }
  async request<T = unknown>(op: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> {
    this.calls.push({ op, args: { ...args } });
    const out = this.handler(op, args);
    if (out instanceof Error) throw out;
    return out as T;
  }
}

describe('what the page reports about a list row and about delivery marks', () => {
  it("keeps a row's first line as its primary name, and drops it when it is not text", () => {
    const s = normalizePageState({
      elements: [
        { id: 'e1.0', role: 'clickable', name: 'Rahul Sharma See you tomorrow 10:42', primary: 'Rahul Sharma', inViewport: true },
        { id: 'e1.1', role: 'clickable', name: 'Mum Call me', primary: 5, inViewport: true },
        { id: 'e1.2', role: 'clickable', name: 'Amit', primary: '', inViewport: true },
        { id: 'e1.3', role: 'clickable', name: 'Long', primary: 'x'.repeat(300), inViewport: true },
      ],
    });
    expect(s.elements[0]?.primary).toBe('Rahul Sharma');
    expect(s.elements[1]).not.toHaveProperty('primary');
    expect(s.elements[2]).not.toHaveProperty('primary');
    expect(s.elements[3]?.primary?.length).toBe(80);
  });

  it('carries delivery marks into the snapshot: only short words, at most six, and nothing when there are none', () => {
    const marked = stateToSnapshot(normalizePageState(rawState({ statuses: ['read', 'sent', 'pending', 'x'.repeat(100), 7, 'a', 'b', 'c'] })));
    expect(marked.messageStatus?.length).toBe(6);
    expect(marked.messageStatus?.every((m) => m.length <= 24)).toBe(true);
    expect(stateToSnapshot(normalizePageState(rawState())).messageStatus).toBeUndefined();
    expect(stateToSnapshot(normalizePageState(rawState({ statuses: 'nope' }))).messageStatus).toBeUndefined();
  });
});

describe("listItems: what can be clicked, for Eya's own code", () => {
  it('lists the named, showing, clickable things with their first line, and leaves out fields and closed-menu links', async () => {
    const bridge = new Bridge();
    bridge.handler = () => ({
      tabId: 3,
      state: rawState({
        elements: [
          { id: 'e1.0', role: 'clickable', name: 'Rahul Sharma ok 10:42', primary: 'Rahul Sharma', region: 'main', inViewport: true },
          { id: 'e1.1', role: 'input', name: 'Search', inViewport: true },
          { id: 'e1.2', role: 'link', name: 'Hidden', hidden: true, inViewport: false },
          { id: 'e1.3', role: 'button', name: 'Attach', inViewport: true },
          { id: 'e1.4', role: 'checkbox', name: 'Mute', inViewport: true },
        ],
      }),
    });
    const items = await new ChromeBrowserService(bridge).listItems();
    expect(items).toEqual([
      { name: 'Rahul Sharma ok 10:42', primary: 'Rahul Sharma', role: 'clickable', region: 'main' },
      { name: 'Attach', role: 'button' },
    ]);
  });
});

describe('attachFile: a file handed to the page in parts', () => {
  function rig(reply: (phase: string, args: Record<string, unknown>) => unknown) {
    const bridge = new Bridge();
    bridge.handler = (op, args) => (op === 'attach_file' ? reply(String(args['phase']), args) : {});
    return { bridge, svc: new ChromeBrowserService(bridge) };
  }
  const ok = { performed: { ok: true }, tabId: 7 };
  const file = Buffer.alloc(7 * 1024 * 1024 + 5, 1);
  const request = { name: 'report.pdf', mime: 'application/pdf', size: file.length, read: async (o: number, l: number) => file.subarray(o, o + l) };
  const committed = { performed: { ok: true }, tabId: 7, state: rawState({ title: 'Preview' }), settled: true };

  it('probes first, then begins, sends it in parts of at most 3 MB, and commits, all against the same tab', async () => {
    const { bridge, svc } = rig((phase) => (phase === 'commit' ? committed : ok));
    const result = await svc.attachFile(request);
    expect(result.ok).toBe(true);
    expect(bridge.calls.map((c) => c.args['phase'])).toEqual(['probe', 'begin', 'chunk', 'chunk', 'chunk', 'commit']);
    const chunks = bridge.calls.filter((c) => c.args['phase'] === 'chunk').map((c) => Buffer.from(String(c.args['data']), 'base64').length);
    expect(chunks).toEqual([3 * 1024 * 1024, 3 * 1024 * 1024, 1024 * 1024 + 5]);
    expect(chunks.reduce((a, b) => a + b, 0)).toBe(file.length);
    expect(new Set(bridge.calls.map((c) => c.args['id'])).size).toBe(1);
    expect(bridge.calls.slice(1).every((c) => c.args['tabId'] === 7)).toBe(true);
    expect(bridge.calls[1]?.args).toMatchObject({ name: 'report.pdf', mime: 'application/pdf', size: file.length });
    expect(bridge.calls.at(-1)?.args).toMatchObject({ prefer: 'auto' });
  });

  it('with no file picker it stops at the probe: the file is never sent across', async () => {
    const { bridge, svc } = rig(() => ({ performed: { ok: false, reason: 'no_file_input', detail: 'Open the attach menu.' }, tabId: 7 }));
    const result = await svc.attachFile(request);
    expect(result).toMatchObject({ ok: false, reason: 'no_file_input', message: 'Open the attach menu.' });
    expect(bridge.calls.map((c) => c.args['phase'])).toEqual(['probe']);
  });

  it('a picker that does not take this kind of file is reported as that', async () => {
    const { svc } = rig((phase) => (phase === 'commit' ? { performed: { ok: false, reason: 'type_not_accepted', detail: 'Not accepted.' }, tabId: 7, state: rawState() } : ok));
    expect(await svc.attachFile(request)).toMatchObject({ ok: false, reason: 'type_not_accepted' });
  });

  it('a page that stops taking the file part-way is reported, and nothing is committed', async () => {
    let n = 0;
    const { bridge, svc } = rig((phase) => (phase === 'chunk' && ++n === 2 ? { performed: { ok: false, detail: 'The page went away.' }, tabId: 7 } : ok));
    const result = await svc.attachFile(request);
    expect(result).toMatchObject({ ok: false, reason: 'failed', message: 'The page went away.' });
    expect(bridge.calls.some((c) => c.args['phase'] === 'commit')).toBe(false);
  });

  it('passes the "as document" choice to the page', async () => {
    const { bridge, svc } = rig((phase) => (phase === 'commit' ? committed : ok));
    await svc.attachFile({ ...request, size: 4, read: async () => Buffer.from('abcd'), prefer: 'document' });
    expect(bridge.calls.at(-1)?.args['prefer']).toBe('document');
  });

  it('an extension from before this existed is told to reload, in plain words', async () => {
    const { svc } = rig(() => new BridgeError('extension_error', 'Unknown request: attach_file'));
    const result = await svc.attachFile(request);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/reload/i);
  });

  it('an extension refusal because Communication Access is off is the usual refusal, not a failure to attach', async () => {
    const { svc } = rig(() => new BridgeError('extension_error', 'communication_access_off: web.whatsapp.com'));
    await expect(svc.attachFile(request)).rejects.toBeInstanceOf(CommunicationAccessError);
  });
});
