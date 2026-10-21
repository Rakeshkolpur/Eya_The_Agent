import { describe, it, expect } from 'vitest';
import { parseChatIntent, parseYesNo } from '../src/main/local/chatIntents';
import type { ChatIntent } from '../src/main/local/chatIntents';
import { stripPoliteness } from '../src/main/agent/IntentRouter';

const intent = (text: string): ChatIntent | null => parseChatIntent(text);
const message = (text: string) => {
  const i = intent(text);
  expect(i?.kind, text).toBe('message');
  return i as Extract<ChatIntent, { kind: 'message' }>;
};

describe('stripPoliteness keeps the rest exactly as said', () => {
  it('drops the lead-in but not capitals or punctuation', () => {
    expect(stripPoliteness("Hey Eya, could you please message Ravi that I'll be LATE!")).toBe("message Ravi that I'll be LATE!");
    expect(stripPoliteness('Please send Amma a message')).toBe('send Amma a message');
    expect(stripPoliteness('message Ravi')).toBe('message Ravi');
  });
});

describe('messaging by name', () => {
  it('splits a name from the message at the words people use', () => {
    expect(message("message Ravi that I'll be late")).toMatchObject({ name: 'Ravi', text: "I'll be late", app: null });
    expect(message('Message Ravi Kumar saying Happy Birthday!')).toMatchObject({ name: 'Ravi Kumar', text: 'Happy Birthday!' });
    expect(message('text Priya: running 10 minutes late')).toMatchObject({ name: 'Priya', text: 'running 10 minutes late' });
    expect(message('whatsapp Amma, I reached home')).toMatchObject({ name: 'Amma', text: 'I reached home', app: 'whatsapp' });
    expect(message('tell Sita that dinner is ready')).toMatchObject({ name: 'Sita', text: 'dinner is ready' });
    expect(message("let Raju know I'm on my way")).toMatchObject({ name: 'Raju', text: "I'm on my way" });
  });

  it('understands "send a message to ..." and "send ... a message"', () => {
    expect(message('send a message to Ravi saying see you at 5')).toMatchObject({ name: 'Ravi', text: 'see you at 5' });
    expect(message('send a WhatsApp message to Priya that I called')).toMatchObject({ name: 'Priya', text: 'I called', app: 'whatsapp' });
    expect(message('send Ravi a message saying call me')).toMatchObject({ name: 'Ravi', text: 'call me' });
    expect(message('send a telegram message to Sita: hello there')).toMatchObject({ name: 'Sita', text: 'hello there', app: 'telegram' });
  });

  it('understands the text coming first, when an app is named', () => {
    expect(message('send good morning to Amma on WhatsApp')).toMatchObject({ name: 'Amma', text: 'good morning', app: 'whatsapp' });
    expect(message('say happy birthday to Priya on whatsapp')).toMatchObject({ name: 'Priya', text: 'happy birthday', app: 'whatsapp' });
  });

  it('takes the app from "on WhatsApp" wherever it is', () => {
    expect(message('message Ravi on telegram that I will call')).toMatchObject({ name: 'Ravi', text: 'I will call', app: 'telegram' });
    expect(message("send a message to Ravi on WhatsApp saying I'm late")).toMatchObject({ name: 'Ravi', text: "I'm late", app: 'whatsapp' });
  });

  it('leaves it to the saved names to say where the name ends when nobody said', () => {
    expect(intent("message Ravi I'll be late")).toEqual({ kind: 'message_unsplit', app: null, rest: "Ravi I'll be late" });
    expect(intent('tell Amma I reached home')).toMatchObject({ kind: 'message_unsplit' });
  });

  it('keeps the message exactly: capitals, apostrophes, numbers, emoji', () => {
    expect(message('message Ravi that Meeting is at 5:30 PM, bring the LAPTOP 👍').text).toBe('Meeting is at 5:30 PM, bring the LAPTOP 👍');
    expect(message('message Ravi saying "see you soon"').text).toBe('see you soon');
  });

  it('is not fooled by "that" inside the message', () => {
    // split at the first "that": a wrong split is for ChatCommands to redo against the saved names; the parser keeps the whole part
    const i = message('message Ravi I think that is fine');
    expect(i.rest).toBe('Ravi I think that is fine');
  });

  it('does not take things that are not messages to a person (a file is its own request: see "sending a file")', () => {
    for (const text of [
      'send good morning to Amma', // no app named: could be anything
      'send a message',
      'message',
      'message me later',
      'tell me a joke',
      'tell everyone that dinner is ready',
      'text it to him',
      'what is the weather',
    ]) {
      expect(intent(text), text).toBeNull();
    }
  });
});

describe('sending a file', () => {
  const file = (text: string) => parseChatIntent(text) as Extract<ChatIntent, { kind: 'send_file' }> | null;

  it('"send the latest pdf to Akka" and its other forms', () => {
    expect(file('send the latest pdf to Akka')).toEqual({ kind: 'send_file', app: null, name: 'Akka', file: 'latest pdf' });
    expect(file('send resume.pdf to Amma on WhatsApp')).toEqual({ kind: 'send_file', app: 'whatsapp', name: 'Amma', file: 'resume.pdf' });
    expect(file('share my passport scan with Ravi on Telegram')).toEqual({ kind: 'send_file', app: 'telegram', name: 'Ravi', file: 'passport scan' });
    expect(file('send Ravi my resume')).toEqual({ kind: 'send_file', app: null, name: 'Ravi', file: 'resume' });
    expect(file('whatsapp the invoice to Priya')).toMatchObject({ kind: 'send_file', app: 'whatsapp', name: 'Priya', file: 'invoice' });
  });

  it('"send it to Uber" means the file that was just found (and is not the message "it")', () => {
    expect(file('send it to Uber')).toEqual({ kind: 'send_file', app: null, name: 'Uber', file: null });
    expect(file('send that file to Amma on WhatsApp')).toEqual({ kind: 'send_file', app: 'whatsapp', name: 'Amma', file: null });
    expect(file('send for Uber')).toMatchObject({ name: 'Uber', file: null });
    expect(file('forward this to Priya Singh')).toMatchObject({ name: 'Priya Singh', file: null });
    expect(file('share the document with Ravi')).toMatchObject({ name: 'Ravi', file: null });
  });

  it('takes the request out of a question and a command said together (the real "Uber chat is there na? Send for Uber.")', () => {
    expect(file('Uber chat is there na? Send for Uber.')).toEqual({ kind: 'send_file', app: null, name: 'Uber', file: null });
    expect(parseChatIntent('Okay. Message Ravi that I am late')).toMatchObject({ kind: 'message', name: 'Ravi', text: 'I am late' });
    expect(parseChatIntent('What is the weather? How are you?')).toBeNull(); // a few sentences are not a request
    // a whole message that happens to hold sentences is still ONE message
    expect(parseChatIntent('message Ravi that hello. See you soon.')).toMatchObject({ kind: 'message', name: 'Ravi', text: 'hello. See you soon' });
  });

  it('is not taken for a typed message, a folder, or something that is not a file', () => {
    expect(parseChatIntent('send hi to Ravi on WhatsApp')).toMatchObject({ kind: 'message' });
    expect(parseChatIntent('send a message to Ravi saying here is the report')).toMatchObject({ kind: 'message' });
    expect(file('send my project folder to Ravi')).toBeNull(); // a folder is zipped first: the model's job
    expect(file('send the news to the printer')).toBeNull();
    expect(file('send the latest pdf to Ravi saying here you go and call me later')).toBeNull(); // a message about a file, not the file
  });
});

describe('teaching what a word means', () => {
  const alias = (text: string) => parseChatIntent(text) as Extract<ChatIntent, { kind: 'alias' }> | null;

  it('"when I say akka I mean Lakshmi Akka" and its other forms', () => {
    expect(alias('when I say akka I mean Lakshmi Akka')).toEqual({ kind: 'alias', app: null, alias: 'akka', name: 'Lakshmi Akka' });
    expect(alias('when I say akka, I mean Lakshmi Akka on WhatsApp')).toEqual({ kind: 'alias', app: 'whatsapp', alias: 'akka', name: 'Lakshmi Akka' });
    expect(alias('if I say amma it means Padma Devi')).toMatchObject({ alias: 'amma', name: 'Padma Devi' });
    expect(alias('by akka I mean Lakshmi')).toMatchObject({ alias: 'akka', name: 'Lakshmi' });
  });

  it('"call this chat akka" means the chat that is open', () => {
    expect(alias('call this chat akka')).toEqual({ kind: 'alias', app: null, alias: 'akka', name: null });
    expect(alias('save this contact as akka on WhatsApp')).toEqual({ kind: 'alias', app: 'whatsapp', alias: 'akka', name: null });
    expect(alias('this chat is akka')).toMatchObject({ alias: 'akka', name: null });
  });

  it('is not taken for anything else (a memory, a routine, a message)', () => {
    expect(parseChatIntent("remember that Ravi is my brother's contact")).toBeNull();
    expect(parseChatIntent('save this as a routine')).toBeNull();
    expect(parseChatIntent('when I say hello I mean goodbye to the printer')).not.toBeNull(); // it parses (a word and a name)…
    expect(parseChatIntent('this is great')).toBeNull();
  });
});

describe('opening a chat', () => {
  it('opens a chat by the person', () => {
    expect(intent("open Ravi's chat")).toEqual({ kind: 'open_chat', app: null, name: 'Ravi' });
    expect(intent('open the chat with Priya Singh')).toEqual({ kind: 'open_chat', app: null, name: 'Priya Singh' });
    expect(intent('open Amma on WhatsApp')).toEqual({ kind: 'open_chat', app: 'whatsapp', name: 'Amma' });
    expect(intent('show my conversation with Sita on telegram')).toMatchObject({ kind: 'open_chat', name: 'Sita', app: 'telegram' });
  });
});

describe('the chat names', () => {
  it('learns when asked', () => {
    for (const text of ['remember my WhatsApp contacts', 'learn my contacts', 'read my whatsapp contacts', 'remember my chat names', 'remember the names in my WhatsApp', 'save my telegram contacts']) {
      expect(intent(text)?.kind, text).toBe('learn');
    }
    expect(intent('remember my telegram contacts')).toEqual({ kind: 'learn', app: 'telegram' });
  });

  it('forgets and stops when asked', () => {
    expect(intent('forget my contacts')).toEqual({ kind: 'forget', app: null });
    expect(intent('delete my WhatsApp contacts')).toEqual({ kind: 'forget', app: 'whatsapp' });
    expect(intent('clear my chat names')?.kind).toBe('forget');
    expect(intent("don't remember my contacts")).toEqual({ kind: 'stop_learning' });
    expect(intent('stop remembering chat names')).toEqual({ kind: 'stop_learning' });
  });

  it('counts when asked', () => {
    expect(intent('how many contacts do you know')).toEqual({ kind: 'count' });
    expect(intent('what contacts do you remember')).toEqual({ kind: 'count' });
  });

  it('leaves ordinary memory commands to memory', () => {
    for (const text of ['remember that Ravi is my brother', 'forget Ravi', 'what do you remember', 'remember to buy milk', 'remember this']) {
      expect(intent(text), text).toBeNull();
    }
  });
});

describe('yes and no', () => {
  it('reads a reply to a question', () => {
    for (const yes of ['yes', 'Yes.', 'yeah', 'yes please', 'send it', 'Send', 'go ahead', 'okay', 'hey eya yes', 'do it', 'confirm']) expect(parseYesNo(yes), yes).toBe('yes');
    for (const no of ['no', 'No!', 'nope', 'cancel', "don't send", 'never mind', 'stop', 'discard']) expect(parseYesNo(no), no).toBe('no');
  });

  it('does not take anything else for an answer', () => {
    for (const other of ['yes and also open youtube', 'what time is it', 'maybe', 'send it to Priya instead', 'open chrome', '']) expect(parseYesNo(other), other).toBeNull();
  });
});
