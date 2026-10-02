import { describe, it, expect } from 'vitest';
import { createBrowserTools } from '../src/main/tools/impl/browserTools';
import { LoopGuard } from '../src/main/browser/loopGuard';
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

function toolMap(service: BrowserAutomationService, guard?: LoopGuard): Record<string, Tool> {
  return Object.fromEntries(createBrowserTools(service, guard).map((t) => [t.schema.name, t]));
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

  it('reports stateChanged false and navigated false for a click that left the page exactly as it was', async () => {
    const same = snap({ url: 'https://tshc.gov.in', title: 'High Court for the State of Telangana' });
    const f = fakeService({ hasPage: true, inspectSnapshot: same, clickResult: { ok: true, snapshot: same } });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Cause List' });
    expect(result.data?.['stateChanged']).toBe(false);
    expect(result.data?.['navigated']).toBe(false);
  });

  it('tells a menu that expanded in place (same address and title) apart from a real navigation', async () => {
    const before = snap({ links: ['Home', 'Open Source'] });
    const after = snap({ links: ['Home', 'Open Source', 'Trending', 'Topics'] });
    const f = fakeService({ hasPage: true, inspectSnapshot: before, clickResult: { ok: true, snapshot: after } });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Open Source' });
    expect(result.data?.['stateChanged']).toBe(true);
    expect(result.data?.['navigated']).toBe(false);
  });

  it('flags a real navigation as navigated', async () => {
    const f = fakeService({
      hasPage: true,
      inspectSnapshot: snap({ url: 'https://example.com/a' }),
      clickResult: { ok: true, snapshot: snap({ url: 'https://example.com/b' }) },
    });
    const result = await toolMap(f.service)['click_on_page']!.execute({ text: 'Next' });
    expect(result.data?.['navigated']).toBe(true);
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

describe('loop protection', () => {
  const stuck = snap({ links: ['Home', 'Refresh'] });

  it('lets a click be tried twice from the same page, then refuses the third without clicking', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: { ok: true, snapshot: stuck } });
    const tools = toolMap(f.service, new LoopGuard());
    expect((await tools['click_on_page']!.execute({ text: 'Refresh' })).ok).toBe(true);
    expect((await tools['click_on_page']!.execute({ text: 'Refresh' })).ok).toBe(true);
    const third = await tools['click_on_page']!.execute({ text: 'Refresh' });
    expect(third.ok).toBe(false);
    expect(third.summary).toBe('repeating itself');
    expect(third.data?.['loopDetected']).toBe(true);
    expect(f.clicked).toEqual(['Refresh', 'Refresh']); // the third never reached the browser
  });

  it('hands back the live page with the refusal, so the model can choose something different', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: { ok: true, snapshot: stuck } });
    const tools = toolMap(f.service, new LoopGuard());
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    const blocked = await tools['click_on_page']!.execute({ text: 'Refresh' });
    expect(currentPage(blocked)['links']).toEqual(['Home', 'Refresh']);
    expect(blocked.error).toMatch(/genuinely different/);
  });

  it('keeps refusing it however many more times it is tried', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: { ok: true, snapshot: stuck } });
    const tools = toolMap(f.service, new LoopGuard());
    for (let i = 0; i < 6; i += 1) await tools['click_on_page']!.execute({ text: 'Refresh' });
    expect(f.clicked).toHaveLength(2);
  });

  it('does not block clicking something else from the same page', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: { ok: true, snapshot: stuck } });
    const tools = toolMap(f.service, new LoopGuard());
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    expect((await tools['click_on_page']!.execute({ text: 'Home' })).ok).toBe(true);
  });

  it('does not block repeating a click when the page is different each time (e.g. paging with Next)', async () => {
    let page = 0;
    const service: BrowserAutomationService = {
      openWebsite: async () => snap(),
      inspectPage: async () => snap({ headings: [`Page ${page}`] }),
      clickOnPage: async () => {
        page += 1;
        return { ok: true, snapshot: snap({ headings: [`Page ${page}`] }) };
      },
      fillOnPage: async () => ({ ok: true, snapshot: snap() }),
      close: async () => undefined,
    };
    const tools = toolMap(service, new LoopGuard());
    for (let i = 0; i < 6; i += 1) expect((await tools['click_on_page']!.execute({ text: 'Next' })).ok).toBe(true);
  });

  it('counts a click that found nothing as an attempt too, so searching the same missing text forever stops', async () => {
    const missing: ActOnPageResult = { ok: false, reason: 'not_found', snapshot: stuck };
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: missing });
    const tools = toolMap(f.service, new LoopGuard());
    await tools['click_on_page']!.execute({ text: 'Cause List' });
    await tools['click_on_page']!.execute({ text: 'Cause List' });
    const third = await tools['click_on_page']!.execute({ text: 'Cause List' });
    expect(third.summary).toBe('repeating itself');
  });

  it('treats a fill with a different value as a new attempt, and the same value three times as a loop', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck });
    const tools = toolMap(f.service, new LoopGuard());
    for (const value of ['1', '2', '3', '4']) {
      expect((await tools['fill_on_page']!.execute({ label: 'Code', value })).ok).toBe(true);
    }
    await tools['fill_on_page']!.execute({ label: 'Code', value: '9' });
    await tools['fill_on_page']!.execute({ label: 'Code', value: '9' });
    const third = await tools['fill_on_page']!.execute({ label: 'Code', value: '9' });
    expect(third.summary).toBe('repeating itself');
    expect(third.data?.['loopDetected']).toBe(true);
  });

  it('lets the same click be tried again once enough time has passed', async () => {
    let now = 5_000_000;
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck, clickResult: { ok: true, snapshot: stuck } });
    const tools = toolMap(f.service, new LoopGuard(() => now));
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    await tools['click_on_page']!.execute({ text: 'Refresh' });
    expect((await tools['click_on_page']!.execute({ text: 'Refresh' })).summary).toBe('repeating itself');
    now += 130_000;
    expect((await tools['click_on_page']!.execute({ text: 'Refresh' })).ok).toBe(true);
  });

  it('never blocks opening a website or looking at the page', async () => {
    const f = fakeService({ hasPage: true, inspectSnapshot: stuck });
    const tools = toolMap(f.service, new LoopGuard());
    for (let i = 0; i < 5; i += 1) {
      expect((await tools['inspect_page']!.execute({})).ok).toBe(true);
      expect((await tools['open_website']!.execute({ url: 'https://example.com' })).ok).toBe(true);
    }
  });
});
