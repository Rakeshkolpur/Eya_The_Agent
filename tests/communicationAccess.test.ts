import { describe, it, expect } from 'vitest';
import {
  COMMUNICATION_APPS,
  COMMUNICATION_OFF,
  CommunicationPolicy,
  appNameForHost,
  parseSettings,
} from '../src/main/privacy/communicationAccess';
import type { CommunicationSettings } from '../src/main/privacy/communicationAccess';

function policy(settings: CommunicationSettings = COMMUNICATION_OFF) {
  let current = settings;
  const p = new CommunicationPolicy(() => current);
  return { p, set: (s: CommunicationSettings) => void (current = s) };
}

const ON: CommunicationSettings = { enabled: true, apps: {} };

describe('which app is this address?', () => {
  const { p } = policy();
  const name = (url: string) => p.appForUrl(url)?.name ?? null;

  it('recognises the chat sites, including their subdomains and any path', () => {
    expect(name('https://web.whatsapp.com/')).toBe('WhatsApp');
    expect(name('https://web.whatsapp.com/send?phone=123')).toBe('WhatsApp');
    expect(name('https://web.telegram.org/k/#@someone')).toBe('Telegram');
    expect(name('https://www.instagram.com/direct/inbox/')).toBe('Instagram');
    expect(name('https://instagram.com/')).toBe('Instagram');
    expect(name('https://www.messenger.com/t/123')).toBe('Messenger');
    expect(name('https://app.slack.com/client/T1/C2')).toBe('Slack');
    expect(name('https://teams.microsoft.com/v2/')).toBe('Microsoft Teams');
    expect(name('HTTPS://WEB.WHATSAPP.COM/')).toBe('WhatsApp');
  });

  it('only the chat part of a site that is mostly something else', () => {
    expect(name('https://www.facebook.com/messages/t/123')).toBe('Messenger');
    expect(name('https://www.facebook.com/home')).toBeNull();
    expect(name('https://discord.com/channels/1/2')).toBe('Discord');
    expect(name('https://discord.com/login')).toBeNull();
  });

  it('is not fooled by look-alikes, other protocols or junk — and e-mail is not a chat app', () => {
    for (const url of [
      'https://web.whatsapp.com.evil.example/',
      'https://notwhatsapp.com/',
      'https://whatsapp.com/', // the marketing site, not the chat
      'https://example.com/?next=web.whatsapp.com',
      'file:///C:/web.whatsapp.com/index.html',
      'chrome://extensions',
      'about:blank',
      'not a url',
      '',
      'https://mail.google.com/mail/u/0/',
      'https://outlook.live.com/mail/',
      'https://tshc.gov.in/',
    ]) {
      expect(p.appForUrl(url), url).toBeNull();
    }
  });
});

describe('which app is this window?', () => {
  const { p } = policy();
  it('by the program for desktop apps, or by the title for a browser showing the web version', () => {
    expect(p.appForWindow({ process: 'WhatsApp', title: 'WhatsApp' })?.name).toBe('WhatsApp');
    expect(p.appForWindow({ process: 'Telegram', title: 'Rahul Sharma' })?.name).toBe('Telegram');
    expect(p.appForWindow({ process: 'chrome', title: '(3) WhatsApp - Google Chrome' })?.name).toBe('WhatsApp');
    expect(p.appForWindow({ process: 'msedge', title: 'Telegram Web - Microsoft Edge' })?.name).toBe('Telegram');
    expect(p.appForWindow({ process: 'notepad', title: 'notes.txt - Notepad' })).toBeNull();
    expect(p.appForWindow({ process: 'chrome', title: 'Inbox - Google Chrome' })).toBeNull();
  });
});

describe('Communication Access is OFF unless the user turned it on', () => {
  it('by default nothing is allowed, and every chat app is blocked', () => {
    const { p } = policy();
    for (const app of COMMUNICATION_APPS) expect(p.allowed(app), app.id).toBe(false);
    expect(p.blockedForUrl('https://web.whatsapp.com/')?.name).toBe('WhatsApp');
    expect(p.blockedForWindow({ process: 'telegram', title: 'x' })?.name).toBe('Telegram');
    expect(p.blockedForUrl('https://tshc.gov.in/')).toBeNull(); // ordinary sites are never affected
    expect(p.blockedForUrl(null)).toBeNull();
    expect(p.blockedForUrl('')).toBeNull();
  });

  it('turned on, the apps are allowed — except one the user excluded', () => {
    const { p } = policy({ enabled: true, apps: { instagram: false } });
    expect(p.blockedForUrl('https://web.whatsapp.com/')).toBeNull();
    expect(p.blockedForUrl('https://web.telegram.org/k/')).toBeNull();
    expect(p.blockedForUrl('https://www.instagram.com/')?.name).toBe('Instagram');
  });

  it('a per-app "allowed" does nothing while the master switch is off', () => {
    const { p } = policy({ enabled: false, apps: { whatsapp: true } });
    expect(p.blockedForUrl('https://web.whatsapp.com/')?.name).toBe('WhatsApp');
  });

  it('switching takes effect at once: the policy reads the live setting every time', () => {
    const { p, set } = policy();
    expect(p.blockedForUrl('https://web.whatsapp.com/')).not.toBeNull();
    set(ON);
    expect(p.blockedForUrl('https://web.whatsapp.com/')).toBeNull();
    set(COMMUNICATION_OFF);
    expect(p.blockedForUrl('https://web.whatsapp.com/')).not.toBeNull();
  });

  it('tells the browser extension exactly what is NOT allowed (including path limits)', () => {
    const off = policy().p.blockRules();
    expect(off).toContainEqual({ host: 'web.whatsapp.com' });
    expect(off).toContainEqual({ host: 'facebook.com', pathPrefix: '/messages' });
    expect(off).toContainEqual({ host: 'discord.com', pathPrefix: '/channels' });
    expect(policy(ON).p.blockRules()).toEqual([]);
    const some = policy({ enabled: true, apps: { whatsapp: false, telegram: false } }).p.blockRules();
    expect(some.map((r) => r.host).sort()).toEqual(['web.telegram.org', 'web.whatsapp.com']);
  });

  it('a test-only extra app works like a built-in one, and is not in the real catalogue', () => {
    const extra = { id: 'mockchat', name: 'MockChat', hosts: [{ host: 'chat.localhost' }], processes: [], titleHints: [] };
    const p = new CommunicationPolicy(() => COMMUNICATION_OFF, [extra]);
    expect(p.blockedForUrl('http://chat.localhost:3000/')?.name).toBe('MockChat');
    expect(COMMUNICATION_APPS.some((a) => a.id === 'mockchat')).toBe(false);
  });

  it('gives the model one line it cannot misread, in either state', () => {
    expect(policy().p.summary()).toMatch(/OFF.*do not look at or use/);
    expect(policy().p.summary()).toMatch(/you cannot turn it on/);
    const on = policy({ enabled: true, apps: { instagram: false } }).p.summary();
    expect(on).toMatch(/ON for/);
    expect(on).toMatch(/WhatsApp/);
    expect(on).toMatch(/Still OFF for: Instagram/);
    expect(on).toMatch(/never repeat private messages/);
  });
});

describe('reading saved settings fails CLOSED', () => {
  it('only exactly {enabled: true} is ON; everything else is OFF', () => {
    expect(parseSettings({ enabled: true, apps: {} }).enabled).toBe(true);
    for (const bad of [null, undefined, 'on', 1, true, [], {}, { enabled: 'true' }, { enabled: 1 }, { enabled: false }, { enabled: null }, { apps: {} }]) {
      expect(parseSettings(bad).enabled, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps only known apps with true/false choices, and keeps them whether or not the master switch is on', () => {
    expect(parseSettings({ enabled: true, apps: { whatsapp: false, instagram: true, nonsense: false, telegram: 'no', discord: 0 } })).toEqual({
      enabled: true,
      apps: { whatsapp: false, instagram: true },
    });
    expect(parseSettings({ enabled: false, apps: { whatsapp: false } })).toEqual({ enabled: false, apps: { whatsapp: false } });
    expect(parseSettings({ enabled: true, apps: [1, 2] }).apps).toEqual({});
  });
});

describe('naming a host', () => {
  it('uses the app name for a chat host and the host itself otherwise', () => {
    expect(appNameForHost('web.whatsapp.com')).toBe('WhatsApp');
    expect(appNameForHost('www.instagram.com')).toBe('Instagram');
    expect(appNameForHost('example.org')).toBe('example.org');
  });
});
