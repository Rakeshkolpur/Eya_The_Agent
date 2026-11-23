export const PAGE: string;
export interface LinkedInMock {
  readonly server: import('node:https').Server;
  readonly port: number;
  /** Everything the page "published": posts and comments. */
  readonly posted: Array<{ kind: string; text: string; image: string }>;
  /** Every address asked of the server (a page load). */
  readonly opens: string[];
  /** What the page last reported about its post box. */
  page(): { editor: string; image: string };
  close(): void;
}
export function startLinkedInMock(): Promise<LinkedInMock>;
