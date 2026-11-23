import type { ToolResult } from '@main/tools/types';

/** A page as the browser tools report it (the `currentPage` of a result), read by the shop and checkout runners. */
export interface Page {
  readonly title: string;
  readonly headings: string[];
  readonly links: string[];
  readonly buttons: string[];
  readonly inputs: string[];
  readonly signedIn: string;
  readonly raw: Record<string, unknown>;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function pageOf(r: ToolResult): Page | null {
  const cp = r.data?.['currentPage'];
  if (typeof cp !== 'object' || cp === null) return null;
  const c = cp as Record<string, unknown>;
  return {
    title: typeof c['title'] === 'string' ? c['title'] : '',
    headings: strings(c['headings']),
    links: strings(c['links']),
    buttons: strings(c['buttons']),
    inputs: strings(c['inputs']),
    signedIn: typeof c['signedIn'] === 'string' ? c['signedIn'] : '',
    raw: c,
  };
}

/** A control's own name: the text before the "— near …" the page lists add to tell same-named buttons apart. */
export const own = (s: string): string => s.split(' — near ')[0]?.trim() ?? s;
export const controls = (p: Page): string[] => [...p.buttons, ...p.links].map(own);
