import { describe, it, expect } from 'vitest';
import { AppCatalog } from '../src/main/local/AppCatalog';
import { IntentRouter } from '../src/main/agent/IntentRouter';
import { createOpenApplicationTool } from '../src/main/tools/impl/openApplication';
import type { OpenApplicationDeps } from '../src/main/tools/impl/openApplication';
import type { StartMenuApp } from '../src/main/windowsApi/appDiscovery';

const APPS: StartMenuApp[] = [
  { name: 'Spotify', appId: 'Spotify.exe' },
  { name: 'Microsoft Word', appId: 'word' },
  { name: 'Microsoft Edge', appId: 'edge' },
  { name: 'Windows Edge Beta', appId: 'edgebeta' },
  { name: 'Google Chrome', appId: 'chrome' },
  { name: 'Calculator', appId: 'calc' },
  { name: 'Notes Pro', appId: 'notespro' },
];

function catalog(list: () => Promise<StartMenuApp[]>, now = () => 0, maxAgeMs = 1000): AppCatalog {
  return new AppCatalog({ list, now, maxAgeMs });
}

describe('AppCatalog', () => {
  it('reads the list once and remembers it', async () => {
    let reads = 0;
    const c = catalog(async () => {
      reads += 1;
      return APPS;
    });
    expect(c.loaded).toBe(false);
    expect(c.lookup('spotify')).toBeNull(); // not read yet: not known
    await c.get();
    await c.get();
    expect(reads).toBe(1);
    expect(c.lookup('Spotify')).toBe('Spotify');
  });

  it('shares one read between callers that ask at the same moment', async () => {
    let reads = 0;
    const c = catalog(async () => {
      reads += 1;
      await new Promise((r) => setTimeout(r, 10));
      return APPS;
    });
    await Promise.all([c.get(), c.get(), c.refresh()]);
    expect(reads).toBe(1);
  });

  it('matches exact names only, ignoring case, spaces and a leading Microsoft/Google', async () => {
    const c = catalog(async () => APPS);
    await c.get();
    expect(c.lookup('microsoft word')).toBe('Microsoft Word');
    expect(c.lookup('word')).toBe('Microsoft Word');
    expect(c.lookup('chrome')).toBe('Google Chrome');
    expect(c.lookup('SPOTIFY')).toBe('Spotify');
    expect(c.lookup('calc ulator')).toBe('Calculator');
    // a word that is merely inside a name is not that app
    expect(c.lookup('notes')).toBeNull();
    expect(c.lookup('door')).toBeNull();
    expect(c.lookup('a')).toBeNull();
    expect(c.lookup('')).toBeNull();
  });

  it('does not guess between two apps that shorten to the same word', async () => {
    const c = catalog(async () =>
      [
        { name: 'Microsoft Photos', appId: 'a' },
        { name: 'Windows Photos', appId: 'b' },
      ] as StartMenuApp[],
    );
    await c.get();
    expect(c.lookup('photos')).toBeNull();
    expect(c.lookup('windows photos')).toBe('Windows Photos');
  });

  it('serves an old list at once and refreshes it behind the scenes', async () => {
    let clock = 0;
    let reads = 0;
    let installed = false;
    const c = catalog(
      async () => {
        reads += 1;
        return installed ? [...APPS, { name: 'Zoom', appId: 'zoom' }] : APPS;
      },
      () => clock,
      1000,
    );
    await c.get();
    clock = 5000;
    installed = true;
    const old = await c.get();
    expect(old.find((a) => a.name === 'Zoom')).toBeUndefined(); // answered from memory, at once
    await new Promise((r) => setTimeout(r, 10));
    expect(reads).toBe(2);
    expect(c.lookup('zoom')).toBe('Zoom');
  });

  it('keeps the old list when a read fails, and treats a failed first read as an empty one', async () => {
    let fail = false;
    const c = catalog(async () => {
      if (fail) throw new Error('powershell broke');
      return APPS;
    });
    await c.get();
    fail = true;
    expect((await c.refresh()).length).toBe(APPS.length);
    expect(c.lookup('spotify')).toBe('Spotify');

    const never = catalog(async () => {
      throw new Error('nope');
    });
    expect(await never.get()).toEqual([]);
  });
});

describe('IntentRouter with the installed apps', () => {
  const ready = async (): Promise<AppCatalog> => {
    const c = catalog(async () => APPS);
    await c.get();
    return c;
  };

  it('opens an installed app by name without the model', async () => {
    const router = new IntentRouter(await ready());
    expect(router.match('open spotify')).toMatchObject({ tool: 'open_application', args: { name: 'Spotify' } });
    expect(router.match('Hey Eya, could you open word for me?')).toMatchObject({ args: { name: 'Microsoft Word' } });
    // the short built-in list still wins and keeps its own names
    expect(router.match('open chrome')).toMatchObject({ args: { name: 'chrome' } });
  });

  it('does not claim what is not an exact app', async () => {
    const router = new IntentRouter(await ready());
    expect(router.match('open the door')).toBeUndefined();
    expect(router.match('open notes')).toBeUndefined();
    expect(router.match('open youtube')).toBeUndefined();
  });

  it('only opens installed apps this way: closing stays limited to the built-in list', async () => {
    const router = new IntentRouter(await ready());
    expect(router.match('close spotify')).toBeUndefined();
    expect(router.match('close notepad')).toMatchObject({ tool: 'close_application' });
  });

  it('is unchanged without a catalog', () => {
    expect(new IntentRouter().match('open spotify')).toBeUndefined();
  });
});

describe('opening an app that was installed after the list was read', () => {
  function deps(overrides: Partial<OpenApplicationDeps>): OpenApplicationDeps {
    return {
      isInstalled: async () => true,
      start: () => ({ ok: true }),
      waitForProcess: async () => true,
      listStartApps: async () => [],
      launchStartApp: () => ({ ok: true }),
      listRunningProcessNames: async () => [],
      waitForNewProcess: async () => 'zoom.exe',
      launchBrowser: async () => false,
      openExternal: async () => undefined,
      ...overrides,
    };
  }

  it('looks again at what Windows has before saying it is not installed', async () => {
    let fresh = 0;
    const tool = createOpenApplicationTool(
      deps({
        listStartApps: async () => APPS, // the remembered list: no Zoom
        listStartAppsFresh: async () => {
          fresh += 1;
          return [...APPS, { name: 'Zoom', appId: 'zoom' }];
        },
      }),
    );
    const result = await tool.execute({ name: 'zoom' });
    expect(fresh).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ app: 'Zoom' });
  });

  it('does not read again when the remembered list already has it', async () => {
    let fresh = 0;
    const tool = createOpenApplicationTool(
      deps({
        listStartApps: async () => APPS,
        listStartAppsFresh: async () => {
          fresh += 1;
          return APPS;
        },
      }),
    );
    expect((await tool.execute({ name: 'spotify' })).ok).toBe(true);
    expect(fresh).toBe(0);
  });
});
