import { describe, it, expect } from 'vitest';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import type { ActOnPageResult, BrowserAutomationService } from '../src/main/browser/BrowserAutomationService';
import type { PageSnapshot } from '../src/main/browser/pageSnapshot';
import type { Tool } from '../src/main/tools/types';

function snap(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://tshc.gov.in',
    title: 'High Court for the State of Telangana',
    headings: ['High Court for the State of Telangana'],
    links: ['Home', 'Cause List', 'Case Status'],
    buttons: [],
    inputs: [],
    dialogs: [],
    truncated: false,
    ...overrides,
  };
}

interface Fake {
  service: BrowserAutomationService;
  opened: string[];
  clicked: string[];
  filled: Array<{ label: string; value: string }>;
}

function fakeService(options: {
  hasPage?: boolean;
  clickResult?: ActOnPageResult;
  fillResult?: ActOnPageResult;
  openError?: Error;
  inspectSnapshot?: PageSnapshot;
} = {}): Fake {
  const opened: string[] = [];
  const clicked: string[] = [];
  const filled: Array<{ label: string; value: string }> = [];
  let hasPage = options.hasPage ?? false;
  const service: BrowserAutomationService = {
    openWebsite: async (url) => {
      if (options.openError !== undefined) throw options.openError;
      opened.push(url);
      hasPage = true;
      return snap({ url });
    },
    inspectPage: async () => {
      if (!hasPage) throw new Error('no website is open yet');
      return options.inspectSnapshot ?? snap();
    },
    clickOnPage: async (text) => {
      clicked.push(text);
      return options.clickResult ?? { ok: true, snapshot: snap() };
    },
    fillOnPage: async (label, value) => {
      filled.push({ label, value });
      return options.fillResult ?? { ok: true, snapshot: snap() };
    },
    close: async () => undefined,
  };
  return { service, opened, clicked, filled };
}

function toolMap(service: BrowserAutomationService): Record<string, Tool> {
  return Object.fromEntries(createBrowserTools(service).map((t) => [t.schema.name, t]));
}

function currentPage(result: { data?: Record<string, unknown> }): Record<string, unknown> {
  return result.data?.['currentPage'] as Record<string, unknown>;
}

describe('open_website', () => {
  it('opens a valid https url and reports the page title and a fresh observation', async () => {
    const f = fakeService();
    const result = await toolMap(f.service)['open_website']!.execute({ url: 'https://tshc.gov.in' });
    expect(result.ok).toBe(true);
    expect(f.opened).toEqual(['https://tshc.gov.in/']);
    expect(currentPage(result)['title']).toBe('High Court for the State of Telangana');
    expect(result.data?.['action']).toBe('open');
    expect(result.data?.['stateChanged']).toBe(true);
  });

  it('refuses a non-http(s) address rather than passing it through', async () => {
    const f = fakeService();
    const result = await toolMap(f.service)['open_website']!.execute({ url: 'javascript:alert(1)' });
    expect(result.ok).toBe(false);
    expect(f.opened).toEqual([]);
  });

  it('reports a navigation failure cleanly', async () => {
    const f = fakeService({ openError: new Error('net::ERR_NAME_NOT_RESOLVED') });
    const result = await toolMap(f.service)['open_website']!.execute({ url: 'https://no-such-site.example' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ERR_NAME_NOT_RESOLVED/);
  });
});

describe('inspect_page', () => {
  it('returns the current page snapshot, never a stale or assumed one', async () => {
    const f = fakeService({ hasPage: true });
    const result = await toolMap(f.service)['inspect_page']!.execute({});
    expect(result.ok).toBe(true);
    expect(currentPage(result)['links']).toEqual(['Home', 'Cause List', 'Case Status']);
    expect(result.data?.['action']).toBe('inspect');
    expect(result.data?.['stateChanged']).toBe(false);
  });

  it('says plainly when nothing is open yet', async () => {
    const f = fakeService({ hasPage: false });
    const result = await toolMap(f.service)['inspect_page']!.execute({});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('no page open');
  });
});

describe('click_on_page', () => {
  it('clicks the requested visible text and returns the resulting page, flagged as changed', async () => {
    const f = fakeService({
      hasPage: true,
      inspectSnapshot: snap({ url: 'https://tshc.gov.in', title: 'High Court for the State of Telangana' }),
      clickResult: { ok: true, snapshot: snap({ url: 'https://tshc.gov.in/causelist', title: 'Cause List' }) },
    });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Cause List' });
    expect(result.ok).toBe(true);
    expect(f.clicked).toEqual(['Cause List']);
    expect(currentPage(result)['title']).toBe('Cause List');
    expect(result.data?.['action']).toBe('click');
    expect(result.data?.['target']).toBe('Cause List');
    expect(result.data?.['stateChanged']).toBe(true);
  });

  it('reports stateChanged false for a click that did not navigate anywhere (e.g. a menu toggle)', async () => {
    const same = snap({ url: 'https://tshc.gov.in', title: 'High Court for the State of Telangana' });
    const f = fakeService({ hasPage: true, inspectSnapshot: same, clickResult: { ok: true, snapshot: same } });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Cause List' });
    expect(result.data?.['stateChanged']).toBe(false);
  });

  it('never invents a URL or falls back to search when nothing matches — it reports what IS on the page', async () => {
    const f = fakeService({
      clickResult: { ok: false, reason: 'not_found', snapshot: snap({ links: ['Home', 'Contact Us'] }) },
    });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Cause List' });
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('not found');
    expect(currentPage(result)['links']).toEqual(['Home', 'Contact Us']);
  });

  it('surfaces a dialog/popup that appeared, in the current page observation', async () => {
    const f = fakeService({
      clickResult: {
        ok: true,
        snapshot: snap({ dialogs: ['(a browser popup appeared and was dismissed: "Are you sure?")'] }),
      },
    });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Submit' });
    expect(currentPage(result)['dialogs']).toEqual(['(a browser popup appeared and was dismissed: "Are you sure?")']);
  });

  it('requires text to click', async () => {
    const f = fakeService();
    expect((await toolMap(f.service)['click_on_page']!.execute({})).ok).toBe(false);
    expect(f.clicked).toEqual([]);
  });
});

describe('fill_on_page', () => {
  it('fills the requested field', async () => {
    const f = fakeService();
    const result = await toolMap(f.service)['fill_on_page']!.execute({ label: 'Advocate Code', value: '21295' });
    expect(result.ok).toBe(true);
    expect(f.filled).toEqual([{ label: 'Advocate Code', value: '21295' }]);
    expect(result.data?.['action']).toBe('fill');
    expect(result.data?.['target']).toBe('Advocate Code');
  });

  it('reports what fields actually exist when the label does not match', async () => {
    const f = fakeService({
      fillResult: { ok: false, reason: 'not_found', snapshot: snap({ inputs: ['Case Number', 'Year'] }) },
    });
    const result = await toolMap(f.service)['fill_on_page']!.execute({ label: 'Advocate Code', value: '21295' });
    expect(result.ok).toBe(false);
    expect(currentPage(result)['inputs']).toEqual(['Case Number', 'Year']);
  });

  it('requires both a label and a value', async () => {
    const f = fakeService();
    expect((await toolMap(f.service)['fill_on_page']!.execute({ label: 'Advocate Code' })).ok).toBe(false);
    expect((await toolMap(f.service)['fill_on_page']!.execute({ value: '21295' })).ok).toBe(false);
    expect(f.filled).toEqual([]);
  });
});
