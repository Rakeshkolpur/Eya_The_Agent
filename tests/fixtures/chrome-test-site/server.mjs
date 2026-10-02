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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
