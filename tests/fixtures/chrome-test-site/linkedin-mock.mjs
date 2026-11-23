// A LinkedIn-SHAPED page, served over HTTPS so a browser can be told that www.linkedin.com is this server (host-resolver-rules + ignore-certificate-errors). It behaves the way the real
// one did in the user's run of 23 Nov 2026: the address ?shareActive=true opens the "Create a post" box BY ITSELF and the box covers the feed's "Start a post" button (so clicking it fails with
// "something else is covering it"); the box's editor is a contenteditable called "Text editor for creating content"; the file picker only exists after "Add media" is pressed.
// NOT the real LinkedIn: its labels here are what the real page showed in the log and the screen description, not a copy of its markup.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Feed | LinkedIn</title></head><body>
<header><nav aria-label="Primary"><a href="/feed/">Home</a> <a href="/jobs/">Jobs</a></nav></header>
<main>
  <h1>Feed</h1>
  <button id="start">Start a post</button>
  <div id="overlay" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:50"></div>
  <div id="modal" role="dialog" aria-label="Create a post" hidden style="position:fixed;top:60px;left:100px;width:600px;background:#fff;z-index:60;padding:12px">
    <h2>Create a post</h2>
    <div id="editor" role="textbox" aria-label="Text editor for creating content" contenteditable="true" data-placeholder="What do you want to talk about?" style="min-height:60px;border:1px solid #999"></div>
    <button id="media" type="button" aria-label="Add media">Add media</button>
    <div id="preview"></div>
    <button id="post" type="button" disabled>Post</button>
    <button id="close" type="button">Close the box</button>
  </div>
  <section id="feed"></section>
  <article id="theirs"><h3>Priya Sharma</h3><p>Tenants should always ask for a written receipt.</p>
    <div id="cbox" role="textbox" aria-label="Add a comment…" contenteditable="true" style="min-height:30px;border:1px solid #999"></div>
    <button id="comment" type="button">Comment</button>
    <div id="comments"></div>
  </article>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let imageName = '';
  const send = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body) });
  const openBox = () => { $('modal').hidden = false; $('overlay').hidden = false; };
  const closeBox = () => { $('modal').hidden = true; $('overlay').hidden = true; };
  $('start').onclick = openBox;
  $('close').onclick = closeBox;
  if (location.search.includes('shareActive=true')) openBox();
  const state = () => send('/__state', { editor: $('editor').innerText, image: imageName });
  $('editor').oninput = () => { $('post').disabled = $('editor').innerText.trim() === ''; state(); };
  $('media').onclick = () => {
    if (document.getElementById('file')) return;
    const f = document.createElement('input'); f.type = 'file'; f.id = 'file'; f.accept = 'image/*'; f.style.display = 'none';
    f.onchange = () => { imageName = f.files[0] ? f.files[0].name : ''; $('preview').textContent = imageName ? 'Picture: ' + imageName : ''; state(); };
    $('modal').appendChild(f);
  };
  $('post').onclick = () => {
    const text = $('editor').innerText.trim();
    send('/__posted', { kind: 'post', text, image: imageName });
    const a = document.createElement('article'); a.textContent = text; $('feed').prepend(a);
    $('editor').innerText = ''; closeBox(); $('post').disabled = true;
  };
  $('comment').onclick = () => {
    const text = $('cbox').innerText.trim();
    if (text === '') { $('cbox').focus(); return; }
    send('/__posted', { kind: 'comment', text, image: '' });
    const c = document.createElement('div'); c.textContent = text; $('comments').appendChild(c); $('cbox').innerText = '';
  };
</script></body></html>`;

/** Starts the mock on a random local port. `posted` is everything the page "published"; `page()` is what it last reported about its box; `opens` every address asked of the server. */
export async function startLinkedInMock() {
  const certDir = mkdtempSync(join(tmpdir(), 'eya-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'), '-out', join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=www.linkedin.com'], { stdio: 'ignore' });
  const posted = [];
  const opens = [];
  let pageState = { editor: '', image: '' };
  const server = https.createServer({ key: readFileSync(join(certDir, 'k.pem')), cert: readFileSync(join(certDir, 'c.pem')) }, (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        if (req.url === '/__state') pageState = parsed;
        else if (req.url === '/__posted') posted.push(parsed);
        res.end('ok');
      });
      return;
    }
    if (req.url !== '/favicon.ico') opens.push(req.url);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, posted, opens, page: () => pageState, close: () => server.close() };
}
