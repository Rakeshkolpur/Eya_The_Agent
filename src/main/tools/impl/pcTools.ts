import { rootLogger } from '@main/logging/logger';
import { permissionRequest } from '@main/permissions/PermissionManager';
import type { SensitiveAction } from '@main/permissions/PermissionManager';
import { CHECK_TOPICS, runCheck } from '@main/pc/pcCheck';
import type { CheckTopic } from '@main/pc/pcCheck';
import { checkComputerName } from '@main/pc/computerName';
import { checkName, checkPathFolder, checkValue, isSecretName, joinPath, kindFor, pathAdd, pathClean, pathRemove, shownValue, splitPath } from '@main/pc/envPolicy';
import type { EnvState, PcJournal } from '@main/pc/PcJournal';
import type { EnvEntry, PcSystem } from '@main/pc/pcSystem';
import { BOX_WARNING, whileWatching as watchBox } from '@main/pc/permissionWatch';
import type { WatchWords } from '@main/pc/permissionWatch';
import { isPackageId, isSearchQuery, listsPackage, parseSearch, parseShow, tailOf } from '@main/pc/winget';
import type { Tool, ToolArgs, ToolResult } from '../types';

const log = rootLogger.child('tools.pc');

/** How long an install may take (a few minutes is usual; a big one more). */
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const TEMP_DAYS_DEFAULT = 2;
const WINGET_COMMON = ['--accept-source-agreements', '--disable-interactivity'] as const;

export interface PcToolDeps {
  readonly sys: PcSystem;
  readonly journal: PcJournal;
  /**
   * Says something to the person at once, spoken and shown in the chat, while a tool is still working. It is how they are told that Windows' own permission box is waiting for their Yes: that box
   * is drawn by Windows on its own screen, and a person who is not told does not know that Eya is waiting for them.
   */
  readonly notify?: (text: string) => void;
  /** How often the permission box is looked for while an install, an uninstall or a rename waits (ms; 1000). */
  readonly pollMs?: number;
  /** How long a rename waits without seeing the box before it says it is still waiting (ms; 8000). */
  readonly stillWaitingMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const str = (args: ToolArgs, key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string) : undefined);

/** The question a change asks first (the same shape as the restart and shutdown tools: the model asks it, and calls again with confirm only after the person said yes). */
export function asks(action: SensitiveAction, target: string, question: string, reason: string): ToolResult {
  return { ok: false, summary: 'needs confirmation', error: question, data: permissionRequest(action, target, reason) };
}

export const fail = (summary: string, error: string, data?: Readonly<Record<string, unknown>>): ToolResult => ({ ok: false, summary, error, ...(data !== undefined ? { data } : {}) });

const sameState = (a: EnvState, b: EnvState): boolean => a.exists === b.exists && a.value === b.value;
const stateOf = (e: EnvEntry | undefined): EnvState => (e === undefined ? { exists: false, value: '', kind: 'String' } : { exists: true, value: e.value, kind: e.kind });
const findEnv = (vars: Record<string, EnvEntry>, name: string): [string, EnvEntry] | undefined => Object.entries(vars).find(([n]) => n.toUpperCase() === name.toUpperCase());

/**
 * The tools that find out what is wrong with this PC and fix the usual things — each typed and narrow, never a command shell. Reading is free; every change asks first with the exact words of what will
 * happen, is verified by reading it back, and is written down (so "undo that" works). Only the USER's own environment is changed (never the machine's), never a name Windows relies on, and nothing
 * about security settings (Defender, the firewall, user-account control, updates): those are the person's.
 *
 * What needs administrator rights (renaming the PC; an installer that asks for them) goes through Windows' own permission box and the PERSON answers it: Eya never clicks it, never types a password,
 * never holds rights of her own, and tells the person aloud when the box is open so that they know it is waiting for their Yes. A "No" is a plain "you said no, nothing changed".
 */
export function createPcTools(deps: PcToolDeps): Tool[] {
  const { sys, journal } = deps;
  const facts = { folderExists: (f: string): boolean => sys.folderExists(f), fileExists: (f: string): boolean => sys.fileExists(f) };
  const pollMs = deps.pollMs ?? 1_000;
  const stillWaitingMs = deps.stillWaitingMs ?? 8_000;
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const say = (text: string): void => {
    try {
      deps.notify?.(text);
    } catch (err) {
      log.warn('a note to the person could not be sent', { err: String(err).slice(0, 120) });
    }
  };

  /** Runs something that may stop at Windows' permission box and tells the person when it is open (see permissionWatch.ts). */
  const whileWatching = <T>(work: Promise<T>, words: WatchWords): Promise<{ readonly value: T; readonly sawBox: boolean }> =>
    watchBox({ box: () => sys.permissionBoxOpen(), say, pollMs, stillWaitingMs, sleep }, work, words);

  const pcCheck: Tool = {
    schema: {
      name: 'pc_check',
      status: 'Looking at the PC…',
      description:
        'Look at this PC to find out what is wrong (read only, changes nothing). topic: "overview" (Windows version, disk space, a restart waiting, winget), "environment" (the variables, and any that point at a missing folder or JAVA_HOME that is ' +
        'wrong), "path" (the PATH: missing folders, repeats), "tool" with program set to node, npm, python, pip, git, java, javac, mvn, gradle, dotnet, go, rustc, cargo, docker, code, pwsh, curl, ffmpeg, adb or winget (is it ' +
        'installed, which version, is its folder on the PATH — the usual cause of "is not recognized"), "disk" (free space, old temporary files) or "network" (internet, DNS, proxy). Start here for any "not working" problem, say what the ' +
        'findings mean in plain words, and only then offer ONE fix.',
      args: {
        topic: { type: 'string', required: true, enum: CHECK_TOPICS, description: 'What to look at.' },
        program: { type: 'string', description: 'For topic "tool": the program, for example node or java.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const topic = str(args, 'topic') as CheckTopic | undefined;
      if (topic === undefined || !CHECK_TOPICS.includes(topic)) return fail('unknown topic', `Choose one of: ${CHECK_TOPICS.join(', ')}.`);
      try {
        const r = await runCheck(sys, topic, str(args, 'program') ?? '');
        return { ok: true, summary: r.findings.length === 0 ? `nothing wrong found (${topic})` : `${r.findings.length} thing${r.findings.length === 1 ? '' : 's'} found (${topic})`, data: { topic: r.topic, findings: r.findings, facts: r.facts } };
      } catch (err) {
        log.warn('a PC check failed', { topic, err: String(err).slice(0, 200) });
        return fail('could not look', `I could not look at that: ${err instanceof Error ? err.message.slice(0, 160) : 'something went wrong'}.`);
      }
    },
  };

  // ------------------------------------------------------------------------------------------------------------------------------ environment variables
  const setEnv: Tool = {
    schema: {
      name: 'set_environment_variable',
      status: 'Setting the variable…',
      requiresConfirmation: true,
      description:
        'Set an environment variable for THIS USER (for example JAVA_HOME, ANDROID_HOME, a project\'s setting). It changes only the user\'s own variables — never the machine\'s (that needs administrator rights, which Eya does not use) — and never ' +
        'PATH (use edit_user_path) or a name Windows relies on. A variable that points at a folder is refused when the folder does not exist; JAVA_HOME must be the Java folder itself (with bin\\java.exe inside), not its bin folder. ' +
        'ALWAYS needs the user\'s yes first: the first call (without confirm) changes nothing and returns exactly the question to ask. Call again with confirm: true only after they clearly agreed. Programs already open do not see ' +
        'the change; a NEW terminal does. After it, say what was set and that a new terminal is needed.',
      args: {
        name: { type: 'string', required: true, description: 'The variable name, letters digits and underscores, for example JAVA_HOME.' },
        value: { type: 'string', required: true, description: 'The value, exactly as the user said it (for a folder, the full path).' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const name = (str(args, 'name') ?? '').trim();
      const value = (str(args, 'value') ?? '').trim();
      const ruled = checkName(name);
      if (!ruled.ok) return fail('not allowed', ruled.say);
      const good = checkValue(name, value, facts);
      if (!good.ok) return fail('not a good value', good.say);
      try {
        const vars = await sys.readEnv('user');
        const old = findEnv(vars, name);
        const before = stateOf(old?.[1]);
        if (before.exists && before.value === value) return { ok: true, summary: 'already set', data: { name, changed: false, verified: true } };
        if (args['confirm'] !== true) {
          const now = before.exists ? `It is now ${shownValue(name, before.value)}.` : 'It is not set now.';
          return asks('set_environment_variable', name, `Set the ${name} variable for your user to ${shownValue(name, value)}? ${now} Programs that are already open will not see it; a new terminal will.`, `This changes your user environment variable ${name}.`);
        }
        const kind = kindFor(value, old?.[1].kind);
        await sys.writeEnv(old?.[0] ?? name, value, kind);
        const after = findEnv(await sys.readEnv('user'), name);
        const verified = after !== undefined && after[1].value === value;
        if (!verified) return fail('could not confirm', `I tried to set ${name}, but could not confirm it: ${after === undefined ? 'it is not there' : 'it holds something else'}.`);
        const secret = isSecretName(name);
        journal.record({ kind: 'env', name, what: `set ${name}${secret ? ' (private: its value is not kept)' : ''}`, before: secret ? null : before, after: secret ? null : { exists: true, value, kind } });
        log.info('an environment variable was set', { name, secret });
        const machine = findEnv(await sys.readEnv('machine'), name);
        return {
          ok: true,
          summary: `${name} is set`,
          data: { name, changed: true, verified: true, evidence: 'read back from the registry', value: shownValue(name, value), note: `Open a NEW terminal (or restart the program) to see it.${machine !== undefined ? ` A machine-wide ${name} also exists: yours wins for this user.` : ''}`, undo: secret ? 'not available for a private value' : 'say "undo that"' },
        };
      } catch (err) {
        log.warn('setting a variable failed', { name, err: String(err).slice(0, 160) });
        return fail('could not set it', `I could not set ${name}: ${err instanceof Error ? err.message.slice(0, 160) : 'Windows refused'}.`);
      }
    },
  };

  const removeEnv: Tool = {
    schema: {
      name: 'remove_environment_variable',
      status: 'Removing the variable…',
      requiresConfirmation: true,
      description:
        'Remove an environment variable from THIS USER\'s variables (never the machine\'s, never PATH, never one Windows relies on). ALWAYS needs the user\'s yes first: the first call (without confirm) changes nothing and returns the question; ' +
        'call again with confirm: true only after they clearly agreed. It can be undone ("undo that") unless the name looks private.',
      args: {
        name: { type: 'string', required: true, description: 'The variable name.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const name = (str(args, 'name') ?? '').trim();
      const ruled = checkName(name);
      if (!ruled.ok) return fail('not allowed', ruled.say);
      try {
        const old = findEnv(await sys.readEnv('user'), name);
        if (old === undefined) {
          const machine = findEnv(await sys.readEnv('machine'), name);
          return fail('not set', machine !== undefined ? `${name} is not one of your user variables. It is set machine-wide, which needs administrator rights to change: Windows Settings, System, About, Advanced system settings, Environment Variables.` : `${name} is not set.`);
        }
        if (args['confirm'] !== true) return asks('set_environment_variable', name, `Remove the ${name} variable from your user variables? It is now ${shownValue(name, old[1].value)}.`, `This removes your user environment variable ${name}.`);
        const before = stateOf(old[1]);
        await sys.deleteEnv(old[0]);
        const verified = findEnv(await sys.readEnv('user'), name) === undefined;
        if (!verified) return fail('could not confirm', `I tried to remove ${name}, but it is still there.`);
        const secret = isSecretName(name);
        journal.record({ kind: 'env', name, what: `removed ${name}${secret ? ' (private: its value is not kept)' : ''}`, before: secret ? null : before, after: secret ? null : { exists: false, value: '', kind: 'String' } });
        log.info('an environment variable was removed', { name, secret });
        return { ok: true, summary: `${name} is removed`, data: { name, changed: true, verified: true, evidence: 'read back from the registry', note: 'Open a NEW terminal to see it gone.', undo: secret ? 'not available for a private value' : 'say "undo that"' } };
      } catch (err) {
        return fail('could not remove it', `I could not remove ${name}: ${err instanceof Error ? err.message.slice(0, 160) : 'Windows refused'}.`);
      }
    },
  };

  const editPath: Tool = {
    schema: {
      name: 'edit_user_path',
      status: 'Changing the PATH…',
      requiresConfirmation: true,
      description:
        'Change the user\'s PATH (the list of folders a terminal looks in for programs): action "add" puts a folder on it (it must exist; position "end" by default), "remove" takes one off, "clean" takes off the folders that no longer exist and the ' +
        'repeated ones. Only the USER\'s PATH — the machine\'s needs administrator rights, which Eya does not use. This is the usual fix for "\'node\' is not recognized". ALWAYS needs the user\'s yes first: the first call (without confirm) ' +
        'changes nothing and returns exactly what would change; call again with confirm: true only after they clearly agreed. Say afterwards that a NEW terminal is needed. It can be undone ("undo that").',
      args: {
        action: { type: 'string', required: true, enum: ['add', 'remove', 'clean'], description: 'add, remove or clean.' },
        folder: { type: 'string', description: 'The full folder path, for add and remove, for example C:\\Program Files\\nodejs.' },
        position: { type: 'string', enum: ['start', 'end'], description: 'For add: where on the list (end by default; start makes it win over a program of the same name).' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const action = str(args, 'action');
      const folder = (str(args, 'folder') ?? '').trim();
      const position = str(args, 'position') === 'start' ? 'start' : 'end';
      if (action !== 'add' && action !== 'remove' && action !== 'clean') return fail('unknown action', 'Choose add, remove or clean.');
      try {
        const vars = await sys.readEnv('user');
        const found = findEnv(vars, 'PATH');
        const oldValue = found?.[1].value ?? '';
        const entries = splitPath(oldValue);
        let change: { entries: readonly string[]; changed: boolean; say: string };
        if (action === 'clean') {
          change = pathClean(entries, (e) => sys.folderExists(e));
        } else {
          const ruled = checkPathFolder(folder);
          if (!ruled.ok) return fail('not a folder', ruled.say);
          if (action === 'add') {
            if (!sys.folderExists(folder)) return fail('no such folder', `The folder ${folder} does not exist, so putting it on the PATH would do nothing.`);
            change = pathAdd(entries, folder, position);
          } else {
            change = pathRemove(entries, folder);
          }
        }
        if (!change.changed) return { ok: true, summary: 'nothing to change', data: { changed: false, verified: true, note: change.say } };
        if (args['confirm'] !== true) {
          const detail = action === 'clean' ? ` (${[...(change as ReturnType<typeof pathClean>).missing, ...(change as ReturnType<typeof pathClean>).duplicates].slice(0, 6).join('; ')}${(change as ReturnType<typeof pathClean>).missing.length + (change as ReturnType<typeof pathClean>).duplicates.length > 6 ? '; …' : ''})` : '';
          return asks('edit_user_path', 'the user PATH', `${change.say}${detail} Change your user PATH like that? Programs that are already open will not see it; a new terminal will.`, 'This changes the PATH of your user account.');
        }
        const next = joinPath(change.entries);
        const kind = kindFor(next, found?.[1].kind ?? 'ExpandString');
        await sys.writeEnv(found?.[0] ?? 'Path', next, kind);
        const after = findEnv(await sys.readEnv('user'), 'PATH');
        const verified = after !== undefined && after[1].value === next;
        if (!verified) return fail('could not confirm', 'I tried to change the PATH, but could not confirm it: Windows kept something else.');
        journal.record({ kind: 'path', name: 'PATH', what: change.say, before: { exists: found !== undefined, value: oldValue, kind: found?.[1].kind ?? 'ExpandString' }, after: { exists: true, value: next, kind } });
        log.info('the user PATH was changed', { action, entries: change.entries.length });
        return { ok: true, summary: 'the PATH is changed', data: { changed: true, verified: true, evidence: 'read back from the registry', what: change.say, note: 'Open a NEW terminal to use it.', undo: 'say "undo that"' } };
      } catch (err) {
        log.warn('changing the PATH failed', { err: String(err).slice(0, 160) });
        return fail('could not change it', `I could not change the PATH: ${err instanceof Error ? err.message.slice(0, 160) : 'Windows refused'}.`);
      }
    },
  };

  // ------------------------------------------------------------------------------------------------------------------------------ programs
  const findProgram: Tool = {
    schema: {
      name: 'find_program',
      status: 'Looking for the program…',
      description:
        'Search the Windows Package Manager (winget) for a program (read only): returns up to 8 packages with their exact ids. Use it before install_program, tell the user which one you mean, and never guess an id. ' +
        'With installed: true it looks among the programs ALREADY installed on this PC instead (use that before uninstall_program).',
      args: {
        query: { type: 'string', required: true, description: 'The program name, for example "git" or "vs code".' },
        installed: { type: 'boolean', description: 'true: look among the programs already installed on this PC (before uninstalling one).' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const query = (str(args, 'query') ?? '').trim();
      const installedOnly = args['installed'] === true;
      if (!isSearchQuery(query)) return fail('not a search', 'Give me the name of the program: letters, numbers and spaces.');
      const r = await sys.run('winget', installedOnly ? ['list', '--query', query, ...WINGET_COMMON] : ['search', '--query', query, '--source', 'winget', ...WINGET_COMMON], 60_000);
      if (r.code === null) return fail('winget is not available', 'The Windows Package Manager (winget) is not available on this PC, so I cannot search or install. Installing "App Installer" from the Microsoft Store brings it.');
      // (a list also has an "Available" column after the version: only the version itself is kept)
      const hits = parseSearch(r.stdout).map((h) => ({ ...h, version: h.version.split(/\s+/)[0] ?? '' }));
      if (hits.length === 0) {
        return {
          ok: true,
          summary: 'nothing found',
          data: { query, packages: [], note: installedOnly ? 'winget does not list a program with that name that I can remove by name. If it is installed, remove it in Windows Settings, Apps.' : 'winget found no package with that name. Try another spelling, or the maker\'s own website.' },
        };
      }
      return { ok: true, summary: `${hits.length} package${hits.length === 1 ? '' : 's'} found`, data: { query, installed: installedOnly, packages: hits } };
    },
  };

  const installProgram: Tool = {
    schema: {
      name: 'install_program',
      status: 'Installing the program…',
      requiresConfirmation: true,
      description:
        'Install a program with the Windows Package Manager (winget, its own "winget" source only — never a downloaded file or an address). Use the EXACT id from find_program (or the one pc_check names). ALWAYS needs the user\'s yes first: ' +
        'the first call (without confirm) installs nothing and returns the question naming the program, its version and its maker (the question already tells the user that Windows will show a permission box they must click Yes on: say it in your own words too); ' +
        'call again with confirm: true only after they clearly agreed. While it installs, Eya herself tells the user when the box is open (you do not need to); the user answers it, Eya never clicks it. An install can take a few minutes. It is checked afterwards. ' +
        'If the result says the box was shown and the program is not installed, the user probably clicked No: say that nothing was installed and offer to try again. Say afterwards that a NEW terminal is needed to use it.',
      args: {
        id: { type: 'string', required: true, description: 'The exact winget package id, for example Git.Git.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const id = (str(args, 'id') ?? '').trim();
      if (!isPackageId(id)) return fail('not a package id', 'That is not a package id. Use find_program to look the program up, and give me its exact id.');
      const shown = await sys.run('winget', ['show', '--id', id, '--exact', '--source', 'winget', ...WINGET_COMMON], 60_000);
      if (shown.code === null) return fail('winget is not available', 'The Windows Package Manager (winget) is not available on this PC, so I cannot install programs. Installing "App Installer" from the Microsoft Store brings it.');
      const info = parseShow(shown.stdout);
      if (info === null) return fail('no such package', `winget has no package with the exact id ${id}. Use find_program to look the program up.`);
      if (args['confirm'] !== true) {
        const admin = await sys.adminAccount().catch(() => true);
        return asks('install_program', info.name, `Install ${info.name}${info.version !== '' ? ` ${info.version}` : ''}${info.publisher !== '' ? ` by ${info.publisher}` : ''} from the official Windows Package Manager? ${BOX_WARNING(admin)} It can take a few minutes.`, 'This installs software on the PC.');
      }
      const { value: done, sawBox } = await whileWatching(sys.run('winget', ['install', '--id', id, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', ...WINGET_COMMON], INSTALL_TIMEOUT_MS), {
        opened: `Windows is asking for your permission to install ${info.name}. Click Yes on the box so the install can go on; if you cannot see it, look for a flashing shield icon on the taskbar. I will wait.`,
        again: `Windows is asking for your permission again to install ${info.name}. Click Yes to go on.`,
      });
      const listed = await sys.run('winget', ['list', '--id', id, '--exact', ...WINGET_COMMON], 60_000);
      const installed = listed.code === 0 && listsPackage(listed.stdout, id);
      const output = `${done.stdout}\n${done.stderr}`;
      if (done.timedOut) return fail('took too long', `The install of ${info.name} was still running after fifteen minutes, so I stopped waiting.${sawBox ? ' Windows showed its permission box: it may have been waiting for a Yes.' : ''} Check Windows Settings, Apps, or try again.`);
      if (!installed) {
        return fail(
          'not installed',
          `${info.name} was not installed${done.code !== null ? ` (winget said ${tailOf(output) || `code ${done.code}`})` : ''}. ${sawBox ? 'Windows showed its permission box: if you clicked No, nothing was installed. Ask me again and click Yes.' : 'If Windows showed a permission box, it has to be answered with Yes.'}`,
          { permissionBoxShown: sawBox },
        );
      }
      journal.record({ kind: 'install', name: id, what: `installed ${info.name}${info.version !== '' ? ` ${info.version}` : ''}`, before: null, after: null });
      log.info('a program was installed', { id });
      return {
        ok: true,
        summary: `${info.name} is installed`,
        data: { id, name: info.name, version: info.version, verified: true, evidence: 'winget lists it as installed', restartNeeded: /restart|reboot/i.test(output), note: 'Open a NEW terminal (or restart the program) to use it; a program that needs its folder on the PATH is found there after that.' },
      };
    },
  };

  const uninstallProgram: Tool = {
    schema: {
      name: 'uninstall_program',
      status: 'Removing the program…',
      requiresConfirmation: true,
      description:
        'Uninstall a program with the Windows Package Manager (winget). Use the EXACT id from find_program with installed: true; a program winget cannot name is removed by the user in Windows Settings, Apps. ALWAYS needs the user\'s yes first: the first call ' +
        '(without confirm) removes nothing and returns the question naming the program (it already says that Windows will show a permission box they must click Yes on); call again with confirm: true only after they clearly agreed. Eya tells the user ' +
        'when the box is open; the user answers it, Eya never clicks it. It is checked afterwards. It cannot be undone from here (install it again with install_program).',
      args: {
        id: { type: 'string', required: true, description: 'The exact winget package id of an installed program, for example Git.Git.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const id = (str(args, 'id') ?? '').trim();
      if (!isPackageId(id)) return fail('not a package id', 'That is not a package id. Use find_program with installed: true to look the program up, and give me its exact id.');
      const listed = await sys.run('winget', ['list', '--id', id, '--exact', ...WINGET_COMMON], 60_000);
      if (listed.code === null) return fail('winget is not available', 'The Windows Package Manager (winget) is not available on this PC, so I cannot remove programs. Remove it in Windows Settings, Apps.');
      if (!(listed.code === 0 && listsPackage(listed.stdout, id))) return fail('not installed', `${id} is not installed (winget does not list it), so there is nothing to remove.`);
      const row = parseSearch(listed.stdout).find((h) => h.id.toLowerCase() === id.toLowerCase());
      const name = row?.name ?? id;
      const version = (row?.version ?? '').split(/\s+/)[0] ?? '';
      if (args['confirm'] !== true) {
        const admin = await sys.adminAccount().catch(() => true);
        return asks('uninstall_program', name, `Uninstall ${name}${version !== '' ? ` ${version}` : ''} from this PC? ${BOX_WARNING(admin)} I will not touch your own documents. It cannot be undone from here.`, 'This removes software from the PC.');
      }
      const { value: done, sawBox } = await whileWatching(sys.run('winget', ['uninstall', '--id', id, '--exact', '--silent', ...WINGET_COMMON], INSTALL_TIMEOUT_MS), {
        opened: `Windows is asking for your permission to remove ${name}. Click Yes on the box so I can go on; if you cannot see it, look for a flashing shield icon on the taskbar. I will wait.`,
        again: `Windows is asking for your permission again to remove ${name}. Click Yes to go on.`,
      });
      const after = await sys.run('winget', ['list', '--id', id, '--exact', ...WINGET_COMMON], 60_000);
      const gone = !(after.code === 0 && listsPackage(after.stdout, id));
      const output = `${done.stdout}\n${done.stderr}`;
      if (done.timedOut) return fail('took too long', `Removing ${name} was still running after fifteen minutes, so I stopped waiting.${sawBox ? ' Windows showed its permission box: it may have been waiting for a Yes.' : ''}`);
      if (!gone) {
        return fail(
          'still installed',
          `${name} is still installed${done.code !== null ? ` (winget said ${tailOf(output) || `code ${done.code}`})` : ''}. ${sawBox ? 'Windows showed its permission box: if you clicked No, nothing was removed. Ask me again and click Yes.' : 'If Windows showed a permission box, it has to be answered with Yes.'}`,
          { permissionBoxShown: sawBox },
        );
      }
      journal.record({ kind: 'uninstall', name: id, what: `uninstalled ${name}${version !== '' ? ` ${version}` : ''}`, before: null, after: null });
      log.info('a program was uninstalled', { id });
      return { ok: true, summary: `${name} is removed`, data: { id, name, verified: true, evidence: 'winget no longer lists it', note: 'To get it back, ask me to install it again.' } };
    },
  };

  // ------------------------------------------------------------------------------------------------------------------------------ renaming the PC
  const renamePc: Tool = {
    schema: {
      name: 'rename_pc',
      status: 'Renaming the PC…',
      requiresConfirmation: true,
      description:
        'Rename THIS PC: its computer name (Windows Settings, System, About; and the name it has on the network). ALWAYS use this for "rename my PC": never open Settings and click through About. A PC name has only letters, numbers and hyphens (no spaces) ' +
        'and at most 15 characters: "Rakhi\'s PC" becomes something like Rakhis-PC (the tool says what it would accept). Renaming needs administrator rights, so Windows shows its own permission box and the USER clicks Yes: Eya never clicks it, ' +
        'never types a password, never has rights of her own. ALWAYS needs the user\'s yes first: the first call (without confirm) changes nothing and returns the question (it already says about the box and the restart: say it in your own words). ' +
        'Call again with confirm: true only after they clearly agreed. While it waits Eya herself tells the user when the box is open. The new name starts after a restart: say so, offer a restart (restart_computer asks again; they should save open work first) ' +
        'and do not restart unless they say yes. If the result says they clicked No, say that nothing changed and offer to try again.',
      args: {
        name: { type: 'string', required: true, description: 'The new name, for example Rakhi.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const ruled = checkComputerName(str(args, 'name') ?? '');
      if (!ruled.ok) return fail('not a good name', ruled.say);
      const name = ruled.name;
      const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
      try {
        const names = await sys.computerNames();
        if (same(names.pending, name)) {
          return same(names.active, name)
            ? { ok: true, summary: 'already named that', data: { name, changed: false, verified: true } }
            : { ok: true, summary: 'already renamed, waiting for a restart', data: { name, changed: false, verified: true, restartNeeded: true, note: `This PC is already set to be called ${name}: the name starts after a restart.` } };
        }
        if (args['confirm'] !== true) {
          const admin = await sys.adminAccount().catch(() => true);
          return asks('rename_pc', name, `Rename this PC from ${names.pending} to ${name}? ${BOX_WARNING(admin)} The new name starts after a restart; I will not restart the PC unless you ask me to.`, 'This renames the PC.');
        }
        const { value: result, sawBox } = await whileWatching(sys.renameComputer(name), {
          opened: 'Windows is asking for your permission to rename the PC. Click Yes on the box; if you cannot see it, look for a flashing shield icon on the taskbar. I will wait.',
          again: 'Windows is asking for your permission again. Click Yes to go on.',
          stillWaiting: 'I am still waiting for Windows. If a permission box is on your screen, click Yes on it; if you see a flashing shield on the taskbar, click that first.',
        });
        // (what Windows now holds is what counts, not what the command said: a Yes that came late still changed it)
        const after = await sys.computerNames();
        if (same(after.pending, name)) {
          journal.record({ kind: 'rename', name: 'computer name', what: `renamed the PC from ${names.pending} to ${name}`, before: { exists: true, value: names.pending, kind: 'String' }, after: { exists: true, value: name, kind: 'String' } });
          log.info('the PC was renamed', { restartNeeded: !same(after.active, name) });
          return {
            ok: true,
            summary: `the PC is renamed to ${name}`,
            data: { from: names.pending, to: name, changed: true, verified: true, evidence: 'Windows now holds the new name', restartNeeded: !same(after.active, name), note: `The new name starts after a restart. Ask if they want to restart now (restart_computer asks again; they should save their open work first).`, undo: `ask me to rename it back to ${names.pending}` },
          };
        }
        if (result.outcome === 'declined') return fail('you said no', 'You clicked No on the Windows permission box, so the name was not changed. Say the word and I will ask again.', { permissionBoxShown: sawBox });
        if (result.outcome === 'timed_out') return fail('no answer', 'I waited five minutes and the permission box was not answered, so the name was not changed.', { permissionBoxShown: sawBox });
        return fail('not renamed', `Windows did not rename the PC${result.code !== null ? ` (code ${result.code})` : ''}. ${sawBox ? 'You did click through the permission box, so Windows itself refused the name.' : 'If a permission box was shown, it has to be answered with Yes.'}`, { permissionBoxShown: sawBox });
      } catch (err) {
        log.warn('renaming the PC failed', { err: String(err).slice(0, 160) });
        return fail('could not rename', `I could not rename the PC: ${err instanceof Error ? err.message.slice(0, 160) : 'Windows refused'}.`);
      }
    },
  };

  // ------------------------------------------------------------------------------------------------------------------------------ quick fixes
  const flushDns: Tool = {
    schema: {
      name: 'flush_dns',
      status: 'Clearing the DNS cache…',
      description: 'Clear the DNS cache (the list of website addresses Windows remembers). The usual first fix when a website will not open but others do. No confirmation needed; it is harmless and checked afterwards.',
      args: {},
    },
    async execute(): Promise<ToolResult> {
      const r = await sys.run('ipconfig', ['/flushdns'], 15_000);
      const text = `${r.stdout}\n${r.stderr}`;
      if (/successfully flushed/i.test(text)) return { ok: true, summary: 'the DNS cache is cleared', data: { verified: true, evidence: 'Windows said it flushed the cache' } };
      if (/access is denied|requires elevation|administrator/i.test(text)) return fail('needs administrator rights', 'Windows only lets an administrator clear the DNS cache on this PC. Open Command Prompt as administrator and run: ipconfig /flushdns');
      return fail('did not work', 'Windows did not clear the DNS cache.');
    },
  };

  const clearTemp: Tool = {
    schema: {
      name: 'clear_temp_files',
      status: 'Clearing temporary files…',
      requiresConfirmation: true,
      description:
        'Delete the temporary files in the user\'s own temp folder that have not been touched for a couple of days (frees space; a program that is still using a file keeps it). Nothing else is touched. ALWAYS needs the user\'s yes first: ' +
        'the first call (without confirm) deletes nothing and returns how many files and how much space; call again with confirm: true only after they clearly agreed. It cannot be undone.',
      args: { confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' } },
    },
    async execute(args): Promise<ToolResult> {
      const olderThan = TEMP_DAYS_DEFAULT * 24 * 3600_000;
      const scan = sys.scanTemp(olderThan);
      if (scan.oldFiles === 0) return { ok: true, summary: 'nothing to clear', data: { changed: false, note: 'There are no old temporary files.' } };
      const mb = Math.round(scan.oldBytes / (1024 * 1024));
      if (args['confirm'] !== true) return asks('clear_temp_files', scan.dir, `Delete ${scan.oldFiles} temporary files (about ${mb} MB) from ${scan.dir} that have not been used for ${TEMP_DAYS_DEFAULT} days? Files that are in use are kept. This cannot be undone.`, 'This deletes files.');
      const done = sys.clearTemp(olderThan);
      journal.record({ kind: 'temp', name: 'temporary files', what: `cleared ${done.removed} temporary files (${Math.round(done.bytes / (1024 * 1024))} MB)`, before: null, after: null });
      return { ok: true, summary: `${done.removed} temporary files cleared`, data: { changed: true, verified: true, removed: done.removed, freedMb: Math.round(done.bytes / (1024 * 1024)), keptInUse: done.skipped, evidence: 'counted as they were removed' } };
    },
  };

  const restartExplorer: Tool = {
    schema: {
      name: 'restart_explorer',
      status: 'Restarting File Explorer…',
      requiresConfirmation: true,
      description:
        'Restart Windows Explorer (the taskbar, Start menu and desktop). The usual fix when the taskbar or Start menu is frozen or missing. Open File Explorer windows close and the taskbar flickers. ALWAYS needs the user\'s yes first: the ' +
        'first call (without confirm) does nothing and returns the question; call again with confirm: true only after they clearly agreed.',
      args: { confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' } },
    },
    async execute(args): Promise<ToolResult> {
      if (args['confirm'] !== true) return asks('restart_explorer', 'File Explorer', 'Restart the taskbar and File Explorer? Open File Explorer windows will close, and the taskbar flickers for a moment.', 'This restarts the Windows shell.');
      await sys.run('taskkill', ['/F', '/IM', 'explorer.exe'], 10_000);
      sys.start('explorer.exe', []);
      let running = false;
      for (let i = 0; i < 8 && !running; i += 1) {
        await new Promise<void>((r) => setTimeout(r, 500));
        running = await sys.isProcessRunning('explorer.exe');
      }
      return running ? { ok: true, summary: 'Explorer is restarted', data: { verified: true, evidence: 'explorer.exe is running again' } } : fail('did not come back', 'Explorer did not come back by itself. Press Ctrl+Shift+Esc, then File, Run new task, type explorer and press Enter.');
    },
  };

  // ------------------------------------------------------------------------------------------------------------------------------ the record, and undoing
  const listChanges: Tool = {
    schema: { name: 'list_pc_changes', status: 'Looking at what I changed…', description: 'List what Eya changed on this PC (variables, PATH, installs and removals, the PC\'s name, cleared files), newest last, with what each one was before. Read only.', args: {} },
    async execute(): Promise<ToolResult> {
      const list = journal.list().slice(-20).map((c) => ({ id: c.id, when: new Date(c.at).toISOString(), what: c.what, undone: c.undone, canUndo: !c.undone && (c.kind === 'env' || c.kind === 'path') && c.before !== null && c.after !== null }));
      return { ok: true, summary: list.length === 0 ? 'nothing changed yet' : `${list.length} change${list.length === 1 ? '' : 's'}`, data: { changes: list } };
    },
  };

  const undo: Tool = {
    schema: {
      name: 'undo_pc_change',
      status: 'Undoing the change…',
      requiresConfirmation: true,
      description:
        'Undo the last change Eya made to a variable or the PATH (or the one with this id from list_pc_changes): it puts back what was there before. An install, an uninstall, a rename or cleared files cannot be undone from here (say what to ask for instead). ' +
        'It is refused when the variable has been changed by something else since, so nothing of the user\'s is overwritten. ALWAYS needs the user\'s yes first: the first call (without confirm) changes nothing and returns the question; ' +
        'call again with confirm: true only after they clearly agreed.',
      args: {
        id: { type: 'string', description: 'Which change (from list_pc_changes); the last one by default.' },
        confirm: { type: 'boolean', description: 'Set true only after the user has clearly agreed.' },
      },
    },
    async execute(args): Promise<ToolResult> {
      const change = journal.find(str(args, 'id'));
      if (change === undefined) return fail('nothing to undo', 'There is nothing I changed that can be undone.');
      if (change.undone) return fail('already undone', `That change (${change.what}) was already undone.`);
      if (change.kind === 'install') return fail('cannot undo', `I cannot undo an install from here: remove it in Windows Settings, Apps.`);
      if (change.kind === 'temp') return fail('cannot undo', 'Deleted temporary files cannot be brought back.');
      if (change.kind === 'uninstall') return fail('cannot undo', 'I cannot bring back a program that was uninstalled from here: ask me to install it again.');
      if (change.kind === 'startup') return fail('use another tool', 'To undo that, ask me to turn the start-up apps back on (set_startup_apps with enabled true).');
      if (change.kind === 'stopped') return fail('use another tool', 'To undo that, ask me to start the stopped apps again (start_stopped_apps).');
      if (change.kind === 'command') return fail('cannot undo', 'A command cannot be undone from here: say what it should be changed back to, and I will do that.');
      if (change.kind === 'rename') return fail('cannot undo here', `To go back, ask me to rename the PC to ${change.before?.value ?? 'its old name'} (Windows will ask for the permission box again).`);
      if (change.before === null || change.after === null) return fail('cannot undo', `I did not keep the value of ${change.name} (it looks private), so I cannot put it back.`);
      try {
        const vars = await sys.readEnv('user');
        const now = findEnv(vars, change.name);
        if (!sameState(stateOf(now?.[1]), change.after)) return fail('changed since', `${change.name} has been changed since (by you or another program), so I will not overwrite it.`);
        if (args['confirm'] !== true) {
          const back = change.before.exists ? `back to ${shownValue(change.name, change.before.value)}` : 'removed again (it was not set before)';
          return asks('set_environment_variable', change.name, `Undo "${change.what}"? ${change.name} goes ${change.kind === 'path' ? 'back to how the PATH was before' : back}.`, `This puts your user ${change.name} back as it was.`);
        }
        if (change.before.exists) await sys.writeEnv(now?.[0] ?? change.name, change.before.value, change.before.kind);
        else await sys.deleteEnv(now?.[0] ?? change.name);
        const after = findEnv(await sys.readEnv('user'), change.name);
        const verified = change.before.exists ? after !== undefined && after[1].value === change.before.value : after === undefined;
        if (!verified) return fail('could not confirm', `I tried to undo it, but could not confirm that ${change.name} is back as it was.`);
        journal.markUndone(change.id);
        log.info('a PC change was undone', { name: change.name, kind: change.kind });
        return { ok: true, summary: 'undone', data: { changed: true, verified: true, evidence: 'read back from the registry', note: 'Open a NEW terminal to see it.' } };
      } catch (err) {
        return fail('could not undo', `I could not undo it: ${err instanceof Error ? err.message.slice(0, 160) : 'Windows refused'}.`);
      }
    },
  };

  return [pcCheck, setEnv, removeEnv, editPath, findProgram, installProgram, uninstallProgram, renamePc, flushDns, clearTemp, restartExplorer, listChanges, undo];
}
