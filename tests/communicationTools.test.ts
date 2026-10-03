import { describe, it, expect } from 'vitest';
import { createCommunicationStatusTool } from '../src/main/tools/impl/communicationTools';
import { COMMUNICATION_OFF, CommunicationPolicy } from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';
import { communicationBlockedSnapshot } from '../src/main/privacy/redactSnapshot';
import { unavailable } from '../src/main/tools/impl/browserTools';
import { BrowserUnavailableError, CommunicationAccessError } from '../src/main/browser/errors';
import { ChromeBrowserService } from '../src/main/chrome/ChromeBrowserService';
import type { BridgeLike } from '../src/main/chrome/ChromeBrowserService';
import { BridgeError } from '../src/main/chrome/ChromeBridge';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import { riskLevelFor } from '../src/main/permissions/PermissionManager';

const policyOf = (s: CommunicationSettings) => new CommunicationPolicy(() => s);

describe('communication_access_status — read-only, by design', () => {
  it('says it is off by default, and that only the user can change it', async () => {
    const tool = createCommunicationStatusTool(policyOf(COMMUNICATION_OFF));
    const result = await tool.execute({});
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Communication Access is off');
    expect(result.data).toMatchObject({ communicationAccess: 'off' });
    expect(String(result.data?.['howToChange'])).toMatch(/Only the user/);
    const apps = result.data?.['apps'] as Array<{ app: string; allowed: boolean }>;
    expect(apps.every((a) => a.allowed === false)).toBe(true);
    expect(apps.map((a) => a.app)).toEqual(expect.arrayContaining(['WhatsApp', 'Telegram', 'Instagram']));
  });

  it('shows which apps are allowed when it is on', async () => {
    const tool = createCommunicationStatusTool(policyOf({ enabled: true, apps: { instagram: false } }));
    const result = await tool.execute({});
    expect(result.summary).toBe('Communication Access is on');
    const apps = result.data?.['apps'] as Array<{ app: string; allowed: boolean }>;
    expect(apps.find((a) => a.app === 'WhatsApp')?.allowed).toBe(true);
    expect(apps.find((a) => a.app === 'Instagram')?.allowed).toBe(false);
  });

  it('takes no arguments and has no way to change anything: there is no switch-on tool at all', () => {
    const tool = createCommunicationStatusTool(policyOf(COMMUNICATION_OFF));
    expect(tool.schema.args).toEqual({});
    expect(tool.schema.name).toBe('communication_access_status');
    // Nothing the model can call turns it on; the description says so, and the permission list agrees.
    expect(tool.schema.description).toMatch(/cannot change it/i);
  });

  it('is a safe (no-confirmation) tool, since it only reads a setting', () => {
    expect(riskLevelFor('communication_access_status')).toBe('safe');
  });
});

describe('what the model sees in place of a chat page', () => {
  const page: PageSnapshot = {
    url: 'https://web.whatsapp.com/send?phone=919876543210',
    title: '(2) Rahul Sharma',
    headings: ['Chats'],
    links: ['Rahul Sharma', 'Mum'],
    buttons: ['Send', 'Attach'],
    inputs: [{ label: 'Type a message', value: 'my password is hunter2' } as never],
    dialogs: ['Call from Mum'],
    truncated: true,
    environment: 'your_browser',
  };

  it('keeps only the app and its origin: no names, no phone numbers, no text, no buttons', () => {
    const redacted = communicationBlockedSnapshot(page, 'WhatsApp');
    expect(redacted).toMatchObject({ url: 'https://web.whatsapp.com', title: 'WhatsApp', headings: [], links: [], buttons: [], inputs: [], dialogs: [], environment: 'your_browser' });
    const json = JSON.stringify(redacted);
    for (const secret of ['Rahul', 'Mum', '919876543210', 'hunter2', 'Chats', 'Call from']) expect(json).not.toContain(secret);
    expect(redacted.notes?.[0]).toMatch(/Communication Access is off/);
  });

  it('copes with an address it cannot parse', () => {
    expect(communicationBlockedSnapshot({ ...page, url: '' }, 'Telegram').url).toBe('');
  });
});

describe('reporting a refusal to the model', () => {
  it('says "privacy switch is off", not "the browser is gone", and that nothing was read', () => {
    const result = unavailable(new CommunicationAccessError('WhatsApp'));
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('communication access is off');
    expect(result.data).toEqual({ communicationAccess: 'off', app: 'WhatsApp', nothingWasRead: true });
    expect(result.error).toMatch(/Chats switch/);
    expect(result.error).toMatch(/you cannot turn it on yourself/);
  });

  it('is still a browser-unavailable error, so every older catch site handles it; ordinary ones are unchanged', () => {
    expect(new CommunicationAccessError('X')).toBeInstanceOf(BrowserUnavailableError);
    const plain = unavailable(new BrowserUnavailableError('gone', { why: 'not_connected' }));
    expect(plain.summary).toBe('browser not connected');
    expect(plain.data).toMatchObject({ browserUnavailable: true, why: 'not_connected' });
  });
});

describe('the extension refusing a chat tab becomes the same refusal on Eya\'s side', () => {
  const bridgeThatThrows = (err: Error): BridgeLike => ({ isConnected: () => true, request: async () => Promise.reject(err) });

  it('maps the extension\'s error to the app by name', async () => {
    const svc = new ChromeBrowserService(bridgeThatThrows(new BridgeError('extension_error', 'communication_access_off: web.whatsapp.com')));
    const err = await svc.inspectPage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommunicationAccessError);
    expect((err as CommunicationAccessError).app).toBe('WhatsApp');
  });

  it('names an unknown host by the host itself', async () => {
    const svc = new ChromeBrowserService(bridgeThatThrows(new BridgeError('extension_error', 'communication_access_off: chat.example.org')));
    const err = (await svc.inspectPage().catch((e: unknown) => e)) as CommunicationAccessError;
    expect(err.app).toBe('chat.example.org');
  });

  it('leaves every other extension error exactly as it was', async () => {
    const svc = new ChromeBrowserService(bridgeThatThrows(new BridgeError('extension_error', 'something else broke')));
    const err = await svc.inspectPage().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CommunicationAccessError);
    expect((err as Error).message).toMatch(/something else broke/);
  });
});
