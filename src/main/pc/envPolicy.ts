/**
 * What Eya may change about the environment of this PC, and how: the rules, with no Windows in them (pure, so every rule is tested).
 *
 * Only the USER's environment (HKCU\Environment) is ever changed: the machine's needs administrator rights, and Eya does not take them. A name that Windows itself relies on (PATH apart,
 * which has its own careful tool, the system folders, the temp folder, the user name …) is never set or removed. A folder that a variable is meant to point at must exist, and for
 * JAVA_HOME it must really be a Java folder — "set JAVA_HOME to the bin folder" is the most common mistake, and it is refused with the reason.
 */

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Names Windows (or every program) relies on: never set or removed by Eya. PATH is changed only through the PATH tool. */
const PROTECTED = new Set(
  [
    'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
    'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE', 'COMPUTERNAME', 'OS',
    'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'NUMBER_OF_PROCESSORS', 'TEMP', 'TMP', 'PSMODULEPATH', 'DRIVERDATA', 'PUBLIC',
    'ALLUSERSPROFILE', 'LOGONSERVER', 'SESSIONNAME', 'ONEDRIVE', 'ONEDRIVECONSUMER', 'ONEDRIVECOMMERCIAL',
  ].map((n) => n.toUpperCase()),
);

/** A name that holds something private: its value is never shown, said or logged, and its change cannot be undone from Eya's own record (that would keep the secret). */
const SECRET = /(KEY|TOKEN|SECRET|PASSW|PWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export const isSecretName = (name: string): boolean => SECRET.test(name);
export const isProtectedName = (name: string): boolean => PROTECTED.has(name.toUpperCase());

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly say: string };
const no = (say: string): Verdict => ({ ok: false, say });
const yes: Verdict = { ok: true };

/** Whether this is a name Eya may set or remove (the user's own variable). */
export function checkName(name: string): Verdict {
  if (!NAME.test(name)) return no('A variable name is letters, digits and underscores only (it may not start with a digit), and at most 128 characters.');
  if (name.toUpperCase() === 'PATH') return no('PATH is a list, so it is changed with the PATH tool (add a folder, remove one, or clean it up), not by setting it to a new value.');
  if (isProtectedName(name)) return no(`${name} is one Windows itself relies on, so I do not change it.`);
  return yes;
}

/** A drive path (C:\Folder) or one that begins with a variable (%USERPROFILE%\Folder). Nothing with a semicolon, a quote or a wildcard in it. */
const FOLDER = /^(?:[A-Za-z]:[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/]?)[^;"<>|*?\x00-\x1f]*$/;

export function looksLikeFolder(value: string): boolean {
  return value.length <= 260 && FOLDER.test(value.trim());
}

/** What a variable of this name is meant to hold: a folder (…_HOME, …_ROOT, …_DIR, …_PATH, GOPATH …) or anything. */
export function expectsFolder(name: string): boolean {
  return /(_HOME|_ROOT|_DIR|_PATH|_PREFIX)$/i.test(name) || /^(?:GOPATH|GOROOT|GRADLE_USER_HOME|NVM_HOME|NVM_SYMLINK|CARGO_HOME|RUSTUP_HOME|PYTHONHOME|ANDROID_HOME|ANDROID_SDK_ROOT)$/i.test(name);
}

export interface ValueFacts {
  /** Whether the folder the value names exists (only asked for a value that looks like a folder). */
  readonly folderExists: (folder: string) => boolean;
  /** Whether this file exists (for JAVA_HOME: bin\java.exe). */
  readonly fileExists: (file: string) => boolean;
}

/** Whether this is a sensible value for this variable. The reasons are the ones a person can act on. */
export function checkValue(name: string, value: string, facts: ValueFacts): Verdict {
  if (value === '') return no('The value is empty. To remove the variable, say so and I will remove it.');
  if (value.length > 2000) return no('That value is too long (the most is 2000 characters).');
  if (/[\x00-\x08\x0a-\x1f]/.test(value)) return no('The value has a line break or a control character in it, which Windows would not keep.');
  const trimmed = value.trim();
  if (name.toUpperCase() === 'JAVA_HOME') {
    if (!looksLikeFolder(trimmed)) return no('JAVA_HOME is the folder Java is installed in, for example C:\\Program Files\\Eclipse Adoptium\\jdk-17.0.9.9-hotspot.');
    if (/[\\/]bin[\\/]?$/i.test(trimmed)) return no(`JAVA_HOME is the Java folder itself, not its "bin" folder: use ${trimmed.replace(/[\\/]bin[\\/]?$/i, '')} instead.`);
    if (!/%/.test(trimmed)) {
      if (!facts.folderExists(trimmed)) return no(`The folder ${trimmed} does not exist.`);
      if (!facts.fileExists(`${trimmed.replace(/[\\/]+$/, '')}\\bin\\java.exe`)) return no(`${trimmed} is not a Java folder: it has no bin\\java.exe in it.`);
    }
    return yes;
  }
  if (expectsFolder(name) && looksLikeFolder(trimmed) && !/%/.test(trimmed) && !facts.folderExists(trimmed)) return no(`The folder ${trimmed} does not exist, so ${name} would point at nothing.`);
  return yes;
}

/** The kind the registry keeps a value as: a value with a %VARIABLE% in it must be expandable, or Windows would use the percent signs literally. */
export function kindFor(value: string, existing?: 'String' | 'ExpandString'): 'String' | 'ExpandString' {
  return /%[A-Za-z_][A-Za-z0-9_]*%/.test(value) ? 'ExpandString' : (existing ?? 'String');
}

// ------------------------------------------------------------------------------------------------------------------------------------ PATH
export const splitPath = (value: string): string[] => value.split(';').map((e) => e.trim()).filter((e) => e !== '');
export const joinPath = (entries: readonly string[]): string => entries.join(';');
/** How two PATH entries are compared: case and a closing slash do not matter, and forward slashes are backslashes. */
export const pathKey = (entry: string): string => entry.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

/** Whether this is a folder that may be put on the PATH (a plain folder path: see `looksLikeFolder`). */
export function checkPathFolder(folder: string): Verdict {
  const f = folder.trim();
  if (f === '') return no('Which folder? Give the full path, for example C:\\Program Files\\nodejs.');
  if (!looksLikeFolder(f)) return no('That is not a folder path: give the whole path, like C:\\Program Files\\nodejs (no semicolons, quotes or wildcards).');
  if (/^[A-Za-z]:[\\/]?$/.test(f)) return no('A whole drive is not put on the PATH.');
  return yes;
}

export interface PathChange {
  readonly entries: readonly string[];
  readonly changed: boolean;
  /** What happened, in words (also when nothing changed, and why). */
  readonly say: string;
}

export function pathAdd(entries: readonly string[], folder: string, position: 'start' | 'end'): PathChange {
  // (written the way Windows writes it: backslashes, and no closing one)
  const f = folder.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  if (entries.some((e) => pathKey(e) === pathKey(f))) return { entries, changed: false, say: `${f} is already on the PATH.` };
  const next = position === 'start' ? [f, ...entries] : [...entries, f];
  return { entries: next, changed: true, say: `${f} is added at the ${position} of the PATH.` };
}

export function pathRemove(entries: readonly string[], folder: string): PathChange {
  const key = pathKey(folder);
  const next = entries.filter((e) => pathKey(e) !== key);
  return next.length === entries.length ? { entries, changed: false, say: `${folder.trim()} is not on the PATH.` } : { entries: next, changed: true, say: `${folder.trim()} is taken off the PATH.` };
}

export interface PathClean extends PathChange {
  readonly missing: readonly string[];
  readonly duplicates: readonly string[];
}

/** Takes off the entries that point at a folder that is not there, and the ones that appear twice (the first stays). An entry with a %VARIABLE% in it is judged by `exists` after expanding. */
export function pathClean(entries: readonly string[], exists: (entry: string) => boolean): PathClean {
  const seen = new Set<string>();
  const kept: string[] = [];
  const missing: string[] = [];
  const duplicates: string[] = [];
  for (const e of entries) {
    const key = pathKey(e);
    if (seen.has(key)) {
      duplicates.push(e);
      continue;
    }
    seen.add(key);
    if (!exists(e)) {
      missing.push(e);
      continue;
    }
    kept.push(e);
  }
  const changed = missing.length + duplicates.length > 0;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`${missing.length} folder${missing.length === 1 ? '' : 's'} that no longer exist${missing.length === 1 ? 's' : ''}`);
  if (duplicates.length > 0) parts.push(`${duplicates.length} repeated entr${duplicates.length === 1 ? 'y' : 'ies'}`);
  return { entries: kept, changed, say: changed ? `The PATH has ${parts.join(' and ')}.` : 'The PATH is clean: every folder on it exists and none is repeated.', missing, duplicates };
}

/** The part of a value that may be shown or spoken: a secret name's value never is. */
export function shownValue(name: string, value: string): string {
  return isSecretName(name) ? '(hidden: it is private)' : value.length > 200 ? `${value.slice(0, 200)}…` : value;
}
