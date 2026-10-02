/**
 * The browser Eya was told to use is not reachable. Distinct from "the page
 * did not have that button": this one means stop and tell the user, never
 * quietly carry on in some other browser.
 */
export interface BrowserUnavailableDetail {
  /** Browsers whose extension is running and wants to connect, but has not been paired with Eya yet. */
  readonly needsPairing?: readonly ('chrome' | 'edge' | 'other')[];
  /**
   * Why, in one machine-readable word: not_connected | needs_pairing | needs_reload | no_browser | no_extension | lost_connection.
   * needs_reload: the extension is installed and running but is an older version than this Eya speaks; reloading it fixes it.
   */
  readonly why?: string;
}

export class BrowserUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail: BrowserUnavailableDetail = {},
  ) {
    super(message);
    this.name = 'BrowserUnavailableError';
  }
}
