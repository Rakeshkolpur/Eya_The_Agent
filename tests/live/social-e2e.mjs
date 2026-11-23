// Run from the project folder, after "npx electron-vite build":   E2E_MODE=preview node tests/live/social-e2e.mjs
// (23 Nov 2026) LinkedIn writing in the REAL app (Electron): the LinkedIn plugin is there with its three permissions, nothing works until the person grants them, a draft is saved and checked,
// a client matter is refused, a picture card is really drawn by Eya's hidden window (a real PNG of the right size), and the request that is about LinkedIn carries its tools. NOT covered: the real LinkedIn page.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, createWriteStream, readFileSync, copyFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9343;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 900)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


const userData = mkdtempSync(join(tmpdir(), 'eya-typed-'));
const logFile = join(SP, `typed-app-${Date.now()}.log`);
const log = createWriteStream(logFile);
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47843',
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
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 60000 });
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getBrowserPanel === "function"').catch(() => false)) return c;
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
  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(2500);
  const tool = async (name, args, heard = 'write a linkedin post') => {
    const raw = await evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard })}).then((r) => r.content)`);
    try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; }
  };

  // the plugin is there, with its three permissions, and none is granted
  const snap = JSON.stringify(await evalIn('window.eya.getPlugins()'));
  check('the LinkedIn plugin is in the catalogue with its three permissions', /"linkedin"/.test(snap) && /Prepare drafts and pictures/.test(snap) && /Publish posts/.test(snap) && /Publish comments and replies/.test(snap), snap.slice(0, 500));

  // nothing works until the PERSON grants it (the registry guard)
  const before = await tool('social_draft', { text: 'Three checks before you sign a rent agreement.' });
  check('without the permission the drafting tool is refused and says what to allow', before.ok === false && /permission|Plugins page/i.test(JSON.stringify(before)), before);

  const granted = await evalIn('window.eya.changePlugin({ kind: "grant", id: "linkedin", permission: "drafts.write" }).then((r) => r.message)');
  console.log('grant drafts.write ->', granted);
  check('the person grants drafting (their own click)', /may now/.test(String(granted)), granted);

  await tool('social_profile', { action: 'set', name: 'Rakesh', headline: 'Advocate', facts: 'Advocate\nWrites about tenancy law' });
  const saved = await tool('social_draft', { text: 'Three things to check before you sign a rent agreement.', title: 'Renting a home? Read this first.', hashtags: 'rentlaw tenancy legaltips' });
  check('a draft is saved with the first line, the text and the hashtags on a last line', saved.ok === true && /^Renting a home\? Read this first\.\n\nThree things/.test(saved.data?.text ?? '') && /#rentlaw #tenancy #legaltips$/.test(saved.data?.text ?? ''), saved);
  check('and it says how to publish and that the person must say yes', /social_compose/.test(saved.data?.next ?? '') && /own yes/.test(saved.data?.next ?? ''), saved.data?.next);

  const bad = await tool('social_draft', { text: 'I won O.S. No. 123/2020 for my client today. Call +91 98765 43210.' });
  check('a client matter and a phone number are refused', bad.ok === false && /petition number/.test(JSON.stringify(bad)) && /phone number/.test(JSON.stringify(bad)), bad);

  const list = await tool('social_draft', { action: 'list' });
  check('the list says what may still be published today', list.ok === true && list.data?.mayStillPublishToday?.post === 2, list);

  // a real picture, drawn by Eya's hidden window
  const made = await tool('social_make_image', { title: 'Renting a home? Read this first.', subtitle: 'Three checks before you sign', footer: 'Rakesh, Advocate', theme: 'blue' });
  check('a picture card is made', made.ok === true && /\.png$/i.test(made.data?.path ?? ''), made);
  if (made.ok === true) {
    const path = made.data.path;
    const bytes = readFileSync(path);
    const isPng = bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    check('it is a real PNG of exactly 1200 x 627', isPng && width === 1200 && height === 627, { isPng, width, height, size: bytes.length });
    check('and it is not a blank page (a picture with real content is far bigger than a flat one)', bytes.length > 12000, bytes.length);
    copyFileSync(path, join(SP, 'social-card.png'));
    // the picture can be attached to a draft
    const withPic = await tool('social_draft', { action: 'update', id: saved.data.id, image_path: path });
    check('the picture goes on the draft', withPic.ok === true && withPic.data?.picture === made.data.name, withPic);
    // (the test's own picture is removed again: it was made in the real Pictures folder)
    try { unlinkSync(path); rmdirSync(dirname(path)); } catch { /* folder not empty or already gone */ }
  }

  // the Plugins page shows it
  const nav = await evalIn(`(() => { const b = [...document.querySelectorAll('.nav-item')].find((x) => x.textContent.trim().startsWith('Plugins')); if (!b) return 'no nav'; b.click(); return 'clicked'; })()`);
  await sleep(1500);
  const text = String(await evalIn('document.body.innerText'));
  check('the Plugins page lists LinkedIn and what it may do', nav === 'clicked' && /LinkedIn/.test(text) && /Publish posts/.test(text), { nav, text: text.slice(0, 400) });
  const after = JSON.stringify(await evalIn('window.eya.getPlugins()'));
  check('only drafting was allowed: the two publish permissions are still off', /Prepare drafts and pictures[^}]*"granted":true/.test(after) && /Publish posts[^}]*"granted":false/.test(after) && /Publish comments and replies[^}]*"granted":false/.test(after), after.slice(0, 600));

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
  console.log('app log:', logFile);
} catch (e) {
  failures++;
  console.log('ERROR', e instanceof Error ? e.stack : e);
} finally {
  stopApp();
  process.exit(failures === 0 ? 0 : 1);
}
