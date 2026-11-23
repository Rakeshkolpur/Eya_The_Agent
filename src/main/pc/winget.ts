/**
 * Reading what the Windows Package Manager (winget) prints, and checking what may be passed to it. Pure.
 *
 * Only winget's own "winget" source is ever used (its packages are reviewed by Microsoft's repository), and only a package id that has been looked up: an id, never a URL or a file.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._+-]{1,127}$/;
const QUERY = /^[A-Za-z0-9][A-Za-z0-9 .+#_-]{0,59}$/;

export const isPackageId = (id: string): boolean => ID.test(id);
/** A search word: letters, digits, spaces and a few marks; it may not start with a dash (winget would take it for an option). */
export const isSearchQuery = (q: string): boolean => QUERY.test(q.trim());

export interface PackageHit {
  readonly name: string;
  readonly id: string;
  readonly version: string;
}

/** The rows of `winget search`: a header line (Name, Id, Version …), a line of dashes, then one row per package with the columns at the header's positions. */
export function parseSearch(output: string, limit = 8): PackageHit[] {
  const lines = output.replace(/\r/g, '').split('\n');
  const dash = lines.findIndex((l) => /^-{5,}\s*$/.test(l.trim()));
  if (dash < 1) return [];
  const header = lines[dash - 1] ?? '';
  const iName = header.indexOf('Name');
  const iId = header.indexOf('Id');
  const iVersion = header.indexOf('Version');
  if (iName < 0 || iId < 0 || iVersion < 0 || !(iName < iId && iId < iVersion)) return [];
  const iNext = ['Match', 'Source'].map((h) => header.indexOf(h)).filter((i) => i > iVersion).sort((a, b) => a - b)[0] ?? -1;
  const hits: PackageHit[] = [];
  for (const line of lines.slice(dash + 1)) {
    if (line.trim() === '') continue;
    const name = line.slice(iName, iId).trim();
    const id = line.slice(iId, iVersion).trim();
    const version = (iNext > 0 ? line.slice(iVersion, iNext) : line.slice(iVersion)).trim();
    if (name === '' || !isPackageId(id)) continue;
    hits.push({ name, id, version });
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface PackageInfo {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly publisher: string;
}

/** What `winget show --id X --exact` says: "Found Git [Git.Git]", "Version: 2.43.0", "Publisher: The Git Development Community". Null when it found nothing. */
export function parseShow(output: string): PackageInfo | null {
  const text = output.replace(/\r/g, '');
  const found = /^Found\s+(.+?)\s+\[([^\]]+)\]/m.exec(text);
  if (found?.[1] === undefined || found[2] === undefined || !isPackageId(found[2])) return null;
  const field = (label: string): string => new RegExp(`^${label}:\\s*(.+)$`, 'mi').exec(text)?.[1]?.trim() ?? '';
  return { name: found[1].trim(), id: found[2], version: field('Version'), publisher: field('Publisher') };
}

/** Whether `winget list --id X --exact` shows the package as installed. */
export function listsPackage(output: string, id: string): boolean {
  return output.split(/\r?\n/).some((l) => l.split(/\s+/).some((w) => w.toLowerCase() === id.toLowerCase()));
}

/** The last useful lines of an install's output (never more than a few hundred characters), for telling why it failed. */
export function tailOf(output: string, max = 400): string {
  const lines = output.replace(/\r/g, '').split('\n').map((l) => l.replace(/[─-▟\\|/-]{2,}/g, '').trim()).filter((l) => l !== '' && !/^[\\|/-]$/.test(l));
  return lines.slice(-4).join(' ').slice(-max);
}
