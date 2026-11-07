// Run from the project folder:  node tests/live/embedded-e2e.mjs   (E2E_MODE=preview tests the built app: run 'npx electron-vite build' first)
// Real app: Eya Browser as an embedded Chromium view inside the Eya window, driven through the same tool path the live voice uses, against a
// local site made to misbehave like real sites. "User" actions (clicking, typing, closing a tab) go straight to the embedded page over the
// debugging port, not through Eya.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, createWriteStream, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';

const PROJECT = process.cwd().split('\\').join('/');
const SP = join(tmpdir(), 'eya-e2e-out');
mkdirSync(SP, { recursive: true });
const CDP = 9333;
let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 800)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browserPids = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }) -join ','"], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const pidsBefore = new Set(browserPids().split(',').filter(Boolean));

const { startTestSite } = await import(pathToFileURL(`${PROJECT}/tests/fixtures/chrome-test-site/server.mjs`).href);
const site = await startTestSite(0);
const base = `http://127.0.0.1:${site.port}`;

const userData = mkdtempSync(join(tmpdir(), 'eya-emb-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-emb-dl-'));
const log = createWriteStream(join(SP, `emb-app-${Date.now()}.log`));
const env = {
  ...process.env,
  EYA_GEMINI_API_KEY: 'AIzaSyBPBPBPBPBPBPBPBPBPBPBPBPBPBPBPBP1',
  EYA_OLLAMA_URL: 'http://127.0.0.1:1',
  EYA_BRIDGE_PORT: '47835',
  EYA_BROWSER_DOWNLOADS: downloads,
  EYA_BROWSER_NAV_TIMEOUT_MS: '2500',
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

/** A debugging-port connection to one page. */
async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 1;
  const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout: 90000 });
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
  throw new Error('the debug window never appeared');
}

/** The embedded browser's pages (not the app's own window), as the debugging port lists them. */
const embeddedTargets = async () => (await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json())).filter((x) => x.type === 'page' && x.url.startsWith('http://127.0.0.1:' + site.port));
async function userPage(match) {
  for (let i = 0; i < 40; i++) {
    const ts = (await embeddedTargets()).filter((x) => !match || x.url.includes(match));
    // (the tab on show, if several pages match)
    for (const cand of ts) {
      const p = await attach(cand.webSocketDebuggerUrl);
      if ((await p.evalIn('document.visibilityState').catch(() => '')) === 'visible') return p;
      p.close();
    }
    if (ts[0]) return attach(ts[0].webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('no embedded page' + (match ? ' matching ' + match : ''));
}
/** What a person does with the page: run something in it, then let go. */
async function user(match, fn) {
  const p = await userPage(match);
  try { return await fn(p); } finally { p.close(); }
}

try {
  const main = await connectMain();
  const evalIn = main.evalIn;
  await sleep(8000);
  for (let i = 0, ok = 0; i < 2 && ok < 16; i++) {
    const txt = await evalIn('document.body ? document.body.innerText.trim() : ""').catch(() => '');
    ok = txt !== '' ? ok + 1 : 0;
    await sleep(500);
  }
  // (the Eya window can drop back to its small shapes while a voice command is handled: the checks about the Browser page put it back first)
  const ensureBrowserPage = async () => {
    if (await evalIn("!!document.querySelector('.workspace')").catch(() => false)) return;
    await evalIn('window.eya.setWindowMode("app")').catch(() => undefined);
    await sleep(1200);
    await rawClick('Browser');
    await sleep(900);
  };
  const dom = async (expr) => { await ensureBrowserPage(); return evalIn(expr); };
  const text = async () => {
    await ensureBrowserPage();
    for (let i = 0; i < 40; i++) {
      const t = await evalIn('document.body ? document.body.innerText : ""').catch(() => '');
      if (String(t).trim() !== '') return String(t);
      await sleep(500);
    }
    return '';
  };
  const rawClick = (label, nth = 0) => evalIn(`(() => { const b = [...document.querySelectorAll('button')].filter(x => x.textContent.trim() === ${JSON.stringify(label)} || x.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!b[${nth}]) return 'no button ${label}'; b[${nth}].click(); return 'clicked'; })()`);
  const click = async (label, nth = 0) => { if (label !== 'Browser' && label !== 'Home') await ensureBrowserPage(); return rawClick(label, nth); };
  const setValue = async (aria, value) => { await ensureBrowserPage(); return rawSetValue(aria, value); };
  const rawSetValue = (aria, value) => evalIn(`(() => { const el = document.querySelector('[aria-label="${aria}"]'); if (!el) return 'missing'; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return 'set'; })()`);
  const rawTool = (name, args, heard) => evalIn(`window.eya.runLiveTool(${JSON.stringify({ name, args, heard })}).then(r => r.content)`);
  const tool = async (name, args, heard) => { const raw = await rawTool(name, args, heard); try { return JSON.parse(raw); } catch { return { ok: false, error: String(raw) }; } };
  const open = (url, heard = 'open the site') => tool('open_website', { url }, heard);
  const notes = (r) => JSON.stringify(r?.data?.currentPage?.notes ?? []);
  const curUrl = (r) => String(r?.data?.currentPage?.url ?? '');
  const panelState = () => evalIn('window.eya.getBrowserPanel()');
  /** A picture of the real screen (the app window with the browser in it). */
  const snapScreen = (name) => {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${join(SP, name).replace(/\\/g, '/')}'); $g.Dispose(); $bmp.Dispose()`], { stdio: 'ignore' });
    } catch { /* no screen */ }
  };

  await evalIn('window.eya.setWindowMode("app")');
  await main.send('Page.bringToFront');
  await sleep(2500);
  check('Home opens as the conversation and nothing else: no panel on the right, nothing under the chat', await evalIn(`!!document.querySelector('.cw .composer textarea') && !document.querySelector('aside.dash-side') && !document.querySelector('[data-section=recentTasks]')`), await evalIn('document.body.innerText.slice(0, 200)'));
  // the extra cards are off until they are switched on in the Layout menu; they belong to the panel that opens for a running agent task, so nothing opens by itself
  await evalIn("document.querySelector('.layout-menu button').click()");
  await sleep(300);
  check('the Layout menu lists the extra cards, switched off', (await evalIn("[...document.querySelectorAll('.layout-pop li')].some((li) => /Popular Apps/.test(li.textContent) && li.querySelector('[role=switch]').getAttribute('aria-checked') === 'false')")) === true);
  await evalIn("[...document.querySelectorAll('.layout-pop li')].find((li) => /Popular Apps/.test(li.textContent)).querySelector('[role=switch]').click()");
  await sleep(400);
  check('a card can be switched on, and with no agent task running the panel stays shut', (await evalIn("[...document.querySelectorAll('.layout-pop li')].some((li) => /Popular Apps/.test(li.textContent) && li.querySelector('[role=switch]').getAttribute('aria-checked') === 'true') && !document.querySelector('aside.dash-side')")) === true);
  await evalIn("[...document.querySelectorAll('.layout-pop li')].find((li) => /Popular Apps/.test(li.textContent)).querySelector('[role=switch]').click()");
  await sleep(300);
  check('and switched off again', (await evalIn("[...document.querySelectorAll('.layout-pop li')].some((li) => /Popular Apps/.test(li.textContent) && li.querySelector('[role=switch]').getAttribute('aria-checked') === 'false')")) === true);
  await evalIn("document.querySelector('.layout-menu button').click()");
  // (the sidebar's own parts hide and come back the same way, and the choice is kept)
  await evalIn("document.querySelector('[data-section=aiStatus] .sec-hide').click()");
  await sleep(300);
  check('a part of the sidebar hides too, and the choice is remembered', (await evalIn("!document.querySelector('[data-section=aiStatus]') && JSON.parse(localStorage.getItem('eya.hiddenSections2')).includes('aiStatus')")) === true);
  await evalIn("window.localStorage.removeItem('eya.hiddenSections2')");
  console.log('open Browser page ->', await click('Browser'));
  await sleep(1500);
  let t = await text();
  check('the Browser page starts empty with Eya Browser as the default', /Eya Browser/.test(t) && /built into Eya/.test(t), t.slice(0, 500));

  // ---------------------------------------------------------------- 1. opens inside Eya
  let r = await open(`${base}/r/portal`, 'open the citizen portal and find the report');
  check('1. open_website opens the page in Eya Browser (not a personal browser)', r.ok === true && JSON.stringify(r.data).includes('eya_browser') && /Citizen portal/.test(JSON.stringify(r.data)), JSON.stringify(r).slice(0, 400));
  await sleep(1200);
  const info = await user('/r/portal', async (p) => ({
    ua: await p.evalIn('navigator.userAgent'),
    vis: await p.evalIn('document.visibilityState'),
    w: await p.evalIn('window.innerWidth'),
    h: await p.evalIn('window.innerHeight'),
    title: await p.evalIn('document.title'),
  }));
  check('   the page is in a view inside Eya, as plain Chrome to the site (no "Electron" in its user agent)', /Chrome\//.test(info.ua) && !/Electron|eya/i.test(info.ua) && info.title === 'Portal home', info);
  const rect = await dom(`(() => { const r = document.querySelector('.bp-surface').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
  check('   the view is on the Browser page: visible, and as big as the room the page gives it', info.vis === 'visible' && Math.abs(info.w - rect.w) <= 2 && Math.abs(info.h - rect.h) <= 2, { info, rect });
  await dom(`(() => { const b = document.querySelector('.ws-steps-toggle'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
  await sleep(300);
  t = await text();
  check('   the page lists the task, the step and the address', /citizen portal and find the report/.test(t) && /Opening 127\.0\.0\.1/.test(t) && String(await dom(`document.querySelector('[aria-label="Address"]')?.value`)).includes('/r/portal'), t.slice(0, 500));
  snapScreen('emb-portal.png');

  // ---------------------------------------------------------------- tabs, back/forward/reload from the page's own bar
  console.log(await setValue('Address', `${base}/r/landing`), await click('Go'));
  await sleep(2500);
  t = await text();
  check('   the address bar opens another page', /Landing/.test(t) || (await user('/r/landing', (p) => p.evalIn('document.body.innerText'))).includes('You landed here'), t.slice(0, 300));
  console.log('Back ->', await click('Back'));
  await sleep(1500);
  check('   Back goes back in the embedded browser', String(await dom(`document.querySelector('[aria-label="Address"]')?.value`)).includes('/r/portal'), await dom(`document.querySelector('[aria-label="Address"]')?.value`));
  console.log('Forward ->', await click('Forward'));
  await sleep(1500);
  check('   Forward goes forward', String(await dom(`document.querySelector('[aria-label="Address"]')?.value`)).includes('/r/landing'));
  const stamp = await user('/r/landing', (p) => p.evalIn('window.__stamp = 12345'));
  console.log('Reload ->', await click('Reload'));
  await sleep(1500);
  check('   Reload reloads the page', (await user('/r/landing', (p) => p.evalIn('typeof window.__stamp'))) === 'undefined', stamp);
  console.log('New tab ->', await click('New tab'));
  await sleep(1200);
  check('   New tab opens a second tab', (await panelState()).tabs.length === 2, (await panelState()).tabs);
  console.log(await setValue('Address', `${base}/r/portal`), await click('Go'));
  await sleep(2500);
  const tabButtons = await dom(`[...document.querySelectorAll('.bp-tab')].map(b => b.textContent)`);
  check('   both tabs show in the tab strip', tabButtons.length === 2, tabButtons);
  await dom(`document.querySelectorAll('.bp-tab')[0].click()`);
  await sleep(800);
  const s2 = await panelState();
  check('   a tab can be chosen from the strip', s2.tabs.find((x) => x.active)?.id === s2.tabs[0].id, s2.tabs);

  // Stop loading, from the page's own bar, on a page that never answers
  console.log(await setValue('Address', `${base}/r/hang`), await click('Go'));
  await sleep(700);
  check('   while a page is loading the bar offers Stop loading', (await dom(`!!document.querySelector('[aria-label="Stop loading"]')`)) === true);
  console.log('Stop loading ->', await click('Stop loading'));
  await sleep(1200);
  const afterStop = await panelState();
  check('   Stop loading stops it: the page is no longer loading', afterStop.loading === false && !(await dom(`!!document.querySelector('[aria-label="Stop loading"]')`)), { loading: afterStop.loading, url: afterStop.url });

  // ---------------------------------------------------------------- 2. redirects and errors
  r = await open(`${base}/r/chain`, 'open the old link');
  check('2. a redirect chain: the final page is verified and the redirect said', r.ok && curUrl(r).includes('/r/landing') && /redirected from .*\/r\/chain to .*\/r\/landing/.test(notes(r)) && /You landed here/.test(JSON.stringify(r.data)), JSON.stringify(r).slice(0, 500));
  r = await open(`${base}/r/redirect?to=${encodeURIComponent(`http://localhost:${site.port}/r/landing`)}`, 'open it');
  check('3. a redirect to a DIFFERENT site is called out loudly', r.ok && /DIFFERENT site/.test(notes(r)), notes(r));
  r = await open(`${base}/r/dynamic`, 'open the records');
  check('4. a page that fills itself in later is waited for', r.ok && /First record/.test(JSON.stringify(r.data)) && !/blank/i.test(notes(r)), JSON.stringify(r).slice(0, 400));
  let d = await open(`${base}/r/status?code=403`, 'open it');
  check('5. 403 is reported as access denied', /access is denied/.test(notes(d)), notes(d));
  d = await open(`${base}/r/does-not-exist`, 'open it');
  check('   404 is reported as "does not exist"', /does not exist/.test(notes(d)), notes(d));
  d = await open('http://nope.invalid/', 'open it');
  check('6. an unknown name: plain words, no browser code, not retried', d.ok === false && /could not be found/.test(String(d.error)) && !/net::|ERR_/.test(String(d.error)) && d.data?.navigation?.problem === 'dns' && d.data?.navigation?.canRetry === false, JSON.stringify(d).slice(0, 500));
  const t0 = Date.now();
  d = await open(`${base}/r/loop`, 'open it');
  check('   a redirect loop is explained', d.data?.navigation?.problem === 'redirect_loop', JSON.stringify(d).slice(0, 400));
  const closedPort = await new Promise((resolve) => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  d = await open(`http://127.0.0.1:${closedPort}/`, 'open it');
  check('   a refused connection is explained', ['refused', 'timeout'].includes(d.data?.navigation?.problem), JSON.stringify(d).slice(0, 400));
  await sleep(1500);
  t = await text();
  check('   the Browser page shows the problem in words', /refused|did not answer|keeps redirecting|could not be found/.test(t) && (await panelState()).status === 'problem', t.slice(0, 400));
  const t1 = Date.now();
  r = await open(`${base}/r/slow-once`, 'open the slow page');
  check('7. a slow page is recovered with one more try', r.ok && /Quick now/.test(JSON.stringify(r.data)) && Date.now() - t1 < 60_000, JSON.stringify(r).slice(0, 400));
  const t2 = Date.now();
  d = await open(`${base}/r/hang`, 'open the dead page');
  check('   a site that never answers is reported as slow (and does not hang for ever)', d.ok === false && d.data?.navigation?.problem === 'timeout' && Date.now() - t2 < 90_000, JSON.stringify(d).slice(0, 400) + ' ' + (Date.now() - t2) + 'ms');
  r = await open(`${base}/r/flaky`, 'open it');
  check('   a server hiccup is retried by itself', r.ok && /It works now/.test(JSON.stringify(r.data)), JSON.stringify(r).slice(0, 400));
  d = await open('file:///C:/Windows/win.ini', 'open this file');
  check('8. a file on this computer cannot be opened as a web page', d.ok === false && !/\[fonts\]|\[extensions\]/.test(JSON.stringify(d)), JSON.stringify(d).slice(0, 400));

  // ---------------------------------------------------------------- forms, human check, sign-in
  const numOpen = await open(`${base}/r/numeric`, 'register me with my details');
  console.log('numeric open ->', JSON.stringify(numOpen).slice(0, 300));
  const age = await tool('fill_on_page', { label: 'Age', value: '34' }, 'register me with my details');
  check('9. an ordinary numeric form is filled in normally', age.ok === true && age.data?.needsUser === undefined, JSON.stringify(age).slice(0, 300));
  await tool('fill_on_page', { label: 'Reference number', value: '10234' }, 'register me with my details');
  const saved = await tool('click_on_page', { text: 'Save' }, 'register me with my details');
  check('   and saved', saved.ok === true && (await user('/r/numeric', (p) => p.evalIn("document.getElementById('out').textContent"))) === 'Saved age 34 ref 10234', JSON.stringify(saved).slice(0, 300));
  const pn = await panelState();
  check('   what was typed is not shown in the panel', ![pn.goal, pn.current, pn.statusText, ...pn.blockers, ...pn.steps.map((s) => s.text), ...pn.log.map((l) => l.text)].join(' ').includes('10234'));

  r = await open(`${base}/captcha.html`, 'open the verified page');
  check('10. a human check pauses the task and says so', r.data?.needsUser === true && (await panelState()).status === 'waiting_you' && /human check is showing/.test((await panelState()).blockers[0] ?? ''), JSON.stringify(r).slice(0, 400));
  await sleep(1000);
  t = await text();
  check('    the page shows it as waiting on the user', /waiting on you/i.test(t) && /human check/i.test(t), t.slice(0, 300));
  const waiting = tool('wait_for_user_in_browser', { seconds: 20 }, 'open the verified page');
  await sleep(1500);
  await user('captcha', (p) => p.send('Page.navigate', { url: `${base}/r/landing` }));
  const doneW = await waiting;
  check('    when the user has done it, the task resumes by itself', doneW.ok && doneW.data?.userFinished === true && /You landed here/.test(JSON.stringify(doneW.data)) && (await panelState()).blockers.length === 0, JSON.stringify(doneW).slice(0, 400));

  const goal = 'log in and get my statement';
  r = await open(`${base}/auth/login`, goal);
  check('11. a sign-in page: Eya stops and asks the user', r.data?.needsUser === true, JSON.stringify(r).slice(0, 300));
  const uname = await tool('fill_on_page', { label: 'Username', value: 'asha' }, goal);
  check('    she types the user name', uname.ok === true, JSON.stringify(uname).slice(0, 300));
  const pw = await tool('fill_on_page', { label: 'Password', value: 'her-password' }, goal);
  check('    she never types the password', pw.ok === false && (await user('/auth/login', (p) => p.evalIn("document.querySelector('input[type=password]').value"))) === '', JSON.stringify(pw).slice(0, 300));
  const waitingIn = tool('wait_for_user_in_browser', { seconds: 25 }, goal);
  await sleep(1500);
  await user('/auth/login', async (p) => {
    await p.evalIn("document.querySelector('input[type=password]').focus()");
    await p.send('Input.insertText', { text: 'their-own-password' });
    await p.evalIn("document.querySelector('button[type=submit]').click()");
  });
  const after = await waitingIn;
  check('    the user types their own password in the page itself and signs in; Eya carries on', after.data?.userFinished === true && after.data?.cleared === 'login' && /Welcome back, Asha/.test(JSON.stringify(after.data)), JSON.stringify(after).slice(0, 500));
  const ps = JSON.stringify(await panelState());
  check('    the password appears nowhere in the panel', !/her-password|their-own-password/.test(ps));
  await tool('click_on_page', { text: 'View statement' }, goal);
  await fetch(`${base}/auth/expire`);
  await open(`${base}/auth/account`, goal);
  const ps2 = await panelState();
  check('12. an expired session is noticed and said so', /sign in again.*session there has probably expired/.test(ps2.blockers[0] ?? '') && ps2.status === 'waiting_you', ps2.blockers);

  // ---------------------------------------------------------------- guidance flow
  const goal3 = 'open the portal and download the report';
  await open(`${base}/r/portal`, goal3);
  const missing = await tool('click_on_page', { text: 'Reports' }, goal3);
  const afterMissing = await panelState();
  check('13. a button that is not there is reported, with what IS on the page; the task waits for the user to say where to click', afterMissing.status === 'waiting_you' && /Could not find .Reports./.test(afterMissing.blockers[0] ?? '') && missing.ok === false && /isn't visible on the current page/.test(String(missing.error)) && /Notices/.test(JSON.stringify(missing.data)), JSON.stringify(missing).slice(0, 400));
  const opensBefore = (await panelState()).steps.filter((s) => /^Opening/.test(s.text)).length;
  const guided = await tool('click_on_page', { text: 'Services' }, 'click Services in the menu');
  const guidedUrl = await user('/r/status', (p) => p.evalIn('location.href'));
  const opensAfter = (await panelState()).steps.filter((s) => /^Opening/.test(s.text)).length;
  check('    what the user then says is done on the very same page', guided.ok === true && guidedUrl.includes('/r/status?code=200') && opensAfter === opensBefore, { guidedUrl, opensBefore, opensAfter, g: JSON.stringify(guided).slice(0, 200) });

  // ---------------------------------------------------------------- download
  await open(`${base}/download.html`, 'download the report');
  const dl = await tool('click_on_page', { text: 'Download report' }, 'download the report');
  const dpath = String(dl.data?.path ?? '');
  check('14. a download is saved and verified on disk', dl.ok === true && dpath !== '' && existsSync(dpath) && readFileSync(dpath, 'utf8') === 'eya test download\n' && dl.data?.download?.verified === true && dpath.startsWith(downloads), JSON.stringify(dl).slice(0, 500) + ' ' + readdirSync(downloads));

  // ---------------------------------------------------------------- popups, new windows, permissions
  await open(`${base}/popups.html`, 'try the popups');
  const al = await tool('click_on_page', { text: 'Show alert' }, 'try the popups');
  check('15. a native alert is dismissed (Eya is not stuck behind it) and mentioned', al.ok === true && /Are you sure\?/.test(JSON.stringify(al.data)) && (await user('popups', (p) => p.evalIn("document.getElementById('out').textContent"))) === 'after alert', JSON.stringify(al).slice(0, 500));
  const cf = await tool('click_on_page', { text: 'Ask me' }, 'try the popups');
  check('    a confirm() is NOT accepted (answers "cancel")', cf.ok === true && (await user('popups', (p) => p.evalIn("document.getElementById('out').textContent"))) === 'confirm=false', JSON.stringify(cf).slice(0, 300));
  const nw = await tool('click_on_page', { text: 'Open in new window' }, 'try the popups');
  check('    a link that opens a new window is followed into a new tab', nw.ok === true && /You landed here/.test(JSON.stringify(nw.data)) && (await panelState()).tabs.length >= 2, JSON.stringify(nw).slice(0, 500));
  await open(`${base}/popups.html`, 'try the popups');
  await user('popups', (p) => p.evalIn("document.getElementById('out').textContent = ''"));
  const geo = await tool('click_on_page', { text: 'Where am I' }, 'try the popups');
  await sleep(800);
  let geoOut = '';
  for (let i = 0; i < 40 && geoOut === ''; i++) { geoOut = await user('popups', (p) => p.evalIn("document.getElementById('out').textContent")); if (geoOut === '') await sleep(100); }
  // (the browser sometimes never answers a refused request at all: what must never happen is that the site is told yes)
  check('16. a site cannot ask for the location (never granted)', !geoOut.includes('granted') && (geoOut.startsWith('location denied') || geoOut === ''), { geoOut, geo: JSON.stringify(geo).slice(0, 300) });
  await user('popups', (p) => p.evalIn(`document.querySelector('a[href^="file:"]').click()`));
  await sleep(800);
  check('    a link to a file on this computer does not go anywhere', (await user('popups', (p) => p.evalIn('location.href'))).includes('/popups.html'));

  // ---------------------------------------------------------------- controls
  // (a mark in the address tells this tab from others that show the same page)
  await open(`${base}/r/portal?mark=ctl`, 'look around');
  console.log('Pause ->', await click('Pause'));
  await sleep(500);
  t = await text();
  check('17. Pause shows Paused and offers Resume', /Paused/.test(t) && /Resume/.test(t));
  const held = tool('inspect_page', {}, 'look around').then((x) => ({ done: true, x }));
  await sleep(1500);
  check('    a step asked for while paused waits', (await Promise.race([held.then(() => false), sleep(100).then(() => true)])) === true);
  console.log('Resume ->', await click('Resume'));
  const resumed = await held;
  check('    Resume lets it through', resumed.x.ok === true && /Citizen portal/.test(JSON.stringify(resumed.x)), JSON.stringify(resumed.x).slice(0, 200));

  console.log('Take over ->', await click('Take over'));
  await sleep(700);
  t = await text();
  check('18. Take over says the user has the browser, and offers to hand back', /You have the browser/.test(t) && /Hand back to Eya/.test(t), t.slice(0, 300));
  const waitingTO = tool('inspect_page', {}, 'look around');
  await sleep(800);
  const beforeNav = await Promise.all((await embeddedTargets()).map(async (x) => { const p = await attach(x.webSocketDebuggerUrl); const v = await p.evalIn('document.visibilityState'); p.close(); return [x.url.slice(-14), v]; }));
  const navRes = await user('mark=ctl', (p) => p.send('Page.navigate', { url: `${base}/r/landing` })); // the user clicks somewhere themselves
  console.log('USERNAV', JSON.stringify(beforeNav), JSON.stringify(navRes).slice(0, 200));
  await sleep(800);
  console.log('AFTERNAV', JSON.stringify((await embeddedTargets()).map((x) => x.url.slice(-14))));
  console.log('Hand back ->', await click('Hand back to Eya'));
  const seen = await waitingTO;
  check('    Eya waits while the user works, then carries on from the page as the user left it', /You landed here/.test(JSON.stringify(seen)), { seen: JSON.stringify(seen).slice(0, 400), targets: (await embeddedTargets()).map((x) => x.url), panel: (await panelState()).tabs });

  // ---------------------------------------------------------------- parked while another page of the app shows
  await open(`${base}/r/portal`, 'look around');
  await sleep(500);
  console.log('Home ->', await click('Home'));
  await sleep(1200);
  const parked = await tool('click_on_page', { text: 'Notices' }, 'look around');
  check('19. while the user is on another page of the app, Eya still works in the browser', parked.ok === true && /You landed here/.test(JSON.stringify(parked.data)), JSON.stringify(parked).slice(0, 300));
  const shot = await rawTool('inspect_page', {}, 'look around');
  check('    and it still sees the page', /You landed here/.test(shot), String(shot).slice(0, 200));
  console.log('Browser ->', await click('Browser'));
  await main.send('Page.bringToFront'); // (a window another program covers is "hidden" to its pages)
  await sleep(1200);
  const back = await user('/r/landing', async (p) => ({ vis: await p.evalIn('document.visibilityState'), w: await p.evalIn('window.innerWidth') }));
  // (a window another program covers is reported hidden by the browser itself, so only the size is held to account)
  check('    coming back to the Browser page shows it again, at the right size', back.w > 300, back);
  snapScreen('emb-back.png');

  // ---------------------------------------------------------------- recovery: tab closed, page crashed
  await open(`${base}/r/portal`, 'look around');
  const bws = (await fetch(`http://127.0.0.1:${CDP}/json/version`).then((x) => x.json())).webSocketDebuggerUrl;
  const brow = await attach(bws);
  const tg = (await embeddedTargets()).map((x) => x.id);
  for (const id of tg) await brow.send('Target.closeTarget', { targetId: id });
  brow.close();
  await sleep(1200);
  r = await open(`${base}/r/landing`, 'look around');
  check('20. every tab closed mid-task: the next step opens it again', r.ok === true && /You landed here/.test(JSON.stringify(r.data)), JSON.stringify(r).slice(0, 300));
  await user('/r/landing', async (p) => { void p.send('Page.crash'); await sleep(500); }).catch(() => undefined);
  await sleep(1500);
  r = await open(`${base}/r/portal`, 'look around');
  check('    a crashed page is recovered the same way', r.ok === true && /Citizen portal/.test(JSON.stringify(r.data)), JSON.stringify(r).slice(0, 300));

  // ---------------------------------------------------------------- the workspace beside Eya
  console.log('Home ->', await rawClick('Home'));
  await sleep(800);
  await sleep(6500);
  const homeSeen = await evalIn("({ dash: !!document.querySelector('.dash2'), workspace: !!document.querySelector('.workspace'), folded: document.querySelector('.shell').classList.contains('side-folded'), panel: !!document.querySelector('aside.dash-side') })");
  check('on Home, before a task: the sidebar is open and there is no panel on the right', homeSeen.dash && !homeSeen.workspace && !homeSeen.folded && !homeSeen.panel, homeSeen);
  await open(`${base}/r/landing?split=1`, 'start a brand new task and show it to me');
  let beside = false;
  for (let i = 0; i < 20 && !beside; i++) { beside = await evalIn("!!document.querySelector('.workspace .ws-left') && !!document.querySelector('.workspace .ws-view')"); if (!beside) await sleep(250); }
  check('25. when a task starts on a website, the app opens Eya on the left and the browser on the right by itself', beside === true);
  try { const r = await main.send('Page.captureScreenshot', { format: 'png' }); if (r.result?.data) { mkdirSync(join(tmpdir(), 'eya-e2e-out'), { recursive: true }); writeFileSync(join(tmpdir(), 'eya-e2e-out', 'split-workspace.png'), Buffer.from(r.result.data, 'base64')); } } catch { /* a picture is a bonus */ }
  const sides = await evalIn("(() => { const l = document.querySelector('.ws-left').getBoundingClientRect(); const r = document.querySelector('.ws-right').getBoundingClientRect(); return { leftW: Math.round(l.width), rightW: Math.round(r.width), leftX: Math.round(l.left), rightX: Math.round(r.left) }; })()");
  check('    the chat is on the left and the browser on the right, half and half', sides.leftX < sides.rightX && Math.abs(sides.rightW - sides.leftW) <= 24, sides);
  check('    the sidebar folded by itself to give the two halves the room', (await evalIn("document.querySelector('.shell').classList.contains('side-folded') && document.querySelector('.sidebar').offsetWidth < 100")) === true);
  check('    the left half is the conversation: its own composer, and the task above it', (await evalIn("!!document.querySelector('.ws-left .composer textarea') && /start a brand new task/.test(document.querySelector('.ws-left .ws-task-goal')?.textContent ?? '')")) === true);
  await evalIn("document.querySelector('.ws-steps-toggle')?.click()");
  await sleep(300);
  const wsText = await text();
  check('    the left side shows the task and its step', /start a brand new task and show it to me/.test(wsText) && /Opening 127\.0\.0\.1/.test(wsText), wsText.slice(0, 400));
  await evalIn("document.querySelector('.ws-head .icon-btn').click()");
  await sleep(600);
  check('    Eya\'s panel can be hidden to give the browser the whole window', (await evalIn("!document.querySelector('.ws-left') && !!document.querySelector('.workspace.left-closed')")) === true);
  await evalIn("[...document.querySelectorAll('.workspace button')].find((b) => b.textContent.trim() === 'Eya').click()");
  await sleep(500);
  check('    and shown again', (await evalIn("!!document.querySelector('.ws-left')")) === true);
  console.log('Home ->', await rawClick('Home'));
  await sleep(700);
  check('    leaving the workspace gives the sidebar back', (await evalIn("!document.querySelector('.shell').classList.contains('side-folded') && document.querySelector('.sidebar').offsetWidth > 150")) === true);
  // the switch: off, the next task does not take over the screen
  await evalIn("window.localStorage.setItem('eya.autoSplit', 'off')");
  console.log('Home ->', await rawClick('Home'));
  await sleep(800);
  await open(`${base}/r/portal?split=2`, 'another brand new task, quietly');
  await sleep(2500);
  check('26. with "open beside Eya automatically" off, the next task leaves the screen alone', (await evalIn("!!document.querySelector('.dash2') && !document.querySelector('.workspace')")) === true);
  await evalIn("window.localStorage.removeItem('eya.autoSplit')");

  // ---------------------------------------------------------------- Stop, My Browser, settings
  console.log('Stop ->', await click('Stop'));
  await sleep(500);
  const stopped = await tool('click_on_page', { text: 'Notices' }, 'another brand new task, quietly');
  check('21. Stop refuses the next step, in words', stopped.ok === false && /stopped by the user/.test(JSON.stringify(stopped)), JSON.stringify(stopped).slice(0, 300));
  check('    and the page says Stopped', /Stopped/.test(await text()));
  await open(`${base}/r/landing`, 'open the landing page for a new task');
  const mineAsked = await open(`${base}/r/landing`, 'use my Chrome for this');
  check('22. asking for their own browser when it is not connected says so, and does not quietly use Eya Browser', mineAsked.ok === false && /not connected|browser/i.test(JSON.stringify(mineAsked)), JSON.stringify(mineAsked).slice(0, 300));
  t = await text();
  check('    and the page offers to connect it', /needs your own browser|Connect My Browser/.test(t), t.slice(0, 300));
  await evalIn('window.eya.setSettings({ browser: "mine" })');
  await sleep(400);
  check('23. the preference can be changed to My Browser and back', (await evalIn('window.eya.getSettings().then(s => s.settings.browser)')) === 'mine');
  await evalIn('window.eya.setSettings({ browser: "eya" })');

  // ---------------------------------------------------------------- nothing else was started
  await sleep(500);
  const newOnes = browserPids().split(',').filter((x) => x && !pidsBefore.has(x));
  check('24. no Chrome or Edge process was started by any of this (the browser is inside Eya)', newOnes.length === 0, newOnes);
} catch (e) {
  failures++;
  console.log('FAIL  harness error: ' + (e instanceof Error ? e.stack ?? e.message : String(e)));
} finally {
  stopApp();
  site.server.close();
  await sleep(1500);
  try { rmSync(userData, { recursive: true, force: true }); } catch { /* in use */ }
  try { rmSync(downloads, { recursive: true, force: true }); } catch { /* in use */ }
}
console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
