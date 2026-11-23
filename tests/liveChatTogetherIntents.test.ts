import { describe, expect, it } from 'vitest';
import { parseChatIntent, parseTogether } from '../src/main/local/chatIntents';
import { parseLiveStart } from '../src/main/livechat/liveChatRequest';
import { parseLiveChatRequest } from '../src/shared/liveChat';

/**
 * TOGETHER: the person sits with Eya in a live chat, like two friends over one phone ("send this message", "no, send this", "wait", "go ahead"). Reading what they SAY into one of the
 * few commands — and, as important, NOT reading anything else as one: a file to send, a message to somebody else, a plain "yes".
 */

describe('dictating a message: "send this …", "type this …"', () => {
  const sends: Array<[string, string]> = [
    ['send this message: I will come at 5', 'I will come at 5'],
    ['send this msg I will come at 5', 'I will come at 5'],
    ['send this - ok see you tomorrow', 'ok see you tomorrow'],
    ['Send this: are you free tonight?', 'are you free tonight?'],
    ['send this to her: sorry I am late', 'sorry I am late'],
    ['send this message to him hello how are you', 'hello how are you'],
    ['no, send this: I will come at 6', 'I will come at 6'],
    ['no send this I will come at 6', 'I will come at 6'],
    ['wait, send this instead: call me later', 'call me later'],
    ['hey Eya, send this message: good morning', 'good morning'],
    ['send the message: see you soon', 'see you soon'],
    ['send: ok done', 'ok done'],
    ['reply this: thank you so much', 'thank you so much'],
    ['send this "thank you da"', 'thank you da'],
  ];
  for (const [said, words] of sends) {
    it(`"${said}" sends "${words}"`, () => {
      expect(parseTogether(said)).toEqual({ kind: 'dictate', text: words, send: true });
    });
  }

  const types: Array<[string, string]> = [
    ['type this: I will call you later', 'I will call you later'],
    ['type this I will call you later', 'I will call you later'],
    ['hey type this message ok see you', 'ok see you'],
    ['write this: good night', 'good night'],
    ['type: see you', 'see you'],
  ];
  for (const [said, words] of types) {
    it(`"${said}" only makes "${words}" ready`, () => {
      expect(parseTogether(said)).toEqual({ kind: 'dictate', text: words, send: false });
    });
  }

  it('"type this" and "send this" with nothing after them are not a message: "send this" alone is the reply that is waiting', () => {
    expect(parseTogether('send this')).toEqual({ kind: 'send_it' });
    expect(parseTogether('type this')).toBeNull();
  });

  it('a file is not a message, and a message to somebody else is not this one', () => {
    expect(parseTogether('send this file to Anna')).toBeNull();
    expect(parseTogether('send this pdf to my brother')).toBeNull();
    expect(parseTogether('send this to Anna')).toBeNull();
    expect(parseTogether('send this message to Anna: hello')).toBeNull();
    // (a colon makes the words free: the person said exactly where the message starts)
    expect(parseTogether('send this: the file is ready')).toEqual({ kind: 'dictate', text: 'the file is ready', send: true });
  });

  it('too long is not a message', () => {
    expect(parseTogether(`send this: ${'word '.repeat(200)}`)).toBeNull();
  });
});

describe('the short commands', () => {
  it('"send it" sends the reply that is waiting', () => {
    for (const s of ['send it', 'Send it.', 'ok send it', 'yes send it', 'send it now', 'just send it', 'go ahead and send it', 'send', 'send that', 'send the message']) {
      expect(parseTogether(s), s).toEqual({ kind: 'send_it' });
    }
  });

  it('"don\'t send it", "cancel", "no" drop it', () => {
    for (const s of ["don't send it", 'do not send that', 'cancel', 'cancel that', 'no', 'nope', 'never mind', 'discard it', 'forget it', 'no, cancel it', 'ok scrap that']) {
      expect(parseTogether(s), s).toEqual({ kind: 'cancel' });
    }
  });

  it('"wait", "let me reply", "I will answer" hold her replies back', () => {
    for (const s of ['wait', 'wait wait', 'hold on', 'hold on a second', 'one second', 'just a moment', 'not yet', "don't reply", "don't reply yet", 'let me reply', 'let me answer first', 'I will answer', "I'll reply myself", 'ok wait', 'no wait']) {
      expect(parseTogether(s), s).toEqual({ kind: 'hold' });
    }
  });

  it('"go ahead", "you reply", "carry on" let her answer', () => {
    for (const s of ['go ahead', 'ok go ahead', 'you reply', 'you answer', 'you can reply now', 'carry on', 'you take over', 'reply now']) {
      expect(parseTogether(s), s).toEqual({ kind: 'release' });
    }
  });

  it('"what did she say" reads her last message', () => {
    for (const s of ['what did she say', 'what did she say?', "what's she saying", 'what did he write', 'read her message', 'read the last message', 'tell me her last message', 'read it again', 'what is the last message']) {
      expect(parseTogether(s), s).toEqual({ kind: 'read' });
    }
  });

  it('"change it to …" edits the one that is ready', () => {
    expect(parseTogether('change it to I will be there at 7')).toEqual({ kind: 'edit', text: 'I will be there at 7' });
    expect(parseTogether('no, make it: see you at 7')).toEqual({ kind: 'edit', text: 'see you at 7' });
    expect(parseTogether('change it')).toBeNull();
  });
});

describe('together on and off', () => {
  it('on', () => {
    for (const s of ['together mode', 'turn on together mode', 'switch on together mode', "I'm here too", 'i am here also', "let's chat together", "let's do this together", 'sit with me', "I'm here now, let's reply together"]) {
      expect(parseTogether(s), s).toEqual({ kind: 'on' });
    }
  });

  it('off', () => {
    for (const s of ['turn off together mode', 'stop together mode', 'together mode off', 'disable together', "I'm leaving", "I'm not here anymore"]) {
      expect(parseTogether(s), s).toEqual({ kind: 'off' });
    }
  });
});

describe('what is NOT read as one of these', () => {
  it('ordinary talk is left alone', () => {
    for (const s of [
      'hello Eya',
      'open YouTube',
      'what is the weather',
      'tell her I will call at 6',
      'message Ravi that I will be late',
      'send the latest pdf to Akka',
      'yes',
      'stop the live chat',
      'pause live chat',
      'do live chat with Anna',
      'continue the task',
      'wait for the page to load and click login',
      'I am here',
    ]) {
      const read = parseTogether(s);
      // ("yes" and the like are for the question that was asked; "tell her …" is the relay)
      expect(read === null || (read.kind !== 'dictate' && read.kind !== 'edit'), `${s} → ${JSON.stringify(read)}`).toBe(true);
    }
    expect(parseTogether('hello Eya')).toBeNull();
    expect(parseTogether('open YouTube')).toBeNull();
    expect(parseTogether('tell her I will call at 6')).toBeNull();
    expect(parseTogether('send the latest pdf to Akka')).toBeNull();
    expect(parseTogether('yes')).toBeNull();
    expect(parseTogether('stop the live chat')).toBeNull();
    expect(parseTogether('wait for the page to load and click login')).toBeNull();
    expect(parseTogether('I am here')).toBeNull();
  });

  it('empty and huge', () => {
    expect(parseTogether('')).toBeNull();
    expect(parseTogether('   ')).toBeNull();
    expect(parseTogether('x'.repeat(800))).toBeNull();
  });
});

describe('starting a live chat together', () => {
  it('"…, I am here too" / "together" in the sentence asks for it', () => {
    expect(parseLiveStart('do live chat with Anna, I am here too')?.together).toBe(true);
    expect(parseLiveStart('live chat with Anna together')?.together).toBe(true);
    expect(parseLiveStart("start live chat with 9361113900, let's chat together")?.together).toBe(true);
    expect(parseLiveStart('do live chat with Anna')?.together).toBe(false);
  });

  it('it reaches the intent as together', () => {
    expect(parseChatIntent('do live chat with Anna, I am here too')).toMatchObject({ kind: 'live_chat', action: 'start', name: 'Anna', together: true });
    expect(parseChatIntent('do live chat with Anna')).not.toHaveProperty('together');
  });
});

describe('the page and the model can send the new requests only in their exact shapes', () => {
  it('set_together, dictate, hold, release', () => {
    expect(parseLiveChatRequest({ kind: 'set_together', on: true })).toEqual({ kind: 'set_together', on: true });
    expect(parseLiveChatRequest({ kind: 'set_together', on: false })).toEqual({ kind: 'set_together', on: false });
    expect(parseLiveChatRequest({ kind: 'set_together' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'set_together', on: 'yes' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'dictate', text: '  ok   see you ', send: false })).toEqual({ kind: 'dictate', text: 'ok see you', send: false });
    expect(parseLiveChatRequest({ kind: 'dictate', text: 'ok see you' })).toEqual({ kind: 'dictate', text: 'ok see you', send: true });
    expect(parseLiveChatRequest({ kind: 'dictate', text: '' })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'dictate', text: 'x'.repeat(601) })).toBeNull();
    expect(parseLiveChatRequest({ kind: 'hold' })).toEqual({ kind: 'hold' });
    expect(parseLiveChatRequest({ kind: 'hold', seconds: 30 })).toEqual({ kind: 'hold', seconds: 30 });
    expect(parseLiveChatRequest({ kind: 'hold', seconds: 100_000 })).toEqual({ kind: 'hold', seconds: 900 });
    expect(parseLiveChatRequest({ kind: 'release' })).toEqual({ kind: 'release' });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Anna', together: true })).toMatchObject({ kind: 'start', together: true });
    expect(parseLiveChatRequest({ kind: 'start', name: 'Anna', together: 'yes' })).not.toHaveProperty('together');
  });
});
