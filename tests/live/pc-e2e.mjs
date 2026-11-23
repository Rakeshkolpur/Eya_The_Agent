// Run from the project folder, after 'npx electron-vite build':   E2E_MODE=preview node tests/live/pc-e2e.mjs
// The PC-fixing tools in the REAL app (Electron): they are registered, their arguments are checked, a change asks first and changes nothing until the person says yes, and what Eya looks at on this
// PC (read only) comes back in plain sentences. Nothing is changed on this PC by this check. NOT covered here: the changes themselves on a real Windows (see tests/live/pc.live.test.ts, which sets
// and removes a throwaway variable and a throwaway PATH folder), a real install, a real voice or model choosing these tools.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9338;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userData = mkdtempSync(join(tmpdir(), 'eya-pc-'));
const logFile = join(SP, `pc-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47840',
  EYA_NO_BROWSER_LAUNCH: '1',
  EYA_NO_MIC: '1',
  EYA_LOG_LEVEL: 'debug',
};
delete env.EYA_BACKUP_AI_KEY;
delete env.EYA_BROWSER_HEADLESS;
const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', process.env.E2E_MODE === 'preview' ? 'preview' : 'dev', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
app.stdout.pipe(log);
app.stderr.pipe(log);
const stopApp = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
process.on('exit', stopApp);

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evalIn, close: () => ws.close() };
}

async function connectMain() {
  for (let i = 0; i < 120; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
      for (const t of targets.filter((x) => x.type === 'page')) {
        const c = await attach(t.webSocketDebuggerUrl);
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.runLiveTool === "function"').catch(() => false)) return c;
        c.close();
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the app window never appeared');
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(6000);
  const tool = async (name, args) => {
    const raw = await evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard: 'check the PC' })}).then((r) => r.content)`);
    try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; }
  };

  const overview = await tool('pc_check', { topic: 'overview' });
  check('pc_check looks at the real PC (read only) and comes back with what it found', overview.ok === true && Array.isArray(overview.data?.findings) && /Windows/.test(String(overview.data?.facts?.windows)), overview);
  console.log('   overview findings:', JSON.stringify(overview.data?.findings));
  const node = await tool('pc_check', { topic: 'tool', program: 'node' });
  check('"is node installed?" is answered in a sentence', node.ok === true && /node/.test(String((node.data?.findings ?? [])[0])), node);
  const unknown = await tool('pc_check', { topic: 'tool', program: 'calc.exe & del *' });
  check('a program Eya does not know is not run', /I only check these programs/.test(String((unknown.data?.findings ?? [])[0])), unknown);

  // changes ask first (nothing is changed by this check: no call here carries confirm)
  const setAsk = await tool('set_environment_variable', { name: 'EYA_E2E_NEVER_SET', value: 'x' });
  check('a variable change asks first, and says it needs the yes', setAsk.ok === false && /Set the EYA_E2E_NEVER_SET variable for your user to x\?/.test(String(setAsk.error ?? setAsk.summary)), setAsk);
  const protectedName = await tool('set_environment_variable', { name: 'COMSPEC', value: 'C:\\evil.exe' });
  check('a name Windows relies on is refused', /Windows itself relies on/.test(String(protectedName.error ?? '')), protectedName);
  const javaBin = await tool('set_environment_variable', { name: 'JAVA_HOME', value: 'C:\\Program Files\\Java\\jdk-17\\bin' });
  check('JAVA_HOME as the bin folder is refused with the reason', /not its "bin" folder|does not exist/.test(String(javaBin.error ?? '')), javaBin);
  const pathAsk = await tool('edit_user_path', { action: 'clean' });
  check('cleaning the PATH either has nothing to do or asks first', pathAsk.ok === true || /needs confirmation|Change your user PATH like that/.test(String(pathAsk.error ?? pathAsk.summary)), pathAsk);
  const badId = await tool('install_program', { id: 'https://evil.example/a.exe' });
  check('an install of an address is refused: only a winget id is accepted', /not a package id|package id/.test(String(badId.error ?? badId.summary)), badId);
  const installAsk = await tool('install_program', { id: 'Git.Git' });
  check('an install asks first, naming the program (nothing is installed)', installAsk.ok === false && /(Install Git .* from the official Windows Package Manager\?|not available)/.test(String(installAsk.error ?? '')), installAsk);
  const tempAsk = await tool('clear_temp_files', {});
  check('clearing temporary files says how many and asks first (or has nothing to clear)', tempAsk.ok === true || /Delete \d+ temporary files/.test(String(tempAsk.error ?? '')), tempAsk);
  const explorerAsk = await tool('restart_explorer', {});
  check('restarting Explorer asks first and does not do it', explorerAsk.ok === false && /Open File Explorer windows will close/.test(String(explorerAsk.error ?? '')), explorerAsk);
  // "rename my PC to Rakhi": a real tool now (it used to be Settings → About and clicking, which got stuck)
  check('the overview says what this PC is called', typeof overview.data?.facts?.computerName === 'string' && overview.data.facts.computerName.length > 0, overview.data?.facts);
  const renameAsk = await tool('rename_pc', { name: 'Rakhi' });
  check('"rename my PC to Rakhi" asks first, and says about Windows\' permission box and the restart (nothing is renamed)', renameAsk.ok === false && /Rename this PC from .+ to Rakhi\?/.test(String(renameAsk.error)) && /permission box/.test(String(renameAsk.error)) && /click Yes/.test(String(renameAsk.error)) && /after a restart/.test(String(renameAsk.error)), renameAsk);
  const renameBad = await tool('rename_pc', { name: "Rakhi's PC" });
  check('a name Windows would not take is refused, with a nearby one offered', /How about Rakhis-PC\?/.test(String(renameBad.error ?? '')), renameBad);
  const uninstallGone = await tool('uninstall_program', { id: 'Eya.Surely.NotInstalled' });
  check('removing a program that is not installed is refused (nothing is removed)', uninstallGone.ok === false && /not installed/.test(String(uninstallGone.summary)), uninstallGone);
  const installedOnly = await tool('find_program', { query: 'git', installed: true });
  check('find_program can look among the installed programs', installedOnly.ok === true, installedOnly);
  // the Windows side (all read-only, or refused: nothing on this PC is stopped, turned off or run)
  const startup = await tool('list_startup_apps', {});
  check('the start-up apps are listed from the real registry, each judged', startup.ok === true && Array.isArray(startup.data?.apps) && startup.data.apps.every((a) => typeof a.name === 'string' && ['safe', 'optional', 'keep'].includes(a.kind)), startup);
  const running = await tool('list_background_apps', {});
  const programs = running.data?.programs ?? [];
  check('what is running is listed with the memory, and Windows is never offered to be stopped', running.ok === true && programs.length > 3 && typeof running.data?.ramFreeMb === 'number' && programs.filter((p) => /^explorer$/i.test(p.name)).every((p) => p.canStop === false), running);
  const explorerStop = await tool('stop_background_apps', { apps: 'explorer' });
  check('"stop explorer" is refused in the real app: Windows is never stopped (and nothing was stopped)', explorerStop.ok === true && explorerStop.summary === 'nothing to stop' && (explorerStop.data?.refused ?? []).some((r) => /part of Windows/.test(r.why)), explorerStop);
  const secStartup = await tool('set_startup_apps', { apps: 'securityhealth' });
  check('Windows Security cannot be turned off at start-up, in the real app', (secStartup.data?.refused ?? []).some((r) => /Windows security/.test(r.why)) || secStartup.data?.unknown?.length > 0, secStartup);
  const mic = await tool('check_microphone', {});
  check('the microphone is looked at for real and answered in plain sentences', mic.ok === true && Array.isArray(mic.data?.findings) && mic.data.findings.length > 0 && Array.isArray(mic.data?.microphones), mic);
  console.log('   microphone:', JSON.stringify(mic.data?.findings));
  const looks = await tool('run_windows_command', { command: 'Get-Date -Format yyyy' });
  check('a command that only looks runs at once and its answer comes back', looks.ok === true && /^20\d\d$/.test(String(looks.data?.output).trim()) && looks.data?.readOnly === true, looks);
  const changes = await tool('run_windows_command', { command: 'Stop-Service Spooler' });
  check('a command that changes something is shown word for word and asks first (nothing runs)', changes.ok === false && changes.summary === 'needs confirmation' && /Stop-Service Spooler/.test(String(changes.error)), changes);
  const refused = await tool('run_windows_command', { command: 'Set-MpPreference -DisableRealtimeMonitoring $true', confirm: true });
  check("turning off Windows' protection is refused, even with the yes", refused.ok === false && refused.summary === 'refused' && /do it yourself in Windows/.test(String(refused.error)), refused);
  const service = await tool('restart_windows_service', { service: 'WinDefend' });
  check('only the four known services can be restarted', service.ok === false && /unknown service|must be one of/i.test(String(service.summary + service.error)), service);
  // Office: the new tools are registered in the real app; only looking or refusing here (nothing is typed, opened or changed)
  const xlStatus = await tool('excel_work', { action: 'status' });
  check('excel_work is in the real app and looks at Excel (read only)', xlStatus.ok === true && /looked at Excel/.test(String(xlStatus.summary)), xlStatus);
  const pptStatus = await tool('powerpoint_work', { action: 'status' });
  check('powerpoint_work is in the real app and looks at PowerPoint (read only)', pptStatus.ok === true && /looked at PowerPoint/.test(String(pptStatus.summary)), pptStatus);
  const xlSave = await tool('excel_work', { action: 'save', options: JSON.stringify({ path: 'C:\\Windows\\sales.xlsx' }) });
  check('Excel cannot be told to save outside the person\'s own folders', xlSave.ok === false && xlSave.summary === 'not allowed', xlSave);
  const noteBad = await tool('notepad_write', { text: 'x', path: 'C:\\Windows\\note.txt' });
  check('Notepad refuses a file outside the person\'s own folders, and types nothing', noteBad.ok === false && noteBad.summary === 'not allowed', noteBad);
  const noteExe = await tool('notepad_write', { text: 'x', path: 'C:\\Users\\Public\\run.exe' });
  check('Notepad refuses a program file', noteExe.ok === false, noteExe);
  const img = await tool('word_from_image', { path: 'C:\\Windows\\System32\\nothing.png' });
  check('the picture tool refuses a file that is not the person\'s own', img.ok === false && /not allowed|no Gemini key/.test(String(img.summary)), img);
  const tbl = await tool('word_structure', { kind: 'inspect_tables' });
  check('word_structure knows the table inspector (Word may not be open: then it says so, it does not crash)', tbl.ok === true || /Word/.test(String(tbl.summary + tbl.error)), tbl);
  const list = await tool('list_pc_changes', {});
  check('the record of changes is empty: nothing was changed', list.ok === true && (list.data?.changes ?? []).length === 0, list);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  process.exit(failures === 0 ? 0 : 1);
}
