// End to end: the REAL running Eya app (debug instance on CDP :9222) -> its real tool registry ->
// BrowserSessionManager -> ChromeBridge -> the real extension in a real (temporary-profile) Chrome or Edge.
//
// Run it (Windows, Edge installed):
//   1. Start a SEPARATE debug Eya with its own user-data dir, so it doesn't collide with one you use:
//        set EYA_BRIDGE_PORT=47835
//        npx electron-vite dev -- --remote-debugging-port=9222 --user-data-dir=%TEMP%\eya-e2e-userdata
//      (EYA_BRIDGE_PORT keeps this test instance off port 47821, so an Eya you really use is not disturbed; the
//       extension is loaded from a copy of the folder that dials the same test port)
//   2. node tests/live/e2e-real-app.mjs
//   3. Stop that debug Eya.
// Side effects, by design: `connect_chrome` opens the browser's extensions page and the extension folder on your desktop.
// It launches a temporary headless Edge profile (deleted afterwards) and never touches your own browser profile.
// EYA_E2E_NO_DEVMODE=1 skips switching Developer mode on, to reproduce Edge disabling the unpacked extension at restart.
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
const { startTestSite } = await import(pathToFileURL(`${root}/tests/fixtures/chrome-test-site/server.mjs`).href);

let failures = 0;
const check = (name, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra ?? '').slice(0, 600)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- CDP into the running Eya
const targets = await fetch('http://127.0.0.1:9222/json').then((r) => r.json());
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 1;
const pendingCalls = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data.toString());
  if (m.id && pendingCalls.has(m.id)) {
    pendingCalls.get(m.id)(m);
    pendingCalls.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = msgId++;
    pendingCalls.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
await send('Runtime.enable');

async function tool(name, args = {}) {
  const expr = `window.eya.runLiveTool(${JSON.stringify({ name, args })}).then(r => r.content)`;
  const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 90000 });
  if (res.result?.exceptionDetails || !res.result?.result) throw new Error('CDP failure: ' + JSON.stringify(res).slice(0, 400));
  return JSON.parse(res.result.result.value);
}
const pageOf = (r) => r.data?.currentPage ?? {};

// ---- local test site + the extension in a temp-profile Edge
const site = await startTestSite(47900);
const base = `http://127.0.0.1:${site.port}`;
const profile = mkdtempSync(join(tmpdir(), 'eya-e2e-edge-'));
const downloads = mkdtempSync(join(tmpdir(), 'eya-e2e-dl-'));
mkdirSync(join(profile, 'Default'), { recursive: true });
// extensions.ui.developer_mode = what the user switches on in edge://extensions before "Load unpacked" (unless EYA_E2E_NO_DEVMODE=1)
const devMode = process.env.EYA_E2E_NO_DEVMODE !== '1';
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false }, savefile: { default_directory: downloads }, ...(devMode ? { extensions: { ui: { developer_mode: true } } } : {}) }));
// Chrome by default (the browser the user installed for this); EYA_E2E_BROWSER=edge runs the same thing in Edge.
const wantEdge = process.env.EYA_E2E_BROWSER === 'edge';
const expectedBrowser = wantEdge ? 'edge' : 'chrome';
const extensionsUrl = wantEdge ? 'edge://extensions/' : 'chrome://extensions/';
const exeName = wantEdge ? 'msedge.exe' : 'chrome.exe';
const edgePath = (wantEdge
  ? [join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(process.env['ProgramFiles'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
  : [join(process.env['ProgramFiles'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
).find(existsSync);
const bridgePort = Number(process.env.EYA_BRIDGE_PORT ?? 47835);
const extCopy = mkdtempSync(join(tmpdir(), 'eya-e2e-ext-'));
cpSync(`${root}/eya-chrome-extension`, extCopy, { recursive: true });
writeFileSync(join(extCopy, 'bridge.js'), readFileSync(join(extCopy, 'bridge.js'), 'utf8').replace('ws://127.0.0.1:47821/', `ws://127.0.0.1:${bridgePort}/`));
const extPath = extCopy;
let edge = null;
// Edge honours --load-extension. Chrome 137+ ignores it, so the first launch loads the unpacked extension over the
// debugging protocol — standing in for the user's "Load unpacked" click. A later launch of the same profile relies on
// the browser remembering it, exactly as it does for a real user.
const startEdge = async (firstTime = false) => {
  edge = spawn(edgePath, ['--remote-debugging-port=9333', ...(wantEdge ? [] : ['--enable-unsafe-extension-debugging']), `--user-data-dir=${profile}`, ...(wantEdge ? [`--load-extension=${extPath}`, `--disable-extensions-except=${extPath}`, '--disable-features=DisableLoadExtensionCommandLineSwitch'] : []), '--no-first-run', '--no-default-browser-check', '--disable-sync', '--headless=new', 'about:blank'], { stdio: 'ignore' });
  if (!wantEdge && firstTime) {
    let version = null;
    for (let i = 0; i < 100 && version === null; i++) {
      try { version = await fetch('http://127.0.0.1:9333/json/version').then((x) => x.json()); } catch { await sleep(300); }
    }
    const bs = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r) => bs.addEventListener('open', r));
    const reply = await new Promise((resolve) => { bs.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id === 1) resolve(m); }); bs.send(JSON.stringify({ id: 1, method: 'Extensions.loadUnpacked', params: { path: extPath } })); });
    bs.close();
    if (!reply.result?.id) throw new Error('could not load the extension: ' + JSON.stringify(reply));
  }
};
const killEdge = () => {
  if (edge?.pid) try { execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  edge = null;
};

try {
  // 1. Before anything is connected, the default mode still works (Eya's own window) and says what it is.
  // (skipped here to avoid popping Eya's own visible window until the very end)

  // 2. connect_chrome: pairing window + help, while the extension's Edge starts and pairs by itself.
  const connecting = tool('connect_chrome');
  await sleep(1500);
  await startEdge(true);
  const conn = await connecting;
  check('connect_chrome pairs the browser', conn.ok === true && conn.data?.connected === true && Array.isArray(conn.data?.browsers) && conn.data.browsers.includes(expectedBrowser), conn);

  // What the user does on the extensions page: Developer mode ON (required to see "Load unpacked" at all).
  // Without it, Edge disables an unpacked extension at its next restart (measured separately).
  if (process.env.EYA_E2E_NO_DEVMODE !== '1') {
    const pt = (await fetch('http://127.0.0.1:9333/json').then((x) => x.json())).find((t) => t.type === 'page');
    const ps = new WebSocket(pt.webSocketDebuggerUrl);
    await new Promise((r) => ps.addEventListener('open', r));
    let pid = 1;
    const pcall = (method, params = {}) => new Promise((resolve) => {
      const id = pid++;
      const h = (e) => { const m = JSON.parse(e.data.toString()); if (m.id === id) { ps.removeEventListener('message', h); resolve(m); } };
      ps.addEventListener('message', h);
      ps.send(JSON.stringify({ id, method, params }));
    });
    await pcall('Page.enable');
    await pcall('Page.navigate', { url: extensionsUrl });
    await sleep(2500);
    const done = await pcall('Runtime.evaluate', { expression: `new Promise((res) => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true}, () => res('on')))`, awaitPromise: true, returnByValue: true });
    check('Developer mode switched on (as a user does)', done.result?.result?.value === 'on', done);
    ps.close();
  }

  // 3. open a site: it must land in the user's browser, not Eya's own window.
  let r = await tool('open_website', { url: `${base}/menu.html` });
  check('open_website goes to the user\'s own browser', r.ok && r.data?.environment === 'your_browser' && pageOf(r).title === 'Courts Portal', r);
  check('hidden menu is not predicted', !pageOf(r).links.includes('Cause List'), pageOf(r));

  // 4. discover the menu live through the real tools
  r = await tool('click_on_page', { text: 'Open menu' });
  check('click reports what appeared (menu expanded in place)', r.ok && r.data?.navigated === false && r.data?.stateChanged === true && JSON.stringify(r.data?.whatChanged ?? {}).includes('Services'), r.data);
  r = await tool('click_on_page', { text: 'Services' });
  r = await tool('click_on_page', { text: 'Cause List' });
  check('navigated to Cause List, table and text read', r.ok && r.data?.navigated === true && pageOf(r).title === 'Cause List' && pageOf(r).tables?.[0]?.rows?.[0]?.[2] === 'WP 101/2026', r.data);

  r = await tool('fill_on_page', { label: 'Advocate Code', value: 'ADV-5' });
  check('fill ok', r.ok === true, r);
  r = await tool('click_on_page', { text: 'Search' });
  check('result text visible after Search', (pageOf(r).visibleText ?? '').includes('Searched for ADV-5'), pageOf(r));

  // 5. go_back works even though every page was reached by script-made clicks
  r = await tool('go_back');
  check('go_back lands on the previous page', r.ok && pageOf(r).title === 'Courts Portal', r);

  // 6. sensitive click gate through the real tool layer
  await tool('open_website', { url: `${base}/forms.html` });
  r = await tool('click_on_page', { text: 'Place order' });
  check('Place order is NOT clicked; a permission request comes back', r.ok === false && r.summary === 'needs confirmation' && r.data?.status === 'permission_required' && r.data?.action === 'browser_sensitive_click', r);
  r = await tool('inspect_page');
  check('page shows nothing was bought', !(pageOf(r).visibleText ?? '').includes('Bought it'), pageOf(r).visibleText);
  r = await tool('click_on_page', { text: 'Place order', confirm: true });
  check('after a yes (confirm:true) it goes ahead', r.ok && (pageOf(r).visibleText ?? '').includes('Bought it'), r);
  r = await tool('fill_on_page', { label: 'Account password', value: 'hunter2' });
  check('password field: refused, user must type it', r.ok === false && r.summary === 'needs you' && !JSON.stringify(r).includes('hunter2'), r);
  r = await tool('fill_on_page', { label: 'Case number', value: 'WP 3/2026', submit: true });
  check('fill + Enter submits a search-like form', r.ok && (pageOf(r).visibleText ?? '').includes('Submitted: WP 3/2026'), r);

  // 7. CAPTCHA: stop, ask the user
  r = await tool('open_website', { url: `${base}/captcha.html` });
  check('CAPTCHA page: ok:false, needsUser, will not proceed', r.ok === false && r.data?.needsUser === true && r.data?.challengeKind === 'captcha', r);
  r = await tool('click_on_page', { text: 'Continue' });
  check('click on a CAPTCHA page is refused', r.ok === false && r.data?.needsUser === true, r);

  // 8. download: verified on disk and exposed as data.path
  await tool('open_website', { url: `${base}/download.html` });
  r = await tool('click_on_page', { text: 'Download report' });
  const dlPath = r.data?.path;
  check('download verified on disk, data.path set', r.ok && typeof dlPath === 'string' && existsSync(dlPath) && readFileSync(dlPath, 'utf8') === 'eya test download\n' && r.data?.download?.verified === true, r);

  // 9. tabs
  r = await tool('list_browser_tabs');
  check('list_browser_tabs sees tabs by id/title/url', r.ok && Array.isArray(r.data?.tabs) && r.data.tabs.length >= 1 && r.data.tabs.every((t) => typeof t.tabId === 'number'), r);
  const other = r.data.tabs.find((t) => !t.eyaIsHere);
  if (other) {
    const s = await tool('switch_browser_tab', { tab_id: other.tabId });
    check('switch_browser_tab works (even on an internal page, without crashing)', s.ok === true, s);
  }

  // 10. the browser goes away mid-task: stop honestly, do NOT swap to another browser behind the user's back
  await tool('open_website', { url: `${base}/menu.html` });
  const eyaWindowsBefore = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -match 'browser-profile' } | Measure-Object).Count`]).toString().trim();
  killEdge();
  await sleep(1500);
  r = await tool('inspect_page');
  check('lost browser: honest "browser not connected", no silent swap', r.ok === false && r.summary === 'browser not connected' && /different browser/.test(r.error ?? ''), r);
  r = await tool('click_on_page', { text: 'Open menu' });
  check('lost browser: clicks stop too', r.ok === false && r.summary === 'browser not connected', r);
  const eyaWindowsAfter = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -match 'browser-profile' } | Measure-Object).Count`]).toString().trim();
  check('no Eya-own browser window was launched as a substitute', eyaWindowsAfter === eyaWindowsBefore, { eyaWindowsBefore, eyaWindowsAfter });

  // 11. it comes back by itself (stored secret) and the task carries on
  // Chrome forgets an extension that was loaded over the debugging protocol when it closes (a real "Load unpacked" click
  // is remembered), so for Chrome it is loaded again here. What this step proves is Eya's side: the browser comes back
  // with the same profile and the stored pairing secret, and reconnects WITHOUT a new pairing.
  await startEdge(!wantEdge);
  const restartedAt = Date.now();
  // Attach to the extension's service worker as soon as it appears, to read what it says about connecting.
  const swLogs = [];
  (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const list = await fetch('http://127.0.0.1:9333/json').then((x) => x.json());
        const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('edokidnlajcpopeadgnnmhomhhoaomhm'));
        if (sw) {
          const sws = new WebSocket(sw.webSocketDebuggerUrl);
          sws.addEventListener('message', (e) => {
            const m = JSON.parse(e.data.toString());
            if (m.method === 'Runtime.consoleAPICalled') swLogs.push(`+${Math.round((Date.now() - restartedAt) / 1000)}s ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
            if (m.method === 'Runtime.exceptionThrown') swLogs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
          });
          await new Promise((r) => sws.addEventListener('open', r));
          sws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
          return;
        }
      } catch {}
      await sleep(300);
    }
  })();
  let back = null;
  for (let i = 0; i < 90 && back === null; i++) {
    await sleep(1000);
    const t = await tool('list_browser_tabs');
    if (t.ok) back = t;
  }
  console.log(`   (reconnect took ${back ? Math.round((Date.now() - restartedAt) / 1000) + 's' : 'never, waited 90s'})`);
  console.log('   extension console after restart:', swLogs);
  if (back === null) {
    const procs = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${exeName}'" | Where-Object { $_.CommandLine -match 'eya-e2e-edge' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { "$($_.ProcessId) parent=$($_.ParentProcessId) " + $_.CommandLine.Substring(0, [Math]::Min(420, $_.CommandLine.Length)) }`]).toString();
    console.log('   test-profile browser processes (main only), spawned pid =', edge?.pid, '\n' + procs);
    try {
      const ver = await fetch('http://127.0.0.1:9333/json/version').then((x) => x.json());
      const bs = new WebSocket(ver.webSocketDebuggerUrl);
      await new Promise((r) => bs.addEventListener('open', r));
      const all = await new Promise((resolve) => {
        bs.addEventListener('message', (e) => { const m = JSON.parse(e.data.toString()); if (m.id === 1) resolve(m.result.targetInfos); });
        bs.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
      });
      console.log('   ALL browser targets:', all.map((t) => `${t.type}:${t.url.slice(0, 80)}`));
      bs.close();
      // Ask the browser's own extensions page what it thinks of the extension.
      const pageT = (await fetch('http://127.0.0.1:9333/json').then((x) => x.json())).find((t) => t.type === 'page');
      const ps = new WebSocket(pageT.webSocketDebuggerUrl);
      await new Promise((r) => ps.addEventListener('open', r));
      let pid = 1;
      const pcall = (method, params = {}) => new Promise((resolve) => {
        const id = pid++;
        const h = (e) => { const m = JSON.parse(e.data.toString()); if (m.id === id) { ps.removeEventListener('message', h); resolve(m); } };
        ps.addEventListener('message', h);
        ps.send(JSON.stringify({ id, method, params }));
      });
      await pcall('Page.enable');
      await pcall('Page.navigate', { url: extensionsUrl });
      await sleep(3000);
      const info = await pcall('Runtime.evaluate', {
        expression: `new Promise((res) => { try { chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true}, (l) => res(JSON.stringify(l.map(e => ({name:e.name,id:e.id,state:e.state,disableReasons:e.disableReasons,location:e.location,manifestErrors:e.manifestErrors,runtimeErrors:(e.runtimeErrors||[]).map(x=>x.message).slice(0,5),installWarnings:e.installWarnings,path:e.prettifiedPath}))))); } catch (err) { res('no developerPrivate: ' + err); } })`,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log('   edge://extensions says:', info.result?.result?.value ?? JSON.stringify(info).slice(0, 400));
      ps.close();
    } catch (err) { console.log('   target dump failed', String(err)); }
    // Diagnose: is the new Edge alive, is the extension's service worker running, what did it log?
    try {
      const list = await fetch('http://127.0.0.1:9333/json').then((x) => x.json());
      console.log('   edge targets:', list.map((t) => `${t.type}:${t.url.slice(0, 70)}`));
      const sw = list.find((t) => t.type === 'service_worker');
      if (sw) {
        const sws = new WebSocket(sw.webSocketDebuggerUrl);
        const logs = [];
        sws.addEventListener('message', (e) => {
          const m = JSON.parse(e.data.toString());
          if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
          if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
        });
        await new Promise((r) => sws.addEventListener('open', r));
        sws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        await sleep(1500);
        console.log('   service worker console:', logs);
        sws.close();
      } else console.log('   no service worker target found');
    } catch (err) {
      console.log('   diagnosis failed:', String(err));
    }
  }
  check('browser reconnects by itself with the stored secret', back !== null, null);
  r = await tool('open_website', { url: `${base}/orders.html` });
  check('and works again afterwards', r.ok && pageOf(r).title === 'Orders' && r.data?.environment === 'your_browser', r);
} finally {
  killEdge();
  site.server.close();
  ws.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  rmSync(extCopy, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nE2E ALL PASSED' : `\nE2E ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
