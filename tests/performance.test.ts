import { describe, it, expect } from 'vitest';
import { PERFORMANCE_TIERS, detectTier, describeHardware, parsePerformanceSetting, profileFor, resolvePerformance } from '../src/shared/performance';
import type { Hardware } from '../src/shared/performance';

const GIB = 1024 ** 3;
const pc = (memGiB: number, cores: number): Hardware => ({ totalMemBytes: memGiB * GIB, logicalCores: cores });

describe('which level suits a laptop', () => {
  it('puts small machines on Light, ordinary ones on Balanced, and the rest on Full', () => {
    expect(detectTier(pc(3.9, 4))).toBe('light'); // a 4 GB laptop
    expect(detectTier(pc(8, 2))).toBe('light'); // plenty of memory but two threads
    expect(detectTier(pc(5.4, 8))).toBe('light');
    expect(detectTier(pc(7.7, 4))).toBe('balanced'); // the i3 laptop this was built on
    expect(detectTier(pc(7.7, 8))).toBe('balanced'); // 8 GB is not roomy once Windows and a browser are in
    expect(detectTier(pc(15.8, 4))).toBe('balanced'); // lots of memory, few threads
    expect(detectTier(pc(15.8, 8))).toBe('full');
    expect(detectTier(pc(31.9, 16))).toBe('full');
  });

  it('copes with nonsense from the system', () => {
    expect(detectTier(pc(0, 0))).toBe('light');
    expect(detectTier({ totalMemBytes: Number.NaN, logicalCores: Number.NaN })).toBe('full'); // unknown: do not strip features on a guess
  });
});

describe('what each level does', () => {
  it('gets lighter in every way as the level drops', () => {
    const [light, balanced, full] = PERFORMANCE_TIERS.map(profileFor);
    expect(light?.hardwareAcceleration).toBe(false); // the big memory saving
    expect(balanced?.hardwareAcceleration && full?.hardwareAcceleration).toBe(true);
    expect(light?.motionPerSecond).toBeLessThan(balanced?.motionPerSecond ?? 0);
    expect(balanced?.motionPerSecond).toBeLessThan(full?.motionPerSecond ?? 0);
    expect(light?.fileIndexMaxFiles).toBeLessThan(balanced?.fileIndexMaxFiles ?? 0);
    expect(balanced?.fileIndexMaxFiles).toBeLessThan(full?.fileIndexMaxFiles ?? 0);
    expect(light?.screenShareIntervalMs).toBeGreaterThan(balanced?.screenShareIntervalMs ?? 0);
    expect(light?.offlineVoice).toBe(false);
    expect(light?.fileIndexStartMs).toBeGreaterThan(balanced?.fileIndexStartMs ?? 0); // start-up stays quick on a small machine
  });

  it('never asks for a speed the motion clock would refuse, and every level can show motion', () => {
    for (const tier of PERFORMANCE_TIERS) {
      const p = profileFor(tier);
      expect(p.motionPerSecond).toBeGreaterThan(0);
      expect(p.motionPerSecond).toBeLessThanOrEqual(12);
      expect(p.tier).toBe(tier);
    }
  });
});

describe('choosing', () => {
  it('follows the hardware on "auto", and the user\'s choice otherwise', () => {
    expect(resolvePerformance('auto', pc(3.9, 4))).toMatchObject({ setting: 'auto', detected: 'light', profile: { tier: 'light' } });
    expect(resolvePerformance('full', pc(3.9, 4))).toMatchObject({ setting: 'full', detected: 'light', profile: { tier: 'full' } });
    expect(resolvePerformance('light', pc(31.9, 16)).profile.tier).toBe('light');
  });

  it('lets EYA_PROFILE override for testing, ignoring a value it does not know', () => {
    expect(resolvePerformance('auto', pc(31.9, 16), 'light').profile.tier).toBe('light');
    expect(resolvePerformance('full', pc(31.9, 16), ' LIGHT ').profile.tier).toBe('light');
    expect(resolvePerformance('auto', pc(7.7, 4), 'turbo').profile.tier).toBe('balanced');
    expect(resolvePerformance('auto', pc(7.7, 4), 'auto').profile.tier).toBe('balanced');
  });

  it('reads a saved setting safely', () => {
    expect(parsePerformanceSetting('light')).toBe('light');
    for (const junk of [undefined, null, 5, 'LIGHT', 'turbo', {}, '']) expect(parsePerformanceSetting(junk)).toBe('auto');
  });

  it('describes the machine in plain numbers', () => {
    expect(describeHardware(pc(7.7, 4))).toEqual({ memoryGB: 7.7, cores: 4 });
  });
});
