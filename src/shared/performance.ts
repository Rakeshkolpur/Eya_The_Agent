/**
 * How hard Eya works, matched to the laptop she is running on.
 *
 * Three levels, chosen automatically from the memory and processor cores Windows reports (or by the user in Settings → Performance):
 *
 *   light     — small laptops (under ~5.5 GB of memory, or 2 cores). Graphics acceleration off: on the 4-core i3 laptop this was
 *               developed on that took Eya from 1,377 MB to 659 MB in use, at the price of voice recognition on the processor, about
 *               twice as slow (2.5 s instead of 1.2 s for a 3-second clip). Slower motion, a smaller file index, a gentler screen share.
 *   balanced  — ordinary laptops (up to ~11 GB, or 4 cores). Everything on, a little less motion.
 *   full      — everything else.
 *
 * What is the SAME at every level: with nothing happening Eya is perfectly still (no animation timer runs at all; measured at ~1% of a
 * core, against 52-125% when the bubble "breathed"), and every private-by-default rule.
 *
 * Pure, so the thresholds are tested and the main process and the page agree.
 */

export type PerformanceTier = 'light' | 'balanced' | 'full';
export type PerformanceSetting = 'auto' | PerformanceTier;

export const PERFORMANCE_SETTINGS: readonly PerformanceSetting[] = ['auto', 'light', 'balanced', 'full'];
export const PERFORMANCE_TIERS: readonly PerformanceTier[] = ['light', 'balanced', 'full'];

export interface Hardware {
  readonly totalMemBytes: number;
  /** Logical processors (threads) Windows reports. */
  readonly logicalCores: number;
}

export interface PerformanceProfile {
  readonly tier: PerformanceTier;
  /** How many times a second things that move may change (0 = nothing moves). Used by the page's motion clock. */
  readonly motionPerSecond: number;
  /** Chromium's graphics acceleration. Off saves a lot of memory but moves voice recognition to the processor. Needs a restart to change. */
  readonly hardwareAcceleration: boolean;
  /** Whether the offline (Kokoro) voice may be loaded when the cloud voice fails; off, the system voice is used instead. */
  readonly offlineVoice: boolean;
  readonly fileIndexMaxFiles: number;
  /** How long after start-up to wait before reading the folders / the Start Menu, so start-up stays quick. */
  readonly fileIndexStartMs: number;
  readonly appCatalogStartMs: number;
  /** Screen sharing: how often a picture is taken, and how wide it is. */
  readonly screenShareIntervalMs: number;
  readonly screenShareMaxWidth: number;
}

const GIB = 1024 ** 3;

/** Which level suits this machine. */
export function detectTier(hardware: Hardware): PerformanceTier {
  const memory = hardware.totalMemBytes / GIB;
  const cores = hardware.logicalCores;
  if (memory < 5.5 || cores <= 2) return 'light';
  if (memory < 11 || cores <= 4) return 'balanced';
  return 'full';
}

const PROFILES: Readonly<Record<PerformanceTier, PerformanceProfile>> = {
  light: {
    tier: 'light',
    motionPerSecond: 2,
    hardwareAcceleration: false,
    offlineVoice: false,
    fileIndexMaxFiles: 30_000,
    fileIndexStartMs: 12_000,
    appCatalogStartMs: 20_000,
    screenShareIntervalMs: 2_000,
    screenShareMaxWidth: 1024,
  },
  balanced: {
    tier: 'balanced',
    motionPerSecond: 4,
    hardwareAcceleration: true,
    offlineVoice: true,
    fileIndexMaxFiles: 100_000,
    fileIndexStartMs: 4_000,
    appCatalogStartMs: 6_000,
    screenShareIntervalMs: 1_000,
    screenShareMaxWidth: 1280,
  },
  full: {
    tier: 'full',
    motionPerSecond: 6,
    hardwareAcceleration: true,
    offlineVoice: true,
    fileIndexMaxFiles: 150_000,
    fileIndexStartMs: 3_000,
    appCatalogStartMs: 5_000,
    screenShareIntervalMs: 1_000,
    screenShareMaxWidth: 1280,
  },
};

export function profileFor(tier: PerformanceTier): PerformanceProfile {
  return PROFILES[tier];
}

export function parsePerformanceSetting(value: unknown): PerformanceSetting {
  return typeof value === 'string' && (PERFORMANCE_SETTINGS as readonly string[]).includes(value) ? (value as PerformanceSetting) : 'auto';
}

export interface ResolvedPerformance {
  /** What the user chose ('auto' unless they picked a level). */
  readonly setting: PerformanceSetting;
  /** What this machine would get on its own. */
  readonly detected: PerformanceTier;
  readonly profile: PerformanceProfile;
}

/** The level in effect: the user's choice if they made one, else what the hardware calls for. `override` is for testing (EYA_PROFILE). */
export function resolvePerformance(setting: PerformanceSetting, hardware: Hardware, override?: string): ResolvedPerformance {
  const detected = detectTier(hardware);
  const forced = override === undefined ? 'auto' : parsePerformanceSetting(override.trim().toLowerCase());
  const chosen = forced !== 'auto' ? forced : setting;
  return { setting, detected, profile: profileFor(chosen === 'auto' ? detected : chosen) };
}

export const TIER_LABEL: Readonly<Record<PerformanceTier, string>> = { light: 'Light', balanced: 'Balanced', full: 'Full' };

/** What a level means, in words for the Settings screen. */
export const TIER_SUMMARY: Readonly<Record<PerformanceTier, string>> = {
  light:
    'For small laptops. Uses about half the memory (graphics acceleration is off, so voice recognition runs on the processor and takes about twice as long), moves less, and keeps a smaller file index.',
  balanced: 'For ordinary laptops. Everything is on; the little animations step more slowly to save battery.',
  full: 'Everything on, with the smoothest animations.',
};

/** What the page is told: what is chosen, what this PC would pick, what is running, and what is true about the machine. */
export interface PerformanceInfo {
  readonly setting: PerformanceSetting;
  readonly detected: PerformanceTier;
  /** The level running right now (it only changes when Eya starts). */
  readonly running: PerformanceTier;
  /** The level the saved setting asks for: different from `running` means a restart is needed. */
  readonly wanted: PerformanceTier;
  readonly motionPerSecond: number;
  readonly offlineVoice: boolean;
  readonly hardwareAcceleration: boolean;
  readonly memoryGB: number;
  readonly cores: number;
}

export function describeHardware(hardware: Hardware): { readonly memoryGB: number; readonly cores: number } {
  return { memoryGB: Math.round((hardware.totalMemBytes / GIB) * 10) / 10, cores: hardware.logicalCores };
}
