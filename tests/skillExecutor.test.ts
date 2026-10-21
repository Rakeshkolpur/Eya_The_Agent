import { describe, it, expect } from 'vitest';
import { SkillExecutor, questionFromTool } from '../src/main/memory/skillExecutor';
import type { ToolInvoker } from '../src/main/memory/skillExecutor';
import { expandPlaceholders, formatDate, hasPlaceholder, PlaceholderError, templatizeDates } from '../src/main/memory/placeholders';
import type { SkillStep } from '../src/main/memory/types';
import type { ToolArgs, ToolResult } from '../src/main/tools/types';

const NOW = new Date(2026, 9, 4, 10, 30); // 4 October 2026

const step = (over: Partial<SkillStep> & Pick<SkillStep, 'action'>, position = 1): SkillStep => ({
  position,
  target: '',
  value: '',
  submit: false,
  verifyKind: 'none',
  verifyText: '',
  ...over,
});

const page = (over: Record<string, unknown> = {}) => ({ url: 'https://tshc.gov.in/', title: 'Telangana High Court', headings: ['Welcome'], links: ['Home', 'Cause List'], buttons: [], inputs: [], ...over });
const ok = (data: Record<string, unknown> = {}): ToolResult => ({ ok: true, summary: 'ok', data });
const onPage = (p: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): ToolResult => ok({ currentPage: page(p), ...extra });

class FakeTools implements ToolInvoker {
  calls: Array<{ name: string; args: ToolArgs }> = [];
  constructor(private readonly respond: (name: string, args: ToolArgs, n: number) => ToolResult) {}
  async invoke(name: string, args: ToolArgs): Promise<ToolResult> {
    this.calls.push({ name, args });
    return this.respond(name, args, this.calls.filter((c) => c.name === name).length);
  }
}

const exec = (tools: ToolInvoker, extra: Partial<ConstructorParameters<typeof SkillExecutor>[1]> = {}) => new SkillExecutor(tools, { now: () => NOW, sleep: async () => undefined, ...extra });

describe('running a saved routine through the ordinary tools', () => {
  const causeList: SkillStep[] = [
    step({ action: 'open_url', target: 'https://tshc.gov.in/', verifyKind: 'url_contains', verifyText: 'tshc.gov.in' }),
    step({ action: 'click_text', target: 'Cause List', verifyKind: 'page_contains', verifyText: 'Entire Causelist' }, 2),
  ];

  it('opens the site, clicks the link by its text, checks the page says what it should — and reports done', async () => {
    const tools = new FakeTools((name) => (name === 'click_on_page' ? onPage({ title: 'Cause List', links: ['Entire Causelist'] }) : onPage()));
    const out = await exec(tools).run({ steps: causeList });
    expect(out).toEqual({ status: 'done', completed: 2, total: 2, spoken: 'Done.' });
    expect(tools.calls).toEqual([
      { name: 'open_website', args: { url: 'https://tshc.gov.in/' } },
      { name: 'click_on_page', args: { text: 'Cause List' } },
    ]);
  });

  it('uses each action\'s tool with the right arguments: apps, finding, typing (with Enter), choosing an option, opening in a named browser', async () => {
    const tools = new FakeTools((name) => (name === 'find_on_page' ? ok({ matches: [{ name: 'Search' }] }) : onPage()));
    const steps = [
      step({ action: 'open_app', target: 'Notepad' }),
      step({ action: 'open_url', target: 'https://example.org/', value: 'edge' }, 2),
      step({ action: 'find_text', target: 'Search' }, 3),
      step({ action: 'type_text', target: 'Search', value: 'orders', submit: true }, 4),
      step({ action: 'select_option', target: 'Year', value: '2026' }, 5),
    ];
    expect((await exec(tools).run({ steps })).status).toBe('done');
    expect(tools.calls.map((c) => [c.name, c.args])).toEqual([
      ['open_application', { name: 'Notepad' }],
      ['open_website', { url: 'https://example.org/', browser: 'edge' }],
      ['find_on_page', { query: 'Search' }],
      ['fill_on_page', { label: 'Search', value: 'orders', submit: true }],
      ['fill_on_page', { label: 'Year', value: '2026' }],
    ]);
  });

  it('NEVER passes confirm or mode to any tool — a routine cannot answer a safety question for the user', async () => {
    const tools = new FakeTools(() => onPage());
    const steps = [step({ action: 'click_text', target: 'Send' }), step({ action: 'save_file', target: 'desktop', value: 'C:\\Users\\x\\a.pdf' }, 2), step({ action: 'type_text', target: 'Message', value: 'hi' }, 3)];
    await exec(tools).run({ steps });
    for (const c of tools.calls) {
      expect(c.args).not.toHaveProperty('confirm');
      expect(c.args).not.toHaveProperty('mode');
    }
  });

  it('fills in today\'s date each time it runs', async () => {
    const tools = new FakeTools(() => onPage());
    const steps = [
      step({ action: 'type_text', target: 'Date', value: '{{today:dd-mm-yyyy}}' }),
      step({ action: 'type_text', target: 'Day', value: '{{today}}' }, 2),
      step({ action: 'type_text', target: 'Long', value: '{{today:d mmmm yyyy}}' }, 3),
    ];
    await exec(tools).run({ steps });
    expect(tools.calls.map((c) => c.args['value'])).toEqual(['04-10-2026', '2026-10-04', '4 October 2026']);
    const tomorrow = new FakeTools(() => onPage());
    await new SkillExecutor(tomorrow, { now: () => new Date(2026, 9, 5), sleep: async () => undefined }).run({ steps });
    expect(tomorrow.calls.map((c) => c.args['value'])).toEqual(['05-10-2026', '2026-10-05', '5 October 2026']);
  });

  it('stops at a step whose check fails — it does not blindly carry on', async () => {
    const tools = new FakeTools((name) => (name === 'click_on_page' ? onPage({ title: 'Home again', links: ['Home'] }) : onPage()));
    const steps = [...causeList, step({ action: 'click_text', target: 'Entire Causelist' }, 3)];
    const out = await exec(tools, { checkWaitsMs: [] }).run({ steps });
    expect(out).toMatchObject({ status: 'failed', atStep: 2, completed: 1, total: 3, kind: 'verification' });
    expect(out.status === 'failed' && out.reason).toContain('Entire Causelist');
    expect(tools.calls.map((c) => c.name)).toEqual(['open_website', 'click_on_page']); // step 3 never ran
  });

  it('waits and looks again for a page that is still loading when it is checked', async () => {
    let looks = 0;
    const tools = new FakeTools((name) => {
      if (name === 'inspect_page') return (looks += 1) >= 2 ? onPage({ links: ['Entire Causelist'] }) : onPage();
      return name === 'click_on_page' ? onPage({ links: ['Loading…'] }) : onPage();
    });
    const slept: number[] = [];
    const out = await exec(tools, { sleep: async (ms) => void slept.push(ms) }).run({ steps: causeList });
    expect(out.status).toBe('done');
    expect(looks).toBe(2);
    expect(slept).toEqual([700, 1500]);
  });

  it('checks the address and the title as well as the page text, ignoring case', async () => {
    const tools = new FakeTools(() => onPage({ url: 'https://TSHC.gov.in/x', title: 'Cause LIST - High Court' }));
    const steps = [
      step({ action: 'open_url', target: 'https://tshc.gov.in/', verifyKind: 'url_contains', verifyText: 'tshc.gov.in' }),
      step({ action: 'verify', verifyKind: 'title_contains', verifyText: 'cause list' }, 2),
      step({ action: 'verify', verifyKind: 'page_contains', verifyText: 'ENTIRE CAUSELIST' }, 3),
    ];
    const out = await exec(tools, { checkWaitsMs: [] }).run({ steps });
    expect(out).toMatchObject({ status: 'failed', atStep: 3, kind: 'verification' }); // the third check really is false
    expect(out.status === 'failed' && out.completed).toBe(2);
  });

  it('stops and hands over the question when a tool needs the user\'s yes — and never retries with confirm', async () => {
    const tools = new FakeTools((name) =>
      name === 'click_on_page'
        ? { ok: false, summary: 'needs confirmation', error: 'That would be sending or publishing something. Ask the user.', data: { status: 'permission_required', reason: 'This would be sending or publishing something.', question: 'Send this message to Rahul?' } }
        : onPage(),
    );
    const steps = [step({ action: 'open_url', target: 'https://example.org/' }), step({ action: 'click_text', target: 'Send' }, 2), step({ action: 'click_text', target: 'Done' }, 3)];
    const out = await exec(tools).run({ steps });
    expect(out).toMatchObject({ status: 'needs_user', atStep: 2, completed: 1, total: 3, question: 'Send this message to Rahul?' });
    expect(tools.calls.filter((c) => c.name === 'click_on_page')).toHaveLength(1); // asked once, not forced
  });

  it('stops for a sign-in or check only the user can pass', async () => {
    const tools = new FakeTools(() => ok({ needsUser: true, userAction: 'The page is asking you to sign in.', currentPage: page() }));
    const out = await exec(tools).run({ steps: [step({ action: 'open_url', target: 'https://example.org/' })] });
    expect(out).toMatchObject({ status: 'needs_user', question: 'The page is asking you to sign in.' });
  });

  it('a tool that fails stops the routine, and "not on the page" is told apart from other failures', async () => {
    const missing = new FakeTools(() => ({ ok: false, summary: 'not found', error: '"Cause List" isn\'t visible on the current page.' }));
    expect(await exec(missing).run({ steps: [step({ action: 'click_text', target: 'Cause List' })] })).toMatchObject({ status: 'failed', kind: 'not_found', atStep: 1 });
    const broken = new FakeTools(() => ({ ok: false, summary: 'browser not connected', error: 'Not connected.' }));
    expect(await exec(broken).run({ steps: [step({ action: 'open_url', target: 'https://example.org/' })] })).toMatchObject({ status: 'failed', kind: 'tool', reason: 'Not connected.' });
  });

  it('a step the browser tool\'s loop guard refused is reported as blocked, not as a broken routine', async () => {
    const tools = new FakeTools((name) =>
      name === 'click_on_page'
        ? { ok: false, summary: 'repeating itself', error: 'I\'ve already tried clicking "Cause List" 2 times from this exact page.', data: { loopDetected: true, currentPage: page() } }
        : onPage(),
    );
    const out = await exec(tools).run({ steps: causeList });
    expect(out).toMatchObject({ status: 'failed', kind: 'blocked', atStep: 2, completed: 1 });
  });

  it('a "find" step fails if the text is nowhere on the page', async () => {
    const none = new FakeTools(() => ok({ matches: [] }));
    expect(await exec(none).run({ steps: [step({ action: 'find_text', target: 'Orders' })] })).toMatchObject({ status: 'failed', kind: 'not_found' });
    const mention = new FakeTools(() => ok({ matches: [], pageTextMentions: ['…Orders…'] }));
    expect((await exec(mention).run({ steps: [step({ action: 'find_text', target: 'Orders' })] })).status).toBe('done');
  });

  it('a download step needs a real downloaded file, and a save step moves that file', async () => {
    const tools = new FakeTools((name) => (name === 'click_on_page' ? onPage({}, { path: 'C:\\Users\\r\\Downloads\\list.pdf', download: { name: 'list.pdf', verified: true } }) : ok({ path: 'C:\\Users\\r\\Desktop\\list.pdf' })));
    const steps = [step({ action: 'download_file', target: 'Download PDF' }), step({ action: 'save_file', target: 'desktop' }, 2)];
    const out = await exec(tools).run({ steps });
    expect(out).toEqual({ status: 'done', completed: 2, total: 2, spoken: 'Done. list.pdf is in your desktop folder.' });
    expect(tools.calls[1]).toEqual({ name: 'move_file', args: { sourcePath: 'C:\\Users\\r\\Downloads\\list.pdf', destinationFolder: 'desktop' } });
    const noFile = new FakeTools(() => onPage());
    expect(await exec(noFile).run({ steps: [step({ action: 'download_file', target: 'Download PDF' })] })).toMatchObject({ status: 'failed', kind: 'download' });
    expect(await exec(new FakeTools(() => ok())).run({ steps: [step({ action: 'save_file', target: 'desktop' })] })).toMatchObject({ status: 'failed', kind: 'setup' });
  });

  it('an unknown placeholder is an error, not text typed into a form', async () => {
    const tools = new FakeTools(() => onPage());
    const out = await exec(tools).run({ steps: [step({ action: 'type_text', target: 'Date', value: '{{tomorrow}}' })] });
    expect(out).toMatchObject({ status: 'failed', kind: 'setup' });
    expect(tools.calls).toEqual([]);
  });

  it('gives up if the whole routine takes too long', async () => {
    const tools = new FakeTools(() => onPage());
    const out = await exec(tools, { budgetMs: -1 }).run({ steps: causeList });
    expect(out).toMatchObject({ status: 'failed', atStep: 1, completed: 0 });
    expect(tools.calls).toEqual([]);
  });

  it('shows progress as it goes', async () => {
    const seen: string[] = [];
    await exec(new FakeTools(() => onPage()), { onStep: (i, s) => seen.push(`${i + 1}:${s.action}`) }).run({ steps: causeList });
    expect(seen).toEqual(['1:open_url', '2:click_text']);
  });
});

describe('what a tool says when it needs the user', () => {
  it('reads a permission request, a confirmation, and a sign-in; and nothing else', () => {
    expect(questionFromTool({ ok: false, summary: 'x', data: { status: 'permission_required', question: 'Delete it?' } })).toBe('Delete it?');
    expect(questionFromTool({ ok: false, summary: 'x', data: { status: 'permission_required', reason: 'This deletes it.' } })).toBe('This deletes it.');
    expect(questionFromTool({ ok: false, summary: 'needs confirmation', error: 'Ask them.' })).toBe('Ask them.');
    expect(questionFromTool({ ok: true, summary: 'x', data: { needsUser: true, userAction: 'Sign in.' } })).toBe('Sign in.');
    expect(questionFromTool({ ok: true, summary: 'x', data: { currentPage: {} } })).toBeNull();
    expect(questionFromTool({ ok: false, summary: 'not found' })).toBeNull();
  });
});

describe('dates in a routine', () => {
  it('formats a date any of the usual ways', () => {
    expect(formatDate(NOW, 'yyyy-mm-dd')).toBe('2026-10-04');
    expect(formatDate(NOW, 'dd/mm/yyyy')).toBe('04/10/2026');
    expect(formatDate(NOW, 'd/m/yy')).toBe('4/10/26');
    expect(formatDate(NOW, 'dd mmm yyyy')).toBe('04 Oct 2026');
    expect(formatDate(NOW, 'd mmmm yyyy')).toBe('4 October 2026');
  });

  it('turns today\'s date, however it was typed, into a placeholder that fills in correctly tomorrow', () => {
    for (const typed of ['04-10-2026', '2026-10-04', '04/10/2026', '4 October 2026', '04 Oct 2026', '4/10/2026']) {
      const t = templatizeDates(typed, NOW);
      expect(hasPlaceholder(t), typed).toBe(true);
      expect(expandPlaceholders(t, { now: NOW }), typed).toBe(typed);
      expect(expandPlaceholders(t, { now: new Date(2026, 9, 5) }), typed).not.toBe(typed);
    }
  });

  it('leaves everything else alone — another date, a number that merely looks similar, plain text', () => {
    expect(templatizeDates('03-10-2026', NOW)).toBe('03-10-2026');
    expect(templatizeDates('ADV-04102026', NOW)).toBe('ADV-04102026');
    expect(templatizeDates('orders', NOW)).toBe('orders');
    expect(templatizeDates('on 04-10-2026 and 2026-10-04', NOW)).toBe('on {{today:dd-mm-yyyy}} and {{today:yyyy-mm-dd}}');
  });

  it('refuses unknown placeholders and a download that never happened', () => {
    expect(() => expandPlaceholders('{{nope}}', { now: NOW })).toThrow(PlaceholderError);
    expect(() => expandPlaceholders('{{last_download}}', { now: NOW })).toThrow(/earlier download/);
    expect(expandPlaceholders('{{last_download}}', { now: NOW, lastDownload: 'C:\\a.pdf' })).toBe('C:\\a.pdf');
    expect(expandPlaceholders('no placeholders here', { now: NOW })).toBe('no placeholders here');
  });
});
