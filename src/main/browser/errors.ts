/**
 * The browser Eya was told to use is not reachable. Distinct from "the page
 * did not have that button": this one means stop and tell the user, never
 * quietly carry on in some other browser.
 */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}
