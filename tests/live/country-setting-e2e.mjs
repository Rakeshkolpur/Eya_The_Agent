// Run from the project folder after 'npx electron-vite build':  node tests/live/country-setting-e2e.mjs
// The BUILT app (a separate copy with its own empty profile and test ports): the "Country of my phone numbers" setting is on the Settings page,
// starts at India, changes when it is picked, is written to the settings file, survives a restart, and a made-up country is refused.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9334;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 600)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = mkdtempSync(join(tmpdir(), 'eya-country-'));

function launch() {
  const env = { ...process.env, EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1', EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47834', EYA_NO_BROWSER_LAUNCH: '1', EYA_NO_MIC: '1' };
  delete env.EYA_BACKUP_AI_KEY;
  const app = spawn('cmd.exe', ['/c', 'npx', 'electron-vite', 'preview', '--', `--remote-debugging-port=${CDP}`, `--user-data-dir=${userData}`], { cwd: PROJECT, env });
  app.stdout.on('data', () => undefined);
  app.stderr.on('data', () => undefined);
  const stop = () => { try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } };
  process.on('exit', stop);
  return stop;
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 30000 });
    if (r.result?.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  return { send, evalIn, close: () => ws.close() };
}

async function connectMain() {
  for (let i = 0; i < 90; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json());
      for (const t of targets.filter((x) => x.type === 'page')) {
        const c = await attach(t.webSocketDebuggerUrl);
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getSettings === "function"').catch(() => false)) return c;
        c.close();
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}

const settingsFile = () => {
  for (const name of ['settings.json']) {
    const p = join(userData, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  }
  return null;
};

try {
  let stop = launch();
  let main = await connectMain();
  await sleep(4000);
  const country = async () => (await main.evalIn('window.eya.getSettings().then(s => s.settings.country)'));
  check('the country starts at India', (await country()) === 'IN', await country());

  // the Settings page
  await main.evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
  await sleep(1500);
  await main.evalIn(`(() => { const b = [...document.querySelectorAll('button, a, [role=button]')].find(x => /^settings$/i.test(x.textContent.trim()) || x.getAttribute('aria-label') === 'Settings'); if (b) b.click(); return !!b; })()`);
  let present = false;
  for (let i = 0; i < 20 && !present; i++) {
    present = await main.evalIn(`!!document.querySelector('select[aria-label="Country of my phone numbers"]')`);
    if (!present) await sleep(500);
  }
  check('the Settings page has the "Country of my phone numbers" choice', present);
  if (present) {
    const shown = await main.evalIn(`(() => { const s = document.querySelector('select[aria-label="Country of my phone numbers"]'); return { value: s.value, options: s.options.length, india: [...s.options].some(o => o.value === 'IN' && /India/.test(o.textContent)) }; })()`);
    check('it shows India chosen, among the offered countries', shown.value === 'IN' && shown.india && shown.options >= 10, shown);
    const shot = await main.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) writeFileSync(join(OUT, 'country-setting.png'), Buffer.from(shot.result.data, 'base64'));
    await main.evalIn(`(() => { const s = document.querySelector('select[aria-label="Country of my phone numbers"]'); s.scrollIntoView(); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'GB'); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
    await sleep(1200);
    check('picking United Kingdom changes the setting', (await country()) === 'GB', await country());
    check('and it is written to the settings file', settingsFile()?.country === 'GB', settingsFile());
  }

  // a made-up country is refused by the app, whatever the page sends
  await main.evalIn('window.eya.setSettings({ country: "ZZ" })');
  await sleep(500);
  check('a made-up country is ignored (the earlier choice stays)', (await country()) === 'GB', await country());
  await main.evalIn('window.eya.setSettings({ country: "us" })');
  await sleep(500);
  check('a real one is kept in capitals', (await country()) === 'US', await country());

  // it survives a restart
  main.close();
  stop();
  await sleep(3000);
  stop = launch();
  main = await connectMain();
  await sleep(3000);
  check('after a restart it is still the one chosen', (await country()) === 'US', await country());
  await main.evalIn('window.eya.setSettings({ country: "IN" })');
  main.close();
  stop();
} catch (err) {
  failures++;
  console.log('FAIL  the check itself broke: ' + (err instanceof Error ? err.message : String(err)));
} finally {
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* still in use */ }
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
