import { describe, expect, it } from 'vitest';
import { blockerNote, isTypedGoal, LIVE_ASSIST_RULES, liveNote, shouldStartLiveAssist, TYPED_LONG_WINDOW_MS, TYPED_WINDOW_MS, typedTaskNote } from '../src/renderer/liveAssist';
import { DEFAULT_APP_SETTINGS, parseAppSettings } from '../src/main/settings/appSettings';
import { cleanSettingsPatch } from '../src/main/windows/snapshots';

/**
 * LIVE ASSISTANT: a task the person TYPED starts to work in a browser → the one microphone comes on by itself and Eya talks like a live person beside them ("okay, wait, I'm opening it here —
 * scan it"). What decides it, and the words the live voice model is given.
 */

describe('the task the person typed is told from the goal the Browser page shows', () => {
  const typed = { text: 'do live chat with Meera, she is my partner', at: 1_000_000 };

  it('the same words, or the start of them (the page cuts the goal to 200 characters), a moment later', () => {
    expect(isTypedGoal('do live chat with Meera, she is my partner', typed, 1_005_000)).toBe(true);
    expect(isTypedGoal('Do  live chat with meera, she is my partner', typed, 1_005_000)).toBe(true);
    expect(isTypedGoal('do live chat with Meera', typed, 1_005_000)).toBe(true);
    const long = { text: `${'open this and that and the other thing '.repeat(8)}end`, at: 1_000_000 };
    expect(isTypedGoal(long.text.slice(0, 200), long, 1_005_000)).toBe(true);
  });

  it('not another task, not something said, and not long after', () => {
    expect(isTypedGoal('open YouTube and play a song', typed, 1_005_000)).toBe(false);
    expect(isTypedGoal('', typed, 1_005_000)).toBe(false);
    expect(isTypedGoal('do live chat with Meera', { text: '', at: 0 }, 1_005_000)).toBe(false);
    expect(isTypedGoal('do live chat with Meera', typed, typed.at + TYPED_WINDOW_MS + 1)).toBe(false);
    // (a page that needs the person can come late in a long task)
    expect(isTypedGoal('do live chat with Meera', typed, typed.at + TYPED_WINDOW_MS + 1, TYPED_LONG_WINDOW_MS)).toBe(true);
    expect(isTypedGoal('do live chat with Meera', typed, typed.at + TYPED_LONG_WINDOW_MS + 1, TYPED_LONG_WINDOW_MS)).toBe(false);
  });
});

describe('when the live mic starts by itself', () => {
  const ok = { enabled: true, voiceOn: true, canHear: true, talk: 'off' as const, handsFree: false };
  it('only with the setting on, voice on, a microphone she can hear with, and no conversation going or starting', () => {
    expect(shouldStartLiveAssist(ok)).toBe(true);
    expect(shouldStartLiveAssist({ ...ok, enabled: false })).toBe(false);
    expect(shouldStartLiveAssist({ ...ok, voiceOn: false })).toBe(false);
    expect(shouldStartLiveAssist({ ...ok, canHear: false })).toBe(false);
    expect(shouldStartLiveAssist({ ...ok, talk: 'on' })).toBe(false);
    expect(shouldStartLiveAssist({ ...ok, talk: 'connecting' })).toBe(false);
    expect(shouldStartLiveAssist({ ...ok, handsFree: true })).toBe(false);
  });
});

describe('what the live voice model is told', () => {
  it('how to be: a person beside them, one short line, listening, nothing claimed that was not done', () => {
    expect(LIVE_ASSIST_RULES.startsWith("[Eya's note]")).toBe(true);
    expect(LIVE_ASSIST_RULES).toMatch(/like a person sitting next to them/);
    expect(LIVE_ASSIST_RULES).toMatch(/ONE short natural line/);
    expect(LIVE_ASSIST_RULES).toMatch(/QR code to scan/);
    expect(LIVE_ASSIST_RULES).toMatch(/never claim something is done/);
  });

  it('the task they typed, by name', () => {
    const note = typedTaskNote('Rakesh', 'do live chat with Meera');
    expect(note.startsWith("[Eya's note] (live)")).toBe(true);
    expect(note).toContain('"do live chat with Meera"');
    expect(note).toContain("The user's name is Rakesh.");
    expect(note).toMatch(/one short, natural line/);
    expect(typedTaskNote('', 'do live chat').includes('name is')).toBe(false);
    expect(typedTaskNote('', 'x'.repeat(500)).length).toBeLessThan(500);
  });

  it('the page needs them: what, and then wait', () => {
    const note = blockerNote('Rakesh', 'WhatsApp is asking for its QR code');
    expect(note).toContain('WhatsApp is asking for its QR code');
    expect(note).toMatch(/what to do/);
    expect(note).toMatch(/wait quietly/);
  });

  it('what Eya is doing, said right now', () => {
    const note = liveNote('Rakesh, wait: I have opened WhatsApp here and it is asking for the QR code.');
    expect(note).toContain('I have opened WhatsApp here');
    expect(note).toMatch(/right now/);
  });
});

describe('the setting "Talk while I work"', () => {
  it('is on by default, read back from what was saved, and changed only by a real true or false', () => {
    expect(DEFAULT_APP_SETTINGS.talkWhileWorking).toBe(true);
    expect(parseAppSettings({}).talkWhileWorking).toBe(true);
    expect(parseAppSettings({ talkWhileWorking: false }).talkWhileWorking).toBe(false);
    expect(parseAppSettings({ talkWhileWorking: 'no' }).talkWhileWorking).toBe(true);
    expect(cleanSettingsPatch({ talkWhileWorking: false }).patch).toEqual({ talkWhileWorking: false });
    expect(cleanSettingsPatch({ talkWhileWorking: 'false' }).patch).toEqual({});
  });
});
