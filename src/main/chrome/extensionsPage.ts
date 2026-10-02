import { pickRunningBrowser } from '@main/tools/impl/openApplication';
import type { BrowserName } from '@main/windowsApi/appPaths';

export interface ExtensionsPageDeps {
  listRunningProcessNames(): Promise<string[]>;
  launchBrowser(browser: BrowserName, url: string): Promise<boolean>;
}

const EXTENSIONS_URL: Partial<Record<BrowserName, string>> = {
  edge: 'edge://extensions/',
  chrome: 'chrome://extensions/',
};

/**
 * Opens the extensions page of the browser the user actually has open (the
 * Eya Browser Bridge only exists for Chromium browsers), else Chrome, else Edge.
 * Throws when neither is installed.
 */
export async function openExtensionsPage(deps: ExtensionsPageDeps): Promise<BrowserName> {
  const running = pickRunningBrowser(await deps.listRunningProcessNames());
  // Chrome before Edge when nothing says which one is in use: it is the browser the user chose to install for this.
  const order: BrowserName[] = [...(running !== null && EXTENSIONS_URL[running] !== undefined ? [running] : []), 'chrome', 'edge'];
  for (const browser of [...new Set(order)]) {
    const url = EXTENSIONS_URL[browser];
    if (url !== undefined && (await deps.launchBrowser(browser, url))) return browser;
  }
  throw new Error('Neither Edge nor Chrome could be found to open the extensions page.');
}
