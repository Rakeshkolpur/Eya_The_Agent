// Run from the project folder after 'npx electron-vite build':  node tests/live/plugins-e2e.mjs
// The BUILT app (a separate copy with its own empty profile and test ports): the Plugins page, and the rules behind it, as the person meets them —
// installed is not connected is not allowed; connecting WhatsApp is Communication Access (and does not allow other apps); a tool of a plugin that is
// not allowed is refused by the real tool registry; uninstalling takes the access away; all of it survives a restart.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROJECT = process.cwd().split('\\').join('/');
const OUT = join(tmpdir(), 'eya-e2e-out');
mkdirSync(OUT, { recursive: true });
const CDP = 9335;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 600)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userData = mkdtempSync(join(tmpdir(), 'eya-plugins-'));

function launch() {
  const env = { ...process.env, EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1', EYA_OLLAMA_URL: 'http://127.0.0.1:1', EYA_BRIDGE_PORT: '47833', EYA_NO_BROWSER_LAUNCH: '1', EYA_NO_MIC: '1' };
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
        if (await c.evalIn('typeof window.eya !== "undefined" && typeof window.eya.getPlugins === "function" && typeof window.eya.runLiveTool === "function"').catch(() => false)) return c;
        c.close();
      }
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  throw new Error('the window never appeared');
}

const readJson = (name) => {
  const p = join(userData, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : null;
};

try {
  let stop = launch();
  let main = await connectMain();
  await sleep(4000);
  const snap = async () => (await main.evalIn('window.eya.getPlugins()')).plugins.find((p) => p.id === 'whatsapp');
  const clickText = (label) => main.evalIn(`(() => { const b = [...document.querySelectorAll('button, a, [role=button]')].find(x => x.textContent.trim() === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (b) b.click(); return !!b; })()`);
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(250); } return false; };
  const tool = async (name, args) => {
    const raw = await main.evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard: 'test' })}).then(r => r.content)`);
    try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; }
  };

  // ---- first run: there, switched on, nothing connected, nothing allowed
  let w = await snap();
  check('WhatsApp is there on the first run, installed and switched on', w?.installed === true && w?.enabled === true, w);
  check('…but not connected, and nothing is allowed', w?.connection === 'not_connected' && w?.permissions.every((p) => !p.granted) && w?.status === 'not_connected', w);
  check('the page says no online catalogue is connected', (await main.evalIn('window.eya.getPlugins()')).catalogue.remote === false);

  // ---- the page
  await main.evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
  await sleep(1500);
  await clickText('Plugins');
  const shown = await waitFor(() => main.evalIn(`!!document.querySelector('section[aria-label="WhatsApp plugin"]')`));
  check('the Plugins page shows the WhatsApp card', shown);
  const text = await main.evalIn(`document.querySelector('.plugins-page')?.innerText ?? ''`);
  check('it says plainly that nothing is downloaded and installing allows nothing', /No online catalogue is connected/.test(text) && /Installing connects nothing and allows nothing|Installed/.test(text), text.slice(0, 400));
  await clickText('What can it do?');
  await sleep(400);
  const more = await main.evalIn(`document.querySelector('.plugins-page')?.innerText ?? ''`);
  check('it lists what is NOT supported, as not supported', /Find messages[\s\S]*Not supported yet/.test(more) && /Save a file received in a chat[\s\S]*Not supported yet/.test(more), more.slice(-700));
  const shot = await main.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) writeFileSync(join(OUT, 'plugins-page.png'), Buffer.from(shot.result.data, 'base64'));

  // ---- tools are refused while the plugin cannot be used (the real registry, in the real app)
  const refused = await tool('find_chat', { query: 'anna' });
  check('a tool of the plugin is refused while WhatsApp is not connected, in words for the person', /plugin is not connected|Chats are off/i.test(JSON.stringify(refused)) || refused?.data?.pluginBlocked === true, refused);

  // ---- connect: the same switch as Communication Access, and nothing else is allowed by it
  await clickText('Connect');
  await waitFor(async () => (await snap())?.connection === 'connected');
  w = await snap();
  check('Connect connects WhatsApp — and allows nothing yet', w?.connection === 'connected' && w?.status === 'missing_permission', w);
  const comm = readJson('communication-access.json');
  check('that is Communication Access: WhatsApp is on', comm?.enabled === true && comm?.apps?.whatsapp === true, comm);
  const others = Object.entries(comm?.apps ?? {}).filter(([id, v]) => id !== 'whatsapp' && v !== false);
  check('and no other chat app was allowed by it', others.length === 0, comm);
  const noPerm = await tool('find_chat', { query: 'anna' });
  check('connected is not authorized: the tool is still refused, for the missing permission', /has not been given the permission/.test(JSON.stringify(noPerm)), noPerm);

  // ---- allow, then take one permission away
  await clickText('Allow all');
  await waitFor(async () => (await snap())?.status === 'ready');
  w = await snap();
  check('Allow all makes it ready', w?.status === 'ready' && w?.permissions.every((p) => p.granted), w);
  check('the grants are written down', (readJson('plugins.json')?.plugins?.whatsapp?.granted ?? []).length === 5, readJson('plugins.json'));
  const allowed = await tool('find_chat', { query: 'anna' });
  check('now the tool runs (and fails only for lack of a browser, not for a plugin reason)', !/plugin|permission/i.test(JSON.stringify(allowed?.data?.pluginBlocked ?? '')) && allowed?.data?.pluginBlocked !== true, allowed);
  await main.evalIn(`window.eya.changePlugin({ kind: 'revoke', id: 'whatsapp', permission: 'chats.read' })`);
  const revoked = await tool('find_chat', { query: 'anna' });
  check('after the person takes "find chats" away the same tool is refused', revoked?.data?.pluginBlocked === true || /"Find chats and contacts"/.test(JSON.stringify(revoked)), revoked);

  // ---- a choice that is not a real one changes nothing
  const junk = await main.evalIn(`window.eya.changePlugin({ kind: 'grant', id: 'whatsapp', permission: 'rm -rf' })`);
  check('a made-up choice from the page is refused', junk?.ok === false, junk);
  const unknown = await main.evalIn(`window.eya.changePlugin({ kind: 'install', id: 'no-such-plugin' })`);
  check('so is a plugin that is not in the catalogue', unknown?.ok === false && /no such plugin|not something/i.test(unknown.message), unknown);

  // ---- restart: what the person chose is still chosen
  main.close();
  stop();
  await sleep(3000);
  stop = launch();
  main = await connectMain();
  await sleep(3000);
  w = await snap();
  check('after a restart: still connected, and "find chats" is still taken away', w?.connection === 'connected' && w?.permissions.find((p) => p.id === 'chats.read')?.granted === false && w?.permissions.find((p) => p.id === 'messages.send')?.granted === true, w);

  // ---- uninstall: the access goes with it, and it is not put back
  await main.evalIn(`window.eya.changePlugin({ kind: 'uninstall', id: 'whatsapp' })`);
  w = await snap();
  check('uninstalling removes it and its permissions', w?.installed === false && w?.permissions.every((p) => !p.granted), w);
  check('and disconnects WhatsApp (Communication Access)', readJson('communication-access.json')?.apps?.whatsapp === false, readJson('communication-access.json'));
  main.close();
  stop();
  await sleep(3000);
  stop = launch();
  main = await connectMain();
  await sleep(3000);
  w = await snap();
  check('after another restart it is still uninstalled (not put back by itself)', w?.installed === false, w);
  const again = await main.evalIn(`window.eya.changePlugin({ kind: 'install', id: 'whatsapp' })`);
  const back = again?.snapshot?.plugins?.find((p) => p.id === 'whatsapp');
  check('installing again gives it nothing: not connected, nothing allowed', again?.ok === true && back?.connection === 'not_connected' && back?.permissions.every((p) => !p.granted), back);
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
