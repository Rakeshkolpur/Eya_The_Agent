import type { LocalCommandResult } from '@main/local/LocalCommands';
import type { WatchState } from './WritingWatch';

/**
 * Talking to Writing Watch: "watch my writing", "stop watching", "check this", "fix it", "ignore it", "read it", "allow cloud check".
 * Said or typed to Eya — never acted on from always-on listening, because "fix it" changes the user's document and watching reads it.
 * Only the exact phrasings below are taken; anything else goes on as before.
 */

export type WritingIntent =
  | { readonly kind: 'start' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'check' }
  | { readonly kind: 'cloud'; readonly on: boolean }
  | { readonly kind: 'fix' }
  | { readonly kind: 'ignore' }
  | { readonly kind: 'read' };

const clean = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:hey |ok |okay )?eya /, '')
    .replace(/^please /, '')
    .replace(/ please$/, '');

const WRITING = '(?:writing|drafting|typing|draft|petition|document|work)';

const START = [
  new RegExp(`^(?:start |begin |turn on |switch on )?(?:watch|watching|observe|observing|monitor|monitoring|proofread|proofreading)(?: (?:my|the|your))? ${WRITING}(?: (?:in|on) (?:word|notepad|wordpad))?$`),
  /^(?:start|begin|turn on|switch on) writing (?:watch|check|helper)$/,
  /^watch (?:me|while i) (?:write|writing|draft|drafting|type|typing)(?: (?:in|on) (?:word|notepad))?$/,
  /^(?:keep an eye|have a look|look) (?:on|at) my (?:writing|drafting|petition|draft)(?: while i (?:write|draft|type))?$/,
  /^(?:observe|watch|check|proofread) (?:my|the) (?:petition|draft|document|writing)? ?(?:while|as) i (?:am )?(?:writing|drafting|typing|write|draft|type)(?: it)?$/,
  /^(?:observe|watch) (?:while|as) i (?:am )?(?:writing|drafting|typing|write|draft|type)(?: (?:a|my|the) (?:petition|draft|document))?$/,
];
const STOP = [
  new RegExp(`^(?:stop|quit|end|turn off|switch off|cancel) (?:watching|observing|monitoring|proofreading)(?: (?:my|the))?(?: ${WRITING})?$`),
  /^(?:stop|turn off|switch off) writing (?:watch|check|helper)$/,
  /^(?:stop|no more) (?:the )?(?:writing )?(?:suggestions|corrections)$/,
];
const CHECK = [
  /^(?:check|proofread|review|look over|go through|find (?:the )?mistakes in) (?:this|my|the) (?:document|petition|draft|writing|paragraph|page|file|work)(?: once)?$/,
  /^(?:check|proofread) (?:this|it)(?: once| now| again)?$/,
  /^(?:find|any) mistakes(?: in (?:this|my) (?:petition|draft|document))?$/,
  /^(?:are there|is there) any (?:mistakes|errors)(?: in (?:this|my) (?:petition|draft|document))?$/,
];
const CLOUD_ON = [
  /^(?:allow|turn on|switch on|enable|start|use) (?:the )?cloud (?:check|checking)(?: for (?:my|the) writing)?$/,
  /^(?:use gemini|ask gemini) to (?:also )?(?:check|proofread|review) (?:my|the) (?:writing|drafting|draft|petition|paragraph)$/,
  /^(?:also )?(?:check|proofread) (?:my|the) (?:writing|drafting|draft|petition|paragraph) (?:with|using) gemini$/,
];
const CLOUD_OFF = [
  /^(?:stop|turn off|switch off|disable|no more|don'?t use) (?:the )?cloud (?:check|checking)$/,
  /^(?:stop|don'?t|do not) (?:using gemini|(?:sending|send) my (?:writing|petition|draft|text) to gemini)(?: to check (?:my|the) (?:writing|petition|draft))?$/,
];
const FIX = [/^(?:fix|correct|apply) (?:it|that|this|the fix|the correction|the first one|the suggestion|the mistake)$/, /^(?:yes )?(?:fix|correct) (?:it|that)(?: for me)?$/, /^make (?:that|the) (?:fix|correction)$/];
const IGNORE = [/^(?:ignore|dismiss|skip|forget|drop) (?:it|that|this|the suggestion|the first one|this suggestion)$/, /^(?:no )?(?:leave it|that'?s fine|that is fine|it'?s fine|it is fine)$/];
const READ = [
  /^(?:read|say|tell me) (?:it|that|this|the suggestion|the mistake|the correction)(?: out)?(?: again)?$/,
  /^(?:what(?:'s| is) (?:the )?(?:mistake|wrong|problem|error)|what did you (?:find|see|notice)|what(?:'s| is) wrong(?: with it)?)$/,
];

export function parseWritingIntent(raw: string): WritingIntent | null {
  const text = clean(raw);
  if (text === '' || text.split(' ').length > 14) return null;
  if (STOP.some((r) => r.test(text))) return { kind: 'stop' };
  if (CLOUD_OFF.some((r) => r.test(text))) return { kind: 'cloud', on: false };
  if (CLOUD_ON.some((r) => r.test(text))) return { kind: 'cloud', on: true };
  if (START.some((r) => r.test(text))) return { kind: 'start' };
  if (CHECK.some((r) => r.test(text))) return { kind: 'check' };
  if (FIX.some((r) => r.test(text))) return { kind: 'fix' };
  if (IGNORE.some((r) => r.test(text))) return { kind: 'ignore' };
  if (READ.some((r) => r.test(text))) return { kind: 'read' };
  return null;
}

export interface WritingHost {
  state(): WatchState;
  start(): void;
  stop(): void;
  checkAll(): Promise<number>;
  setCloudAllowed(on: boolean): void;
  fix(id: string): Promise<boolean>;
  dismiss(id: string): boolean;
  /** Whether a Gemini key is set (the deeper check cannot run without one). */
  cloudAvailable(): boolean;
}

const result = (spoken: string, ok = true, intent = 'writing_watch'): LocalCommandResult => ({ spoken, ok, intent, tools: [], refs: [] });

export class WritingCommands {
  constructor(private readonly host: WritingHost) {}

  async tryHandle(text: string, options: { readonly live?: boolean } = {}): Promise<LocalCommandResult | null> {
    // Watching reads the user's document and "fix it" changes it: neither is ever started by sound from the room.
    if (options.live === true) return null;
    const intent = parseWritingIntent(text);
    if (intent === null) return null;
    const { host } = this;
    const top = host.state().findings[0];
    switch (intent.kind) {
      case 'start': {
        if (host.state().watching) return result('I am already watching your writing.');
        host.start();
        return result(
          "Okay, I'll watch your writing in Word or Notepad and show a small card when I see a mistake. I'll never change anything unless you click Fix, and everything stays on this PC.",
        );
      }
      case 'stop':
        if (!host.state().watching) return result("I wasn't watching.");
        host.stop();
        return result("Okay, I've stopped watching.");
      case 'check': {
        const n = await host.checkAll();
        const state = host.state();
        if (state.note !== '') return result(state.note, false);
        return result(n === 0 ? "I read it through and found nothing to correct." : `I found ${n} thing${n === 1 ? '' : 's'} to look at. They're on the card.`);
      }
      case 'cloud':
        if (!intent.on) {
          host.setCloudAllowed(false);
          return result("Okay, nothing is sent to Gemini any more. Checks stay on this PC.");
        }
        if (!host.cloudAvailable()) return result('The deeper check needs your Gemini key. Add it in Settings, then ask me again.', false);
        host.setCloudAllowed(true);
        return result(
          'Okay. For this session I will also ask Gemini to check the one paragraph you are writing — only that paragraph, and only while you are writing. Say "stop cloud check" to end it.',
        );
      case 'fix': {
        if (top === undefined) return result('There is nothing to fix right now.', false);
        if (!top.canFix) return result(`I can't fix that one for you: ${top.message}. It needs your own decision.`, false);
        return (await host.fix(top.id)) ? result(`Done. ${top.message} — fixed.`) : result("I couldn't make that change: the words have moved since I saw them.", false);
      }
      case 'ignore':
        if (top === undefined) return result('There is nothing to ignore right now.', false);
        host.dismiss(top.id);
        return result("Okay, I'll leave that one.");
      case 'read':
        return top === undefined ? result('I have not found anything to correct.') : result(`${top.message}.`);
    }
  }
}
