import { describe, expect, it, vi } from 'vitest';
import { PcJournal } from '../src/main/pc/PcJournal';
import { createPcTools } from '../src/main/tools/impl/pcTools';
import { COMPUTER_NAME } from '../src/main/pc/computerName';
import { FakePc, MemIo, pcRig, wingetThatKnows } from './pcFixtures';

/**
 * What needs Windows' permission box (an install, an uninstall, renaming the PC): the person is told BEFORE that Windows will show a box and that they must click Yes, is told again aloud at the
 * moment the box is on the screen, and a "No" is said plainly. Eya never clicks the box and never has rights of her own.
 */

const GIT = { name: 'Git', id: 'Git.Git', version: '2.43.0', publisher: 'The Git Development Community' };
const hold = (): { gate: Promise<void>; release: () => void } => {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release };
};
const until = (check: () => boolean): Promise<void> =>
  vi.waitFor(
    () => {
      if (!check()) throw new Error('not yet');
    },
    { timeout: 3000, interval: 2 },
  );
const boxOn = (): boolean[] => new Array<boolean>(400).fill(true);
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('rename_pc: asks first, and says about the box and the restart', () => {
  it('changes nothing, and the question names both names, the permission box, the Yes and the restart', async () => {
    const { sys, call, notes } = pcRig();
    const asked = await call('rename_pc', { name: 'Rakhi' });
    expect(asked.ok).toBe(false);
    expect(asked.summary).toBe('needs confirmation');
    expect(asked.error).toContain('Rename this PC from DESKTOP-OLD1 to Rakhi?');
    expect(asked.error).toContain('permission box');
    expect(asked.error).toContain('click Yes');
    expect(asked.error).toContain('after a restart');
    expect(asked.error).toContain('I will not restart the PC unless you ask');
    expect(asked.data).toMatchObject({ status: 'permission_required', action: 'rename_pc' });
    expect(sys.renames).toEqual([]);
    expect(notes).toEqual([]);
  });

  it('a standard user (not an administrator) is told that Windows will ask for a password, which Eya never sees', async () => {
    const { sys, call } = pcRig();
    sys.adminAccountValue = false;
    const asked = await call('rename_pc', { name: 'Rakhi' });
    expect(asked.error).toContain("administrator's password");
    expect(asked.error).toContain('which I never see');
    const admin = pcRig();
    expect((await admin.call('rename_pc', { name: 'Rakhi' })).error).not.toContain('password');
  });
});

describe('rename_pc: names that are not allowed are refused before anything is asked or run', () => {
  it('"Rakhi\'s PC" is refused with Rakhis-PC offered, with and without the yes', async () => {
    const { sys, call } = pcRig();
    for (const confirm of [false, true]) {
      const r = await call('rename_pc', { name: "Rakhi's PC", confirm });
      expect(r.ok).toBe(false);
      expect(r.summary).toBe('not a good name');
      expect(r.error).toContain('How about Rakhis-PC?');
    }
    expect(sys.renames).toEqual([]);
  });

  it('a name with a command in it never reaches Windows, even with the yes', async () => {
    const { sys, call } = pcRig();
    for (const name of ["x'; Remove-Item C:\\ -Recurse; '", 'a$(calc)', 'a;b', '123', 'CON', '']) {
      const r = await call('rename_pc', { name, confirm: true });
      expect(r.ok, name).toBe(false);
    }
    expect(sys.renames).toEqual([]);
  });

  it('only a checked name is ever handed to the rename', async () => {
    const { sys, call } = pcRig();
    await call('rename_pc', { name: '  Rakhi  ', confirm: true });
    expect(sys.renames).toEqual(['Rakhi']);
    for (const n of sys.renames) expect(n).toMatch(COMPUTER_NAME);
  });

  it('a PC that already has that name is not renamed (and nothing is asked)', async () => {
    const { sys, call } = pcRig();
    sys.names = { active: 'Rakhi', pending: 'Rakhi' };
    const r = await call('rename_pc', { name: 'rakhi' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('already named that');
    expect(sys.renames).toEqual([]);
  });

  it('a PC that was renamed but not restarted yet says so, and is not asked again', async () => {
    const { sys, call } = pcRig();
    sys.names = { active: 'DESKTOP-OLD1', pending: 'Rakhi' };
    const r = await call('rename_pc', { name: 'Rakhi' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('already renamed, waiting for a restart');
    expect(r.data).toMatchObject({ restartNeeded: true });
    expect(sys.renames).toEqual([]);
  });
});

describe('rename_pc: with the yes', () => {
  it('while Windows waits for the Yes, Eya says so at once, once, and nothing has changed yet', async () => {
    const { sys, call, notes } = pcRig();
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = boxOn();
    const running = call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => notes.length === 1);
    expect(notes[0]).toContain('rename the PC');
    expect(notes[0]).toMatch(/Click Yes/);
    expect(notes[0]).toContain('flashing shield');
    expect(sys.names.pending).toBe('DESKTOP-OLD1');
    release();
    const done = await running;
    expect(done.ok, done.error).toBe(true);
    expect(notes).toHaveLength(1);
  });

  it('after a Yes the new name is read back from Windows, written down, and a restart is offered', async () => {
    const { sys, call, journal } = pcRig();
    const done = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(done.ok, done.error).toBe(true);
    expect(done.summary).toBe('the PC is renamed to Rakhi');
    expect(done.data).toMatchObject({ from: 'DESKTOP-OLD1', to: 'Rakhi', changed: true, verified: true, restartNeeded: true, evidence: 'Windows now holds the new name' });
    expect(String((done.data as { note: string }).note)).toContain('restart');
    expect(sys.names.pending).toBe('Rakhi');
    expect(journal.list()[0]).toMatchObject({ kind: 'rename', what: 'renamed the PC from DESKTOP-OLD1 to Rakhi', before: { value: 'DESKTOP-OLD1' }, after: { value: 'Rakhi' } });
  });

  it('a "No" on the permission box is said plainly: nothing changed, nothing written down', async () => {
    const { sys, call, journal } = pcRig();
    sys.renameOutcome = 'declined';
    sys.boxScript = boxOn();
    const r = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('you said no');
    expect(r.error).toContain('clicked No');
    expect(r.error).toContain('not changed');
    expect(sys.names.pending).toBe('DESKTOP-OLD1');
    expect(journal.list()).toEqual([]);
  });

  it('nobody answered the box: said, and nothing changed', async () => {
    const { sys, call, journal } = pcRig();
    sys.renameOutcome = 'timed_out';
    const r = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('no answer');
    expect(r.error).toContain('not changed');
    expect(journal.list()).toEqual([]);
  });

  it('a Yes that came after the wait was given up still counts, because what Windows holds is what is trusted', async () => {
    const { sys, call } = pcRig();
    sys.renameOutcome = 'timed_out';
    // (the person clicked Yes a moment late: the name is there although the command's answer was "no answer")
    const real = sys.computerNames.bind(sys);
    let looks = 0;
    sys.computerNames = async () => {
      looks += 1;
      const n = await real();
      return looks >= 2 ? { ...n, pending: 'Rakhi' } : n;
    };
    const r = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(r.ok, r.error).toBe(true);
    expect(r.data).toMatchObject({ verified: true });
  });

  it('a command that says "done" while Windows still holds the old name is NOT believed', async () => {
    const { sys, call, journal } = pcRig();
    sys.renameComputer = async (name) => {
      sys.renames.push(name);
      return { outcome: 'done', code: 0 };
    };
    const r = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not renamed');
    expect(sys.names.pending).toBe('DESKTOP-OLD1');
    expect(journal.list()).toEqual([]);
  });

  it('Windows refusing after a Yes is told apart from a No', async () => {
    const { sys, call } = pcRig();
    sys.renameOutcome = 'failed';
    sys.boxScript = boxOn();
    // (the box is on the screen for a moment, as a real one is while the person decides)
    const { gate, release } = hold();
    sys.gate = gate;
    const running = call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => sys.boxLooks > 2);
    release();
    const seen = await running;
    expect(seen.ok).toBe(false);
    expect(seen.summary).toBe('not renamed');
    expect(seen.error).toContain('code 3');
    expect(seen.error).toContain('Windows itself refused');
    const quiet = pcRig();
    quiet.sys.renameOutcome = 'failed';
    const unseen = await quiet.call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(unseen.error).toContain('If a permission box was shown, it has to be answered with Yes');
  });

  it('an error inside the rename is said, not thrown', async () => {
    const { sys, call } = pcRig();
    sys.renameComputer = async () => {
      throw new Error('boom');
    };
    const r = await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('could not rename');
    expect(r.error).toContain('boom');
  });

  it('it cannot be undone from the record, and the reply says what to ask instead', async () => {
    const { call } = pcRig();
    await call('rename_pc', { name: 'Rakhi', confirm: true });
    const undo = await call('undo_pc_change');
    expect(undo.ok).toBe(false);
    expect(undo.error).toContain('rename the PC to DESKTOP-OLD1');
    const list = await call('list_pc_changes');
    expect((list.data as { changes: Array<{ canUndo: boolean }> }).changes[0]?.canUndo).toBe(false);
  });
});

describe('telling the person that the permission box is waiting', () => {
  it('a box that is closed and opens again is told again, in different words; never more than three times', async () => {
    const { sys, call, notes } = pcRig();
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = [true, true, false, false, true, true, false, false];
    const running = call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => notes.length === 2);
    expect(notes[1]).toContain('again');
    expect(notes[1]).not.toBe(notes[0]);
    release();
    await running;

    const many = pcRig();
    const second = hold();
    many.sys.gate = second.gate;
    many.sys.boxScript = Array.from({ length: 200 }, (_, i) => i % 2 === 0);
    const run2 = many.call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => many.sys.boxLooks > 30);
    second.release();
    await run2;
    expect(many.notes).toHaveLength(3);
  });

  it('when the box has not been seen for a while, a rename says it is still waiting (once)', async () => {
    const { sys, call, notes } = pcRig({ stillWaitingMs: 5 });
    const { gate, release } = hold();
    sys.gate = gate;
    const running = call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => notes.length === 1);
    expect(notes[0]).toContain('still waiting');
    await pause(30);
    expect(notes).toHaveLength(1);
    release();
    await running;
    expect(notes).toHaveLength(1);
  });

  it('a box that was seen and answered is not followed by "still waiting"', async () => {
    const { sys, call, notes } = pcRig({ stillWaitingMs: 4 });
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = [true, true, false, false, false, false, false, false, false, false];
    const running = call('rename_pc', { name: 'Rakhi', confirm: true });
    await until(() => sys.boxLooks > 9);
    release();
    await running;
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain('still waiting');
  });

  it('nothing is said when no box ever appears', async () => {
    const { call, notes } = pcRig();
    await call('rename_pc', { name: 'Rakhi', confirm: true });
    expect(notes).toEqual([]);
  });

  it('the looking stops when the job is over', async () => {
    const { sys, call } = pcRig();
    sys.boxScript = boxOn();
    await call('rename_pc', { name: 'Rakhi', confirm: true });
    const looks = sys.boxLooks;
    await pause(25);
    expect(sys.boxLooks).toBe(looks);
  });

  it('a note that cannot be sent does not break the job', async () => {
    const sys = new FakePc();
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = boxOn();
    const journal = new PcJournal('pc-changes.json', new MemIo());
    const tools = createPcTools({
      sys,
      journal,
      pollMs: 1,
      notify: () => {
        throw new Error('the window is gone');
      },
    });
    const rename = tools.find((t) => t.schema.name === 'rename_pc');
    const running = rename?.execute({ name: 'Rakhi', confirm: true });
    await until(() => sys.boxLooks > 3);
    release();
    expect((await running)?.ok).toBe(true);
  });
});

describe('install_program: the question and the box', () => {
  it('the question says that Windows will show a box to click Yes on, and that Eya will say when it appears', async () => {
    const { sys, call } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    const asked = await call('install_program', { id: 'Git.Git' });
    expect(asked.error).toContain('permission box');
    expect(asked.error).toContain('click Yes');
    expect(asked.error).toContain('I will tell you when it appears');
    expect(asked.error).not.toContain('password');
    sys.adminAccountValue = false;
    expect((await call('install_program', { id: 'Git.Git' })).error).toContain("administrator's password");
  });

  it('while the install waits at the box, Eya says so by name; the program is then installed', async () => {
    const { sys, call, notes } = pcRig();
    sys.runner = wingetThatKnows([GIT]);
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = boxOn();
    const running = call('install_program', { id: 'Git.Git', confirm: true });
    await until(() => notes.length === 1);
    expect(notes[0]).toContain('install Git');
    expect(notes[0]).toMatch(/Click Yes/);
    release();
    const done = await running;
    expect(done.ok, done.error).toBe(true);
    expect(notes).toHaveLength(1);
  });

  it('nothing is said while an install runs without a box (it is not told "still waiting")', async () => {
    const { sys, call, notes } = pcRig({ stillWaitingMs: 3 });
    sys.runner = wingetThatKnows([GIT]);
    const { gate, release } = hold();
    sys.gate = gate;
    const running = call('install_program', { id: 'Git.Git', confirm: true });
    await pause(30);
    expect(notes).toEqual([]);
    release();
    await running;
    expect(notes).toEqual([]);
  });

  it('when the box was shown and nothing was installed, it says that a No probably did it, and offers to try again', async () => {
    const { sys, call } = pcRig();
    const base = wingetThatKnows([GIT]);
    sys.runner = (file, args) => (args[0] === 'install' ? { code: 1, stdout: '', stderr: 'Installer was cancelled', timedOut: false } : base(file, args));
    sys.boxScript = boxOn();
    const { gate, release } = hold();
    sys.gate = gate;
    const running = call('install_program', { id: 'Git.Git', confirm: true });
    await until(() => sys.boxLooks > 3);
    release();
    const r = await running;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('not installed');
    expect(r.error).toContain('if you clicked No, nothing was installed');
    expect(r.error).toContain('click Yes');
    expect(r.data).toMatchObject({ permissionBoxShown: true });
  });

  it('when no box was seen, the reply says a box has to be answered with Yes if one was shown', async () => {
    const { sys, call } = pcRig();
    const base = wingetThatKnows([GIT]);
    sys.runner = (file, args) => (args[0] === 'install' ? { code: 1, stdout: '', stderr: 'failed', timedOut: false } : base(file, args));
    const r = await call('install_program', { id: 'Git.Git', confirm: true });
    expect(r.error).toContain('If Windows showed a permission box, it has to be answered with Yes');
    expect(r.data).toMatchObject({ permissionBoxShown: false });
  });
});

describe('uninstall_program', () => {
  const rig = () => {
    const r = pcRig();
    const installed = new Set<string>(['Git.Git']);
    r.sys.runner = wingetThatKnows([GIT], installed);
    return { ...r, installed };
  };

  it('looks the program up among what is installed: an address or a program that is not there is refused', async () => {
    const { call } = rig();
    expect((await call('uninstall_program', { id: 'https://evil.example/a.exe' })).summary).toBe('not a package id');
    const missing = await call('uninstall_program', { id: 'Not.Installed' });
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe('not installed');
  });

  it('asks first, naming the program and its version, and about the box; nothing is removed', async () => {
    const { sys, call, installed } = rig();
    const asked = await call('uninstall_program', { id: 'Git.Git' });
    expect(asked.ok).toBe(false);
    expect(asked.error).toContain('Uninstall Git 2.43.0 from this PC?');
    expect(asked.error).toContain('permission box');
    expect(asked.error).toContain('click Yes');
    expect(asked.data).toMatchObject({ status: 'permission_required', action: 'uninstall_program' });
    expect(sys.runs.some((r) => r.args[0] === 'uninstall')).toBe(false);
    expect(installed.has('Git.Git')).toBe(true);
  });

  it('with the yes it removes it, tells about the box, checks it is gone, and writes it down', async () => {
    const { sys, call, notes, journal, installed } = rig();
    const { gate, release } = hold();
    sys.gate = gate;
    sys.boxScript = boxOn();
    const running = call('uninstall_program', { id: 'Git.Git', confirm: true });
    await until(() => notes.length === 1);
    expect(notes[0]).toContain('remove Git');
    expect(notes[0]).toMatch(/Click Yes/);
    release();
    const done = await running;
    expect(done.ok, done.error).toBe(true);
    expect(done.data).toMatchObject({ verified: true, evidence: 'winget no longer lists it' });
    expect(installed.has('Git.Git')).toBe(false);
    const call1 = sys.runs.find((r) => r.args[0] === 'uninstall');
    expect(call1?.args).toEqual(['uninstall', '--id', 'Git.Git', '--exact', '--silent', '--accept-source-agreements', '--disable-interactivity']);
    expect(journal.list()[0]).toMatchObject({ kind: 'uninstall', what: 'uninstalled Git 2.43.0' });
  });

  it('a program that is still there afterwards is not called removed; a No at the box is named', async () => {
    const { sys, call } = rig();
    const base = sys.runner;
    sys.runner = (file, args) => (args[0] === 'uninstall' ? { code: 1, stdout: '', stderr: 'cancelled', timedOut: false } : base(file, args));
    sys.boxScript = boxOn();
    const { gate, release } = hold();
    sys.gate = gate;
    const running = call('uninstall_program', { id: 'Git.Git', confirm: true });
    await until(() => sys.boxLooks > 3);
    release();
    const r = await running;
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('still installed');
    expect(r.error).toContain('if you clicked No, nothing was removed');
  });

  it('cannot be undone from the record: it says to install it again', async () => {
    const { call } = rig();
    await call('uninstall_program', { id: 'Git.Git', confirm: true });
    const undo = await call('undo_pc_change');
    expect(undo.ok).toBe(false);
    expect(undo.error).toContain('install it again');
  });

  it('find_program with installed: true looks among the installed programs (winget list), not the catalogue', async () => {
    const { sys, call, installed } = rig();
    const found = await call('find_program', { query: 'git', installed: true });
    expect(found.ok).toBe(true);
    expect((found.data as { packages: Array<{ id: string; version: string }> }).packages).toEqual([{ name: 'Git', id: 'Git.Git', version: '2.43.0' }]);
    expect(sys.runs.some((r) => r.args[0] === 'search')).toBe(false);
    installed.clear();
    const none = await call('find_program', { query: 'git', installed: true });
    expect((none.data as { note: string }).note).toContain('Windows Settings, Apps');
  });
});

describe('the PC check knows the PC\'s name', () => {
  it('the overview names the PC, and says when a rename is waiting for a restart', async () => {
    const { sys, call } = pcRig();
    const plain = await call('pc_check', { topic: 'overview' });
    expect((plain.data as { facts: { computerName: string } }).facts.computerName).toBe('DESKTOP-OLD1');
    expect((plain.data as { findings: string[] }).findings.some((f) => /renamed/.test(f))).toBe(false);
    sys.names = { active: 'DESKTOP-OLD1', pending: 'Rakhi' };
    const waiting = await call('pc_check', { topic: 'overview' });
    expect((waiting.data as { findings: string[] }).findings).toContain('This PC has been renamed to Rakhi; it is still called DESKTOP-OLD1 until it is restarted.');
  });
});
