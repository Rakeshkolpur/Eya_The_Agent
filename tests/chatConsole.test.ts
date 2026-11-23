import { describe, expect, it } from 'vitest';
import { parseChatConsole } from '../src/main/browser/chatConsole';

/** What a page's chat watcher says on its console, in the two shapes Electron hands a console line over in. Electron itself is not run here. */
describe('the page says on its console that something changed in the open chat', () => {
  it('the older shape: (event, level, message, line, source)', () => {
    expect(parseChatConsole([{ preventDefault() {} }, 0, '__EYA_CHAT_EVENT__ messages 12', 1, 'https://web.whatsapp.com/'])).toEqual({ reason: 'messages', rows: 12 });
  });

  it('the newer shape: the text is on the event', () => {
    expect(parseChatConsole([{ message: '__EYA_CHAT_EVENT__ switched 3', level: 'debug' }])).toEqual({ reason: 'switched', rows: 3 });
  });

  it('a closed chat and a count of none', () => {
    expect(parseChatConsole([{}, 1, '__EYA_CHAT_EVENT__ closed 0'])).toEqual({ reason: 'closed', rows: 0 });
  });

  it.each([
    [[{}, 0, 'just a page talking', 1, 'x']],
    [[{}, 0, 'prefix __EYA_CHAT_EVENT__ messages 1']],
    [[{}, 0, '__EYA_CHAT_EVENT__ messages']],
    [[{}, 0, '__EYA_CHAT_EVENT__ way-too-long-a-reason-here 5']],
    [[{}, 0, '__EYA_CHAT_EVENT__ messages notanumber']],
    [[]],
    [[null, undefined, 5]],
  ])('anything else is not one: %j', (args) => {
    expect(parseChatConsole(args as unknown[])).toBeNull();
  });
});
