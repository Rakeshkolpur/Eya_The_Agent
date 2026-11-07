// A tiny local site with deliberately different page structures, used to test
// Eya's browser agent against pages it was never written for. No dependencies.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPortal } from './portal.mjs';
import { handleAuth } from './auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain' };

export function startTestSite(port = 0) {
  // for the "r/" pages that behave differently the first time (a site with a hiccup)
  const hits = { flaky: 0, slowOnce: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/r/')) {
      const page = (body, status = 200) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>${body.title}</title></head><body>${body.html}</body></html>`);
      };
      switch (url.pathname) {
        case '/r/redirect':
          res.writeHead(302, { location: url.searchParams.get('to') ?? '/' });
          return res.end();
        case '/r/chain':
          res.writeHead(302, { location: '/r/redirect?to=/r/landing' });
          return res.end();
        case '/r/landing':
          return page({ title: 'Landing', html: '<h1>You landed here</h1><a href="/index.html">Home</a>' });
        case '/r/loop':
          res.writeHead(302, { location: '/r/loop' });
          return res.end();
        case '/r/status':
          return page({ title: 'Status', html: '<h1>Status page</h1><p>Not what you wanted.</p>' }, Number(url.searchParams.get('code') ?? 500));
        case '/r/flaky': // the first visit fails, the next works
          hits.flaky += 1;
          return hits.flaky === 1 ? page({ title: 'Error', html: '<h1>503</h1>' }, 503) : page({ title: 'Recovered', html: '<h1>It works now</h1><a href="/index.html">Home</a>' });
        case '/r/slow-once': // the first visit hangs, the next is quick
          hits.slowOnce += 1;
          if (hits.slowOnce === 1) return setTimeout(() => page({ title: 'Late', html: '<h1>Too late</h1>' }), 6000);
          return page({ title: 'Quick now', html: '<h1>Quick now</h1><a href="/index.html">Home</a>' });
        case '/r/hang':
          return undefined; // never answers
        case '/r/dynamic': // blank at first, filled in by a script
          return page({ title: 'Dynamic', html: '<div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = "<h1>Records</h1><a href=\\"/index.html\\">First record</a><button>Download list</button>"; }, 1500);</script>' });
        case '/r/numeric':
          return page({ title: 'Registration', html: '<h1>Registration</h1><form onsubmit="event.preventDefault(); document.getElementById(\'out\').textContent = \'Saved age \' + document.getElementById(\'age\').value + \' ref \' + document.getElementById(\'ref\').value;"><label>Age <input id="age" name="age" type="number" aria-label="Age"></label><label>Reference number <input id="ref" name="ref" type="text" inputmode="numeric" aria-label="Reference number"></label><button type="submit">Save</button></form><p id="out"></p>' });
        case '/r/portal': // a page that has no "Reports" anywhere
          return page({ title: 'Portal home', html: '<h1>Citizen portal</h1><nav><a href="/r/landing">Notices</a> <a href="/r/status?code=200">Services</a></nav><button>Help</button>' });
        default:
          return page({ title: 'Not found', html: '<h1>404</h1>' }, 404);
      }
    }
    if (url.pathname === '/report.txt') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="eya-test-report.txt"' });
      res.end('eya test download\n');
      return;
    }
    if (url.pathname === '/api/delayed') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: ['Alpha order', 'Beta order', 'Gamma order'] }));
      }, 900);
      return;
    }
    if (handleAuth(req, res, url)) return;
    const portal = renderPortal(url.pathname);
    if (portal !== null) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(portal);
      return;
    }
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    try {
      const body = await readFile(join(here, file));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><head><title>Not found</title></head><body><h1>404</h1><p>No such page.</p></body></html>');
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : port });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { port } = await startTestSite(Number(process.argv[2] ?? 47900));
  console.log(`test site on http://127.0.0.1:${port}/`);
}
