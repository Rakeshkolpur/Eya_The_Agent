import { describe, it, expect } from 'vitest';
import { createSystemTools } from '../src/main/tools/impl/systemTools';
import type { SystemControlDeps } from '../src/main/tools/impl/systemTools';
import type { Tool } from '../src/main/tools/types';

function toolMap(deps: SystemControlDeps): Record<string, Tool> {
  return Object.fromEntries(createSystemTools(deps).map((t) => [t.schema.name, t]));
}

function fakeDeps(overrides: Partial<SystemControlDeps> = {}): { deps: SystemControlDeps; opened: string[] } {
  const opened: string[] = [];
  let volume = { percent: 50, muted: false };
  let brightness: number | null = 70;
  const deps: SystemControlDeps = {
    openExternal: async (url) => {
      opened.push(url);
    },
    getVolume: async () => volume,
    setVolume: async (percent) => {
      volume = { ...volume, percent };
    },
    setMuted: async (muted) => {
      volume = { ...volume, muted };
    },
    getBrightness: async () => brightness,
    setBrightness: async (percent) => {
      if (brightness === null) return false;
      brightness = percent;
      return true;
    },
    // Real power actions are never fired in a test — these are always fakes.
    lockWorkstation: async () => true,
    scheduleRestart: async () => true,
    scheduleShutdown: async () => true,
    ...overrides,
  };
  return { deps, opened };
}

describe('open_windows_settings / open_settings_page', () => {
  it('opens the Settings app', async () => {
    const { deps, opened } = fakeDeps();
    const result = await toolMap(deps)['open_windows_settings']!.execute({});
    expect(result.ok).toBe(true);
    expect(opened).toEqual(['ms-settings:']);
  });

  it('opens a specific known page', async () => {
    const { deps, opened } = fakeDeps();
    const result = await toolMap(deps)['open_settings_page']!.execute({ page: 'wifi' });
    expect(result.ok).toBe(true);
    expect(opened).toEqual(['ms-settings:network-wifi']);
  });

  it('refuses an unknown page rather than guessing a URI', async () => {
    const { deps, opened } = fakeDeps();
    const result = await toolMap(deps)['open_settings_page']!.execute({ page: 'made-up-page' });
    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe('volume', () => {
  it('reads the current volume and mute state', async () => {
    const { deps } = fakeDeps({ getVolume: async () => ({ percent: 42, muted: true }) });
    const result = await toolMap(deps)['get_volume']!.execute({});
    expect(result.data).toEqual({ percent: 42, muted: true });
  });

  it('sets and verifies an exact volume', async () => {
    const { deps } = fakeDeps();
    const result = await toolMap(deps)['set_volume']!.execute({ percent: 65 });
    expect(result.ok).toBe(true);
    expect(result.data?.['percent']).toBe(65);
  });

  it('rejects an out-of-range or missing value', async () => {
    const { deps } = fakeDeps();
    const tools = toolMap(deps);
    expect((await tools['set_volume']!.execute({ percent: 150 })).ok).toBe(true); // clamped to 100, not rejected
    expect((await tools['set_volume']!.execute({})).ok).toBe(false);
  });

  it('reports honestly if the volume does not read back as set', async () => {
    const { deps } = fakeDeps({ setVolume: async () => undefined, getVolume: async () => ({ percent: 10, muted: false }) });
    const result = await toolMap(deps)['set_volume']!.execute({ percent: 90 });
    expect(result.ok).toBe(false);
  });

  it('mutes and unmutes, verifying the result', async () => {
    const { deps } = fakeDeps();
    const tools = toolMap(deps);
    expect((await tools['mute_volume']!.execute({})).ok).toBe(true);
    expect((await tools['unmute_volume']!.execute({})).ok).toBe(true);
  });
});

describe('brightness', () => {
  it('reads the current brightness', async () => {
    const { deps } = fakeDeps({ getBrightness: async () => 33 });
    const result = await toolMap(deps)['get_brightness']!.execute({});
    expect(result.ok).toBe(true);
    expect(result.data?.['percent']).toBe(33);
  });

  it('reports plainly when the display has no software brightness control', async () => {
    const { deps } = fakeDeps({ getBrightness: async () => null });
    const result = await toolMap(deps)['get_brightness']!.execute({});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not supported');
  });

  it('sets and verifies an exact brightness', async () => {
    const { deps } = fakeDeps();
    const result = await toolMap(deps)['set_brightness']!.execute({ percent: 20 });
    expect(result.ok).toBe(true);
    expect(result.data?.['percent']).toBe(20);
  });

  it('reports unsupported rather than silently failing when the display refuses', async () => {
    const { deps } = fakeDeps({ setBrightness: async () => false });
    const result = await toolMap(deps)['set_brightness']!.execute({ percent: 20 });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not supported');
  });
});

describe('lock_screen', () => {
  it('locks immediately, no confirmation needed', async () => {
    const { deps } = fakeDeps();
    const result = await toolMap(deps)['lock_screen']!.execute({});
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('locked the screen');
  });

  it('reports honestly when the lock could not be verified', async () => {
    const { deps } = fakeDeps({ lockWorkstation: async () => false });
    const result = await toolMap(deps)['lock_screen']!.execute({});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('lock not verified');
  });
});

describe('restart_computer / shutdown_computer', () => {
  it('never restarts or shuts down on the first call: it asks first, every time', async () => {
    const { deps } = fakeDeps({
      scheduleRestart: async () => {
        throw new Error('should never be called without confirm: true');
      },
      scheduleShutdown: async () => {
        throw new Error('should never be called without confirm: true');
      },
    });
    const tools = toolMap(deps);
    const restart = await tools['restart_computer']!.execute({});
    expect(restart.ok).toBe(false);
    expect(restart.data?.['status']).toBe('permission_required');
    const shutdown = await tools['shutdown_computer']!.execute({});
    expect(shutdown.ok).toBe(false);
    expect(shutdown.data?.['status']).toBe('permission_required');
  });

  it('restarts only once confirm is true, and reports Windows accepted it', async () => {
    let scheduled = false;
    const { deps } = fakeDeps({
      scheduleRestart: async (delaySeconds) => {
        scheduled = true;
        expect(delaySeconds).toBeGreaterThan(0);
        return true;
      },
    });
    const result = await toolMap(deps)['restart_computer']!.execute({ confirm: true });
    expect(result.ok).toBe(true);
    expect(scheduled).toBe(true);
  });

  it('shuts down only once confirm is true, and reports Windows accepted it', async () => {
    let scheduled = false;
    const { deps } = fakeDeps({
      scheduleShutdown: async () => {
        scheduled = true;
        return true;
      },
    });
    const result = await toolMap(deps)['shutdown_computer']!.execute({ confirm: true });
    expect(result.ok).toBe(true);
    expect(scheduled).toBe(true);
  });

  it('reports honestly when Windows refuses the restart/shutdown request', async () => {
    const { deps } = fakeDeps({ scheduleRestart: async () => false, scheduleShutdown: async () => false });
    const tools = toolMap(deps);
    expect((await tools['restart_computer']!.execute({ confirm: true })).ok).toBe(false);
    expect((await tools['shutdown_computer']!.execute({ confirm: true })).ok).toBe(false);
  });
});
