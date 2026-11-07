// Run from the project folder:  node tests/live/whatsapp-installed-e2e.mjs
// Needs WhatsApp for Windows installed. The real app: "message <number> <words>" must open the INSTALLED WhatsApp with the message in its box
// (nothing is sent: the number below does not exist, and Eya never presses Enter). The by-name case (the installed app cannot be typed in, so
// WhatsApp Web is used, with one sentence saying so) is in tests/chatCommands.test.ts: it needs a browser with the extension.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9333;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 700)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const foreground = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', "Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class FG{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\",CharSet=CharSet.Unicode)]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);}'; $sb=New-Object System.Text.StringBuilder 256; [void][FG]::GetWindowText([FG]::GetForegroundWindow(),$sb,256); $sb.ToString()"], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const userData = mkdtempSync(join(tmpdir(), 'eya-wa-'));
mkdirSync(userData, { recursive: true });
writeFileSync(join(userData, 'communication-access.json'), JSON.stringify({ enabled: true, apps: {} }));
const log = createWriteStream(join(OUT, `wa-app-${Date.now()}.log`));
const env = { ...process.env, EYA_GEMINI_API_KEY: 'AIzaSyMAINMAINMAINMAINMAINMAINMAIN123', EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47835', EYA_NO_MIC: '1', EYA_NO_BROWSER_LAUNCH: '1' };
const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', process.env.E2E_MODE === 'preview' ? 'preview' : 'dev', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
app.stdout.pipe(log);
app.stderr.pipe(log);
const stop = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
process.on('exit', stop);

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
  return { send, evalIn };
}

try {
  let main = null;
  for (let i = 0; i < 120 && main === null; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
      for (const t of targets.filter((x) => x.type === 'page')) {
        const c = await attach(t.webSocketDebuggerUrl);
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.submit === "function"').catch(() => false)) { main = c; break; }
      }
    } catch { /* not up yet */ }
    if (main === null) await sleep(2000);
  }
  if (main === null) throw new Error('the window never appeared');
  await sleep(9000);
  const ask = (text, id) => main.evalIn(`window.eya.submit({ text: ${JSON.stringify(text)}, source: 'text', requestId: ${JSON.stringify(id)} }).then((r) => r.spoken)`);

  // a number: the installed app is opened with the message ready
  const before = foreground();
  const out = await ask('message 00000 00000 this is only a test, please do not send it', 'wa-2');
  console.log(`      (by number: ${JSON.stringify(out)})`);
  check('by number: Eya says she opened the installed app with the message ready, and asks the person to press Enter', /WhatsApp is installed on this PC, so I opened it with your message ready for \+910000000000/.test(out) && /press Enter/.test(out), out);
  let title = '';
  for (let i = 0; i < 15 && !/whatsapp/i.test(title); i++) { await sleep(1000); title = foreground(); }
  check('the installed WhatsApp window really came to the front', /^WhatsApp/i.test(title), { before, title });
  check('nothing was sent: Eya says she cannot see inside the app and does not claim it was sent', !/\bsent\b/i.test(out.replace(/to send it|can't send it/g, '')) || /can't send it/.test(out), out);
} catch (e) {
  failures++;
  console.log('FAIL  harness error: ' + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  stop();
  await sleep(2500);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* in use */ }
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
