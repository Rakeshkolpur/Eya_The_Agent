import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { routeGroups, groupOfTool } from '../src/main/agent/toolGroups';
import type { OfficeAnswer, OfficeApp } from '../src/main/office/OfficeControl';
import { createNotepadTool, SEND_KEYS_SCRIPT } from '../src/main/tools/impl/notepadTools';
import type { NotepadRun } from '../src/main/tools/impl/notepadTools';
import { createOfficeTools } from '../src/main/tools/impl/officeTools';
import type { Tool, ToolArgs, ToolResult } from '../src/main/tools/types';

/** Excel, PowerPoint and Notepad: the tools around the helpers (the helpers themselves run against the real programs in tests/live). */

const home = mkdtempSync(join(tmpdir(), 'eya-office-unit-'));
const folders = { home, desktop: home, documents: home, downloads: home, pictures: home, videos: home, music: home, temp: home };
afterAll(() => rmSync(home, { recursive: true, force: true }));

interface Call {
  app: OfficeApp;
  op: string;
  args: Record<string, unknown>;
}

function office(answer: OfficeAnswer = { ok: true }, existing: string[] = []) {
  const calls: Call[] = [];
  const tools = createOfficeTools({
    office: {
      run: async (app, op, args = {}): Promise<OfficeAnswer> => {
        calls.push({ app, op, args });
        return answer;
      },
    },
    folders,
    exists: (p) => existing.includes(p),
  });
  const get = (name: string): ((a: ToolArgs) => Promise<ToolResult>) => {
    const t = tools.find((x: Tool) => x.schema.name === name) as Tool;
    return (a) => t.execute(a);
  };
  return { calls, excel: get('excel_work'), ppt: get('powerpoint_work'), tools };
}

describe('Excel through its tool', () => {
  it('passes the action as the operation and the options on, and says what was done', async () => {
    const o = office({ ok: true, address: 'A1:B2', written: 4 });
    const r = await o.excel({ action: 'write', options: '{"range":"A1","values":[["a",1],["b",2]]}' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('wrote 4 cells at A1:B2');
    expect(o.calls[0]).toEqual({ app: 'excel', op: 'write', args: { range: 'A1', values: [['a', 1], ['b', 2]] } });
  });

  it('an unknown action and options that are not a JSON object are refused in words, and nothing is asked of Excel', async () => {
    const o = office();
    expect((await o.excel({ action: 'explode' })).summary).toBe('unknown action');
    expect((await o.excel({ action: 'read', options: 'A1:B2' })).summary).toBe('bad options');
    expect((await o.excel({ action: 'read', options: '[1,2]' })).summary).toBe('bad options');
    expect(o.calls).toEqual([]);
  });

  it('what Excel will not do without a yes comes back as a question, and says that Excel cannot undo it', async () => {
    const o = office({ ok: false, needsConfirm: true, why: '3 of those cells already have something in them (A1:B2)' });
    const r = await o.excel({ action: 'write', options: '{"range":"A1","values":[["x"]]}' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('needs confirmation');
    expect(r.error).toContain('3 of those cells already have something');
    expect(r.error).toContain('Excel cannot undo it');
    expect(r.data).toMatchObject({ needsConfirmation: true });
  });

  it('with the yes (confirm) the helper is told it may overwrite and delete; without it, it is not', async () => {
    const yes = office();
    await yes.excel({ action: 'write', options: '{"range":"A1","values":[["x"]]}', confirm: true });
    expect(yes.calls[0]?.args).toMatchObject({ overwrite: true, confirm: true });
    const no = office();
    await no.excel({ action: 'write', options: '{"range":"A1","values":[["x"]]}' });
    expect(no.calls[0]?.args['overwrite']).toBeUndefined();
    expect(no.calls[0]?.args['confirm']).toBeUndefined();
  });

  it('Excel not being open is said with what to do', async () => {
    const r = await office({ ok: false, why: 'Excel is not open' }).excel({ action: 'status' });
    expect(r.summary).toBe('Excel is not open');
    expect(r.error).toContain('Open Excel');
  });

  it('save: a path outside the person\'s own folders, a wrong kind of file, and an existing file without a yes are each refused; with a path inside, it is saved', async () => {
    const o = office({ ok: true, saved: true });
    expect((await o.excel({ action: 'save', options: '{"path":"C:\\\\Windows\\\\x.xlsx"}' })).summary).toBe('not allowed');
    expect((await o.excel({ action: 'save', options: JSON.stringify({ path: join(home, 'run.exe') }) })).summary).toBe('not a document file');
    expect((await o.excel({ action: 'save', options: JSON.stringify({ path: join(home, 'book.bat') }) })).summary).toBe('not a document file');
    expect(o.calls).toEqual([]);
    const target = join(home, 'sales.xlsx');
    const exists = office({ ok: true }, [target]);
    const replace = await exists.excel({ action: 'save', options: JSON.stringify({ path: target }) });
    expect(replace.summary).toBe('needs confirmation');
    expect(replace.error).toContain('already exists');
    expect(exists.calls).toEqual([]);
    expect((await exists.excel({ action: 'save', options: JSON.stringify({ path: target }), confirm: true })).ok).toBe(true);
    expect(exists.calls[0]).toMatchObject({ op: 'save', args: { path: target } });
    expect((await o.excel({ action: 'save', options: JSON.stringify({ path: join(home, 'new.xlsx') }) })).ok).toBe(true);
    expect(o.calls[0]?.args['path']).toBe(join(home, 'new.xlsx'));
  });

  it('save with no path saves in place (the helper is not given a path)', async () => {
    const o = office();
    await o.excel({ action: 'save' });
    expect(o.calls[0]).toEqual({ app: 'excel', op: 'save', args: {} });
  });
});

describe('PowerPoint through its tool', () => {
  it('adds a slide, formats text, and says which slide', async () => {
    const o = office({ ok: true, slide: 3 });
    const r = await o.ppt({ action: 'add_slide', options: '{"layout":"title_content","title":"Plan","bullets":["a","b"]}' });
    expect(r.summary).toBe('added slide 3');
    expect(o.calls[0]).toEqual({ app: 'powerpoint', op: 'add_slide', args: { layout: 'title_content', title: 'Plan', bullets: ['a', 'b'] } });
    expect((await o.ppt({ action: 'format_text', options: '{"slide":3,"shape":"title","bold":true}' })).summary).toBe('formatted the text on slide 3');
  });

  it('deleting a slide comes back as a question first; with the yes it goes through', async () => {
    const ask = office({ ok: false, needsConfirm: true, why: 'deleting slide 2 cannot be undone' });
    const r = await ask.ppt({ action: 'slide', options: '{"action":"delete","slide":2}' });
    expect(r.summary).toBe('needs confirmation');
    expect(r.error).toContain('PowerPoint cannot undo it');
    const yes = office();
    await yes.ppt({ action: 'slide', options: '{"action":"delete","slide":2}', confirm: true });
    expect(yes.calls[0]?.args).toMatchObject({ action: 'delete', slide: 2, confirm: true });
  });

  it('a picture must be a picture file the person has: not a program, not outside their files', async () => {
    const png = join(home, 'logo.png');
    writeFileSync(png, 'x');
    const o = office({ ok: true, slide: 2 });
    expect((await o.ppt({ action: 'add_picture', options: JSON.stringify({ slide: 2, path: png }) })).ok).toBe(true);
    expect(o.calls[0]?.args['path']).toBe(png);
    expect((await o.ppt({ action: 'add_picture', options: JSON.stringify({ slide: 2, path: join(home, 'setup.exe') }) })).summary).toBe('not a picture');
    expect((await o.ppt({ action: 'add_picture', options: '{"slide":2,"path":"C:\\\\Windows\\\\win.ini"}' })).summary).toBe('not allowed');
    expect((await o.ppt({ action: 'add_picture', options: '{"slide":2}' })).ok).toBe(false);
    expect(o.calls).toHaveLength(1);
  });

  it('save only as .pptx or .ppt, inside the person\'s own folders', async () => {
    const o = office();
    expect((await o.ppt({ action: 'save', options: JSON.stringify({ path: join(home, 'talk.docx') }) })).summary).toBe('not a document file');
    expect((await o.ppt({ action: 'save', options: JSON.stringify({ path: join(home, 'talk.pptx') }) })).ok).toBe(true);
  });

  it('the two tools are in the Word group, so they come with a request about Office files', () => {
    expect(groupOfTool('excel_work')).toBe('word');
    expect(groupOfTool('powerpoint_work')).toBe('word');
    expect(groupOfTool('notepad_write')).toBe('word');
    expect(groupOfTool('word_from_image')).toBe('word');
  });
});

describe('Notepad, typed live', () => {
  const answerOk = (o: Record<string, unknown> = {}): NotepadRun => ({ code: 0, stdout: `${JSON.stringify({ ok: true, typed: 11, seconds: 1.2, pid: 4321, title: 'note.txt - Notepad', ...o })}\r\n`, stderr: '' });

  function notepad(reply: NotepadRun = answerOk()) {
    const runs: Array<{ env: Record<string, string>; timeoutMs: number }> = [];
    const created: string[] = [];
    const tool = createNotepadTool({
      folders,
      run: async (_script, env, timeoutMs) => {
        runs.push({ env, timeoutMs });
        return reply;
      },
      exists: () => false,
      createEmpty: async (p) => void created.push(p),
    });
    return { runs, created, tool };
  }

  it('types the words with the speed, the file and the save, and says how long it took', async () => {
    const n = notepad();
    const file = join(home, 'note.txt');
    const r = await n.tool.execute({ text: 'hello world', path: file, save: true, speed: 'fast' });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('typed 11 characters in Notepad and saved it');
    expect(n.runs[0]?.env).toEqual({ EYA_MODE: 'new', EYA_PATH: file, EYA_TEXT: 'hello world', EYA_CPS: '80', EYA_SAVE: '1' });
    expect(n.created).toEqual([file]);
    expect(r.data).toMatchObject({ typed: 11, seconds: 1.2, file, saved: true, pid: 4321 });
  });

  it('with no file a new Notepad is opened and nothing is created; the speeds are 12, 30 and 80 characters a second', async () => {
    for (const [speed, cps] of [['slow', '12'], ['normal', '30'], [undefined, '30'], ['fast', '80']] as const) {
      const n = notepad();
      await n.tool.execute({ text: 'x', ...(speed !== undefined ? { speed } : {}) });
      expect(n.runs[0]?.env['EYA_CPS'], String(speed)).toBe(cps);
      expect(n.runs[0]?.env['EYA_PATH']).toBe('');
      expect(n.runs[0]?.env['EYA_SAVE']).toBe('0');
      expect(n.created).toEqual([]);
    }
  });

  it('mode open types into the Notepad that is already open, and creates nothing', async () => {
    const n = notepad();
    await n.tool.execute({ text: 'more', mode: 'open', path: join(home, 'x.txt') });
    expect(n.runs[0]?.env['EYA_MODE']).toBe('open');
    expect(n.created).toEqual([]);
  });

  it('a file outside the person\'s folders, a program file, no text and too much text are refused before Notepad is touched', async () => {
    const n = notepad();
    expect((await n.tool.execute({ text: 'x', path: 'C:\\Windows\\note.txt' })).summary).toBe('not allowed');
    expect((await n.tool.execute({ text: 'x', path: join(home, 'run.bat') })).summary).toBe('not a text file');
    expect((await n.tool.execute({ text: 'x', path: join(home, 'run.exe') })).summary).toBe('not a text file');
    expect((await n.tool.execute({ text: '' })).summary).toBe('no text');
    expect((await n.tool.execute({ text: 'x'.repeat(8001) })).summary).toBe('too much text');
    expect(n.runs).toEqual([]);
    expect(n.created).toEqual([]);
  });

  it('when Notepad cannot be brought to the front, nothing was typed, and that is said plainly', async () => {
    const r = await notepad({ code: 0, stdout: `${JSON.stringify({ ok: false, why: 'I could not bring Notepad to the front, so I typed nothing (the words could have gone to another window)' })}\n`, stderr: '' }).tool.execute({ text: 'secret' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('nothing typed');
    expect(r.error).toContain('typed nothing');
  });

  it('a helper that does not answer is said', async () => {
    const r = await notepad({ code: 1, stdout: 'garbage', stderr: 'boom' }).tool.execute({ text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('Notepad would not take the text');
  });

  it('the wait scales with the typing and never passes four minutes', async () => {
    const short = notepad();
    await short.tool.execute({ text: 'x'.repeat(30) });
    expect(short.runs[0]?.timeoutMs).toBe(Math.ceil((30 / 30) * 1000) + 40_000);
    const long = notepad();
    await long.tool.execute({ text: 'x'.repeat(8000), speed: 'slow' });
    expect(long.runs[0]?.timeoutMs).toBe(240_000);
  });

  it('the typing script types only into Notepad: the front window is checked before the first key, before every piece and before saving, and the keyboard\'s own keys are typed as themselves', () => {
    const checks = SEND_KEYS_SCRIPT.match(/GetForegroundWindow\(\) -ne \$h/g) ?? [];
    expect(checks.length).toBeGreaterThanOrEqual(4);
    expect(SEND_KEYS_SCRIPT).toContain('so I typed nothing');
    expect(SEND_KEYS_SCRIPT).toContain('Notepad lost the focus after');
    expect(SEND_KEYS_SCRIPT).toContain('did not save');
    expect(SEND_KEYS_SCRIPT).toContain("'+^%~(){}[]'.Contains");
    expect(SEND_KEYS_SCRIPT).toContain('{ENTER}');
    expect(SEND_KEYS_SCRIPT).toContain('{TAB}');
    // the first key typed comes after the focus check
    expect(SEND_KEYS_SCRIPT.indexOf('so I typed nothing')).toBeLessThan(SEND_KEYS_SCRIPT.indexOf("SendWait('^{END}')"));
    // what is typed never comes from the script text itself: it arrives in the environment
    expect(SEND_KEYS_SCRIPT).toContain('$env:EYA_TEXT');
  });
});

describe('a request about an Office file reaches the Word group', () => {
  const asks = [
    'recreate this photo in word',
    'make this same in word exactly with the formatting',
    'i send a photo of a notice, make it in word',
    'in this word this table is not coming properly fix this',
    'fix the table',
    'the table is cut off at the right side',
    'type it live in word',
    'let me watch you type it',
    'open excel and make a table of my expenses',
    'add a slide to my powerpoint',
    'make a presentation about the case',
    'write this in notepad',
    'open a spreadsheet and sort it',
    'fix my ms office',
  ];
  for (const text of asks) {
    it(`"${text}" brings the Word group`, () => {
      expect(routeGroups(text).has('word'), text).toBe(true);
    });
  }

  const not = ['book a table for two at 8', 'order a pizza from zomato', 'play a song on youtube', 'what is the weather', 'send hello to Ravi on WhatsApp', 'my laptop is slow'];
  for (const text of not) {
    it(`"${text}" does not`, () => {
      expect(routeGroups(text).has('word'), text).toBe(false);
    });
  }
});
