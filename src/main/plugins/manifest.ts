import type { CatalogEntry, PluginManifest } from './types';

/** "1.2.3" as numbers, or null when it is not a plain three-part version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/.exec(text.trim());
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Negative when a is older than b, 0 when equal, positive when newer. A version that cannot be read counts as the oldest. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return x === null && y === null ? 0 : x === null ? -1 : 1;
  for (let i = 0; i < 3; i += 1) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** Whether a plugin works with this version of Eya, and if not, why — in a sentence the person can read. */
export function compatibility(manifest: PluginManifest, eyaVersion: string): { readonly ok: boolean; readonly note: string } {
  const { minEya, maxEya } = manifest.compat;
  if (compareVersions(eyaVersion, minEya) < 0) return { ok: false, note: `Needs Eya ${minEya} or newer (this is ${eyaVersion}).` };
  if (maxEya !== undefined && compareVersions(eyaVersion, maxEya) > 0) return { ok: false, note: `Made for Eya up to ${maxEya} (this is ${eyaVersion}); an update is needed.` };
  return { ok: true, note: `Works with this version of Eya (${eyaVersion}).` };
}

/** All of the supported permission ids of a manifest. */
export function supportedPermissions(manifest: PluginManifest): string[] {
  return [...new Set(manifest.actions.filter((a) => a.unsupported === undefined && a.permission !== undefined).map((a) => a.permission as string))];
}

const ID = /^[a-z][a-z0-9-]{1,40}$/;
const ACTION_ID = /^[a-z][a-z0-9_]{1,40}$/;
const PERMISSION_ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface ValidationContext {
  /** The names of the tools that are registered, so a manifest cannot name one that is not there. */
  readonly knownTools: ReadonlySet<string>;
}

/**
 * The problems with a manifest, or an empty list when it is sound. A manifest is data: it can only point at tools that already exist, so a bad one can
 * never make Eya run anything new — but one that is wrong would mislead the person about what a plugin can do, so it is refused rather than shown.
 */
export function validateManifest(manifest: PluginManifest, context: ValidationContext): string[] {
  const problems: string[] = [];
  if (!ID.test(manifest.id)) problems.push(`the id "${manifest.id}" is not lower-case letters, digits and hyphens`);
  if (manifest.name.trim() === '') problems.push('it has no name');
  if (manifest.description.trim() === '') problems.push('it has no description');
  if (parseVersion(manifest.version) === null) problems.push(`the version "${manifest.version}" is not like 1.2.0`);
  if (parseVersion(manifest.compat.minEya) === null) problems.push('the oldest Eya it works with is not a version');
  if (manifest.compat.maxEya !== undefined && parseVersion(manifest.compat.maxEya) === null) problems.push('the newest Eya it works with is not a version');

  const permissions = new Set<string>();
  for (const p of manifest.permissions) {
    if (!PERMISSION_ID.test(p.id)) problems.push(`the permission id "${p.id}" is not like chats.read`);
    if (permissions.has(p.id)) problems.push(`the permission "${p.id}" is declared twice`);
    permissions.add(p.id);
    if (p.label.trim() === '' || p.description.trim() === '') problems.push(`the permission "${p.id}" has no label or description`);
  }

  const actions = new Set<string>();
  for (const a of manifest.actions) {
    if (!ACTION_ID.test(a.id)) problems.push(`the action id "${a.id}" is not lower-case letters, digits and underscores`);
    if (actions.has(a.id)) problems.push(`the action "${a.id}" is declared twice`);
    actions.add(a.id);
    if (a.verify.trim() === '') problems.push(`the action "${a.id}" does not say how its result is checked`);
    if (a.unsupported !== undefined) {
      // an action that is not supported promises nothing: no tools, no permission
      if (a.tools.length > 0 || a.permission !== undefined) problems.push(`the action "${a.id}" is marked not supported but names tools or a permission`);
      continue;
    }
    if (a.tools.length === 0) problems.push(`the action "${a.id}" has no tool to carry it out`);
    for (const t of a.tools) if (!context.knownTools.has(t)) problems.push(`the action "${a.id}" names a tool that does not exist: ${t}`);
    if (a.permission === undefined) problems.push(`the action "${a.id}" needs a permission`);
    else if (!permissions.has(a.permission)) problems.push(`the action "${a.id}" needs a permission that is not declared: ${a.permission}`);
    if (a.consequential === true && a.permission !== undefined) {
      const p = manifest.permissions.find((x) => x.id === a.permission);
      if (p !== undefined && p.risk === 'read') problems.push(`the action "${a.id}" changes something outside Eya but its permission is only "read"`);
    }
  }
  if (manifest.auth.kind === 'app_switch' && manifest.auth.app.trim() === '') problems.push('it names no app to connect to');
  return problems;
}

/** Entries that are sound, and the reasons for those that were left out (so a bad entry is reported, never silently shown). */
export function soundEntries(entries: readonly CatalogEntry[], context: ValidationContext): { readonly good: CatalogEntry[]; readonly refused: ReadonlyArray<{ readonly id: string; readonly problems: readonly string[] }> } {
  const good: CatalogEntry[] = [];
  const refused: Array<{ id: string; problems: string[] }> = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const problems = validateManifest(entry.manifest, context);
    if (seen.has(entry.manifest.id)) problems.push('another plugin has the same id');
    if (entry.trust !== 'built-in') problems.push(`its origin (${String(entry.trust)}) is not trusted: only plugins that ship with Eya can be installed`);
    if (problems.length > 0) refused.push({ id: entry.manifest.id, problems });
    else {
      good.push(entry);
      seen.add(entry.manifest.id);
    }
  }
  return { good, refused };
}
