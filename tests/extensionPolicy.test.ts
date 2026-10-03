import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMUNICATION_APPS, COMMUNICATION_OFF, CommunicationPolicy } from '../src/main/privacy/communicationAccess';

const root = join(process.cwd(), 'eya-chrome-extension');

interface ExtensionPolicy {
  setBlocked(list: unknown): number;
  blockedHostFor(url: string): Promise<string | null>;
  blockedHostForSync(url: string): string | null;
  CommunicationAccessOff: new (host: string) => Error & { host: string };
}

let ext: ExtensionPolicy;
let stored: Record<string, unknown> = {};

beforeAll(() => {
  // Run the REAL file's text, with a stand-in for the browser's session storage. (It is an ES module only to be imported
  // by the other extension files, so its `export` keywords are dropped and its four exports handed back instead.)
  const source = readFileSync(join(root, 'policy.js'), 'utf8').replace(/^export\s+/gm, '');
  const chrome = {
    storage: {
      session: {
        get: async (key: string) => ({ [key]: stored[key] }),
        set: async (items: Record<string, unknown>) => void Object.assign(stored, items),
      },
    },
  };
  ext = new Function('chrome', `${source}\nreturn { setBlocked, blockedHostFor, blockedHostForSync, CommunicationAccessOff };`)(chrome) as ExtensionPolicy;
});

const DESKTOP_RULES = COMMUNICATION_APPS.flatMap((a) => a.hosts).map((h) => ({ host: h.host, ...(h.pathPrefix !== undefined ? { pathPrefix: h.pathPrefix } : {}) }));
const key = (r: { host: string; pathPrefix?: string }) => `${r.host}${r.pathPrefix ?? ''}`;

describe("the extension's chat-app list matches Eya's (they cannot drift apart)", () => {
  it('has exactly the same hosts and path limits as the catalogue in the desktop app', () => {
    const source = readFileSync(join(root, 'policy.js'), 'utf8');
    const literal = /const DEFAULT_BLOCKED = (\[[\s\S]*?\]);/.exec(source)?.[1];
    expect(literal).toBeDefined();
    const inExtension = new Function(`return ${literal as string}`)() as Array<{ host: string; pathPrefix?: string }>;
    expect(inExtension.map(key).sort()).toEqual(DESKTOP_RULES.map(key).sort());
  });

  it('before Eya has said anything, the extension refuses every chat app (fail closed)', () => {
    for (const rule of DESKTOP_RULES) {
      expect(ext.blockedHostForSync(`https://${rule.host}${rule.pathPrefix ?? '/'}`), key(rule)).toBe(rule.host);
    }
  });
});

describe('the extension decides exactly as Eya does', () => {
  const urls = [
    'https://web.whatsapp.com/',
    'https://web.whatsapp.com/send?phone=123',
    'https://web.telegram.org/k/#@someone',
    'https://www.instagram.com/direct/inbox/',
    'https://instagram.com/',
    'https://www.messenger.com/t/1',
    'https://www.facebook.com/messages/t/1',
    'https://www.facebook.com/home',
    'https://discord.com/channels/1/2',
    'https://discord.com/login',
    'https://app.slack.com/client/T/C',
    'https://teams.microsoft.com/v2/',
    'https://teams.live.com/',
    'https://web.skype.com/',
    'https://web.whatsapp.com.evil.example/',
    'https://notwhatsapp.com/',
    'https://whatsapp.com/',
    'https://example.com/?next=web.whatsapp.com',
    'https://mail.google.com/mail/u/0/',
    'https://tshc.gov.in/',
    'file:///C:/web.whatsapp.com/x.html',
    'chrome://extensions',
    'about:blank',
    'not a url',
    '',
  ];

  it('blocks the same addresses with everything off, and lets the same ones through', () => {
    const desktop = new CommunicationPolicy(() => COMMUNICATION_OFF);
    ext.setBlocked(desktop.blockRules());
    for (const url of urls) {
      expect(ext.blockedHostForSync(url) !== null, url).toBe(desktop.blockedForUrl(url) !== null);
    }
  });

  it('lets everything through when Eya says nothing is blocked, and only the excluded app when one is', () => {
    ext.setBlocked([]);
    for (const url of urls) expect(ext.blockedHostForSync(url), url).toBeNull();
    const some = new CommunicationPolicy(() => ({ enabled: true, apps: { instagram: false } }));
    ext.setBlocked(some.blockRules());
    for (const url of urls) expect(ext.blockedHostForSync(url) !== null, url).toBe(some.blockedForUrl(url) !== null);
    expect(ext.blockedHostForSync('https://web.whatsapp.com/')).toBeNull();
    expect(ext.blockedHostForSync('https://www.instagram.com/')).toBe('instagram.com');
    ext.setBlocked(new CommunicationPolicy(() => COMMUNICATION_OFF).blockRules());
  });

  it('remembers the list for a restarted worker (kept in memory-only browser storage, not on disk)', async () => {
    ext.setBlocked([{ host: 'chat.localhost' }]);
    await new Promise((r) => setTimeout(r, 5));
    expect(stored['eyaBlocked']).toEqual([{ host: 'chat.localhost' }]);
    expect(await ext.blockedHostFor('http://chat.localhost:8080/')).toBe('chat.localhost');
    ext.setBlocked(new CommunicationPolicy(() => COMMUNICATION_OFF).blockRules());
  });

  it('ignores a malformed list rather than opening up: junk entries are dropped, a non-list falls back to blocking everything', () => {
    ext.setBlocked('nonsense');
    expect(ext.blockedHostForSync('https://web.whatsapp.com/')).toBe('web.whatsapp.com');
    ext.setBlocked([{ host: 'bad host!' }, { host: 5 }, null, { host: 'ok.example', pathPrefix: 'no-slash' }, { host: 'good.example', pathPrefix: '/chat' }]);
    expect(ext.blockedHostForSync('https://bad.example/')).toBeNull();
    expect(ext.blockedHostForSync('https://ok.example/anything')).toBe('ok.example'); // a bad path prefix is dropped, the host rule stays
    expect(ext.blockedHostForSync('https://good.example/chat/1')).toBe('good.example');
    expect(ext.blockedHostForSync('https://good.example/other')).toBeNull();
    ext.setBlocked(new CommunicationPolicy(() => COMMUNICATION_OFF).blockRules());
  });

  it('raises an error Eya recognises, naming the host', () => {
    const err = new ext.CommunicationAccessOff('web.whatsapp.com');
    expect(err.message).toBe('communication_access_off: web.whatsapp.com');
    expect(err.host).toBe('web.whatsapp.com');
  });
});

describe('every way into a page in the extension passes through the check', () => {
  const read = (f: string) => readFileSync(join(root, f), 'utf8');

  it('reading, clicking, typing and photographing a tab all check it first', () => {
    const actions = read('actions.js');
    expect(actions).toMatch(/blockedHostFor\(/);
    expect(actions).toMatch(/CommunicationAccessOff/);
    expect(read('tabs.js')).toMatch(/blockedHostFor/);
  });

  it('the worker answers the policy request and advertises it', () => {
    const worker = read('service-worker.js');
    expect(worker).toContain("case 'set_policy'");
    expect(worker).toMatch(/'policy'/);
  });

  it('no page content, cookie or message text is ever stored by the policy file', () => {
    const source = read('policy.js');
    expect(source).not.toMatch(/chrome\.cookies|localStorage|chrome\.storage\.local|chrome\.storage\.sync/);
  });
});
