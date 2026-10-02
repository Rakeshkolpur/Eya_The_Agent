import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EYA_EXTENSION_ID, EXTENSION_ORIGIN, BRIDGE_PORT, BRIDGE_PATH } from '../src/main/chrome/protocol';

const root = join(process.cwd(), 'eya-chrome-extension');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>;

/** The id Chrome/Edge derive from a manifest "key": first 16 bytes of SHA-256(SPKI), each nibble mapped to a-p. */
function extensionIdFromKey(base64Key: string): string {
  const hash = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest().subarray(0, 16);
  return Array.from(hash)
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

describe('the browser extension manifest', () => {
  it('derives exactly the extension id the desktop side insists on (they cannot drift apart)', () => {
    expect(extensionIdFromKey(manifest['key'] as string)).toBe(EYA_EXTENSION_ID);
    expect(EXTENSION_ORIGIN).toBe(`chrome-extension://${EYA_EXTENSION_ID}`);
  });

  it('asks for exactly the permissions the feature needs — and nothing that reads credentials', () => {
    expect([...(manifest['permissions'] as string[])].sort()).toEqual(['alarms', 'downloads', 'scripting', 'storage', 'tabs']);
    for (const dangerous of ['cookies', 'webRequest', 'webRequestBlocking', 'history', 'bookmarks', 'debugger', 'nativeMessaging', 'identity', 'clipboardRead', 'management', 'proxy', 'declarativeNetRequest']) {
      expect(manifest['permissions']).not.toContain(dangerous);
    }
    expect(manifest['host_permissions']).toEqual(['<all_urls>']);
  });

  it('is a Manifest V3 extension with a module service worker, and no content scripts running on every page', () => {
    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['background']).toEqual({ service_worker: 'service-worker.js', type: 'module' });
    expect(manifest['content_scripts']).toBeUndefined();
    expect(manifest['web_accessible_resources']).toBeUndefined();
  });

  it('ships every file it references', () => {
    for (const rel of ['service-worker.js', 'bridge.js', 'tabs.js', 'actions.js', 'injected.js', 'options/options.html', 'options/options.js']) {
      expect(existsSync(join(root, rel)), rel).toBe(true);
    }
    expect(existsSync(join(root, manifest['options_page'] as string))).toBe(true);
  });

  it('only ever dials the loopback address and port the desktop side listens on', () => {
    const bridgeSource = readFileSync(join(root, 'bridge.js'), 'utf8');
    expect(bridgeSource).toContain(`ws://127.0.0.1:${BRIDGE_PORT}${BRIDGE_PATH}`);
    for (const file of ['service-worker.js', 'bridge.js', 'tabs.js', 'actions.js', 'injected.js', 'options/options.js']) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).not.toMatch(/fetch\(\s*['"`]https?:/);
      expect(source, file).not.toMatch(/XMLHttpRequest/);
      expect(source, file).not.toMatch(/chrome\.cookies/);
    }
  });

  it('the page script has no module-level dependencies (it is serialised into the page as source text)', () => {
    const source = readFileSync(join(root, 'injected.js'), 'utf8');
    expect(source).not.toMatch(/^import\s/m);
  });
});
