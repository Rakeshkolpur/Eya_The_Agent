import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rootLogger } from '@main/logging/logger';

const log = rootLogger.child('chrome.bootstrap');

/** The file the extension reads (its own copy of this name is in bridge.js). It is not listed as a web-accessible resource, so no page can fetch it. */
export const BOOTSTRAP_FILE = 'eya-pairing.json';

/**
 * Leaves the pairing key in the extension's own folder, so an extension that has just been loaded can pair by itself instead of waiting
 * for the user to say "connect my browser". Whoever can read that folder (the user's own account) has the key; web pages and other
 * extensions cannot. Returns whether the file now holds the key; false when the folder cannot be written (a read-only install), in which
 * case the pairing window the user opens is still how it is done.
 */
export function publishBootstrap(folder: string, token: string): boolean {
  const path = join(folder, BOOTSTRAP_FILE);
  const content = `${JSON.stringify({ token })}\n`;
  try {
    try {
      if (readFileSync(path, 'utf8') === content) return true;
    } catch {
      // not there yet
    }
    writeFileSync(path, content, 'utf8');
    log.info('placed the pairing key in the extension folder');
    return true;
  } catch (err) {
    log.warn('could not place the pairing key in the extension folder; pairing needs the window the user opens', { err: String(err) });
    return false;
  }
}
