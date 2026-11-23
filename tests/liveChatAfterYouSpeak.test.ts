import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
import { FakeSwitch, rig, settle } from './liveChatFixtures';
import type { Rig } from './liveChatFixtures';

const INTRO = "Hi! 😊 How are you doing today?";

async function auto(): Promise<Rig> {
  const sw = new FakeSwitch();
  sw.on = true;
  const r = rig({ enable: sw.control });
  r.chat.openOutcome = { kind: 'opened', label: 'Meera', verified: true };
  r.chat.open = 'Meera';
  r.chat.title = 'Meera';
  r.ai.say(INTRO);
  await r.controller.handle({ kind: 'start', name: 'Meera', mode: 'assisted' });
  await settle(40);
  r.advance(20_000);
  await settle(40);
  return r;
}

async function theySay(r: Rig, text: string, reply: string | null): Promise<void> {
  if (reply !== null) r.ai.say(reply);
  r.chat.incoming(text);
  r.chat.changed();
  await settle(40);
  r.advance(12_000);
  await settle(40);
}

/**
 * "When I said something in between, and after that the other person wrote again, it did not answer." The person speaks in the chat in between — they type in WhatsApp themselves, or Eya sends
 * their words ("tell her …") while a reply is being written — and the other person's NEXT message must still be answered. (Over a MOCK chat and a MOCK model.)
 */
describe('after the person speaks in between, the next message from the other person is still answered', () => {
  it('the person types in the chat themself, then they write again', async () => {
    const r = await auto();
    await theySay(r, 'how are you', 'I am fine, you?');
    expect(r.chat.pressed.at(-1)).toBe('I am fine, you?');
    r.chat.outgoing('I am at the office da'); // (typed by the person, not by Eya)
    r.chat.changed();
    await settle(40);
    await theySay(r, 'ok what are you doing now', 'Just working, nothing much.');
    expect(r.chat.pressed.at(-1)).toBe('Just working, nothing much.');
  });

  it('the person types in the chat while a reply is ready (it is dropped), then they write again', async () => {
    const r = await auto();
    r.ai.say('I am fine, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(40);
    // (the reply is waiting its ten seconds or is being sent: the person types at the same moment)
    r.chat.outgoing('I am at the office da');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    await theySay(r, 'ok what are you doing now', 'Just working, nothing much.');
    expect(r.chat.pressed.at(-1)).toBe('Just working, nothing much.');
  });

  it('Eya sends their words ("tell her …") while a reply is being written, then they write again', async () => {
    const r = await auto();
    let release: () => void = () => undefined;
    r.ai.hold = new Promise<void>((res) => (release = res));
    r.ai.say('I am fine, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(20);
    expect(r.controller.view().state).toBe('PROCESSING_MESSAGE');
    const done = await r.controller.handle({ kind: 'relay', text: 'I will call at 6' });
    expect(done.ok, done.message).toBe(true);
    r.ai.hold = null;
    release();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    await theySay(r, 'ok what are you doing now', 'Just working, nothing much.');
    expect(r.chat.pressed.at(-1)).toBe('Just working, nothing much.');
  });

  it('an acknowledgement ("good") is not answered, but the next real message is', async () => {
    const r = await auto();
    await theySay(r, 'good', null);
    await theySay(r, 'what are you doing now', 'Just working.');
    expect(r.chat.pressed.at(-1)).toBe('Just working.');
  });

  it('two quick messages from them while she writes (the first reply is out of date): the second is answered', async () => {
    const r = await auto();
    r.ai.say('I am fine, you?');
    r.chat.incoming('how are you');
    r.chat.changed();
    await settle(10);
    r.chat.incoming('and what about food');
    r.ai.say('Had lunch already, you?');
    r.chat.changed();
    await settle(40);
    r.advance(12_000);
    await settle(40);
    expect(r.chat.pressed.length).toBeGreaterThan(1);
  });
});
