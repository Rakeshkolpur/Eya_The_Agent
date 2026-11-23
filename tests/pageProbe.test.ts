import { describe, expect, it } from 'vitest';
import { normalizePageState } from '../src/main/chrome/pageState';
import { maskStructure, probeReport, probeSignature, safeLabel, shapeOf } from '../src/main/chat/pageProbe';

/**
 * The page probe is how a real chat page is studied without anything private being written down: the app's own words stay, everything else
 * (names, numbers, previews, messages) is reduced to its shape.
 */

const state = normalizePageState({
  url: 'https://web.whatsapp.com/',
  title: '(2) WhatsApp',
  headings: ['Select chats', 'Priya Sharma'],
  dialogs: ['Select chats\nRecent chats\nPriya Sharma\n+91 98765 43210'],
  statuses: ['read'],
  elements: [
    { id: 'e1', role: 'input', name: 'Search name, number or @username', type: 'text', region: 'dialog', inViewport: true },
    { id: 'e2', role: 'input', name: 'Search or start a new chat', type: 'text', value: 'priya', inViewport: true },
    { id: 'e3', role: 'button', name: 'Priya Sharma Thursday see you at 6 pm', primary: 'Priya Sharma', region: 'dialog', inViewport: true },
    { id: 'e4', role: 'checkbox', name: 'Priya Sharma', checked: true, region: 'dialog', inViewport: true },
    { id: 'e5', role: 'button', name: 'Close', region: 'dialog', inViewport: true },
    { id: 'e6', role: 'clickable', name: '+91 98765 43210 call me tomorrow', primary: '+91 98765 43210', inViewport: true },
  ],
});

describe('page probe', () => {
  it('keeps the app\'s own words and reduces everything else to a shape', () => {
    expect(safeLabel('Select chats')).toBe('Select chats');
    expect(safeLabel('Search name, number or @username')).toBe('Search name, number or @username');
    expect(safeLabel('Priya Sharma')).toBe('‹Aaaaa Aaaaaa› (12)');
    expect(safeLabel('+91 98765 43210')).toBe('‹+99 99999 99999› (15)');
    expect(shapeOf('Anna 10:42')).toBe('Aaaa 99:99');
  });

  it('writes no name, number, preview or typed text anywhere in a report', () => {
    const json = JSON.stringify(probeReport(state, '2026-10-25T00:00:00Z'));
    for (const secret of ['Priya', 'Sharma', '98765', '43210', 'see you', 'call me', 'priya']) expect(json).not.toContain(secret);
    expect(json).toContain('Select chats');
    expect(json).toContain('Search name, number or @username');
  });

  it('says where the controls sit and whether a box is ticked (the structure, not the content)', () => {
    const report = probeReport(state, 'now');
    expect(report.host).toBe('web.whatsapp.com');
    expect(report.dialogElements.map((e) => e.role)).toEqual(['input', 'button', 'checkbox', 'button']);
    expect(report.dialogElements.find((e) => e.role === 'checkbox')?.checked).toBe(true);
    expect(report.counts['checkbox@dialog']).toBe(1);
    expect(report.inputs[1]?.value).toBe('‹aaaaa› (5)');
  });

  it('notices a change that matters (a box ticked) and not one that does not (the time)', () => {
    const before = probeReport(state, 'a');
    const same = probeReport(state, 'b');
    expect(probeSignature(before)).toBe(probeSignature(same));
    const unticked = normalizePageState({ ...JSON.parse(JSON.stringify(state)), elements: state.elements.map((e) => (e.role === 'checkbox' ? { ...e, checked: false } : e)) });
    expect(probeSignature(probeReport(unticked, 'c'))).not.toBe(probeSignature(before));
  });

  it('masks what the extension says about the fields and file inputs', () => {
    const built = maskStructure({
      fields: [{ tag: 'div', editable: true, ariaLabel: 'Type to Priya Sharma', placeholder: 'Type a message', title: '', inFooter: true, chain: ['footer', 'div#main'] }],
      files: [{ tag: 'input', type: 'file', accept: '*', inMain: false, visible: false }],
      roleCounts: { row: 4 },
    });
    expect(JSON.stringify(built)).not.toContain('Priya');
    expect(built?.fields[0]).toMatchObject({ placeholder: 'Type a message', inFooter: true, editable: true });
    expect(built?.files[0]).toMatchObject({ accept: '*', inMain: false });
    expect(maskStructure(null)).toBeNull();
  });
});
