import { describe, it, expect } from 'vitest';
import { isConversationTrigger } from '../src/shared/wake';

describe('isConversationTrigger', () => {
  it('recognizes simply calling Eya, however it was spelled', () => {
    for (const heard of ['Eya', 'Hey Eya.', 'hey ayah', 'Hi Aya!', 'okay Iya', 'Hello, Eyah?']) {
      expect(isConversationTrigger(heard), heard).toBe(true);
    }
  });

  it('recognizes the way the real speech model spelled it in my tests', () => {
    expect(isConversationTrigger('Hey, I')).toBe(true); // "Hey Eya" -> "Hey, I"
    expect(isConversationTrigger('Hey, I-A.')).toBe(true);
    expect(isConversationTrigger('hey ee-ya')).toBe(true);
    expect(isConversationTrigger('Hey Ayah,')).toBe(true);
  });

  it('does not mistake an ordinary sentence starting "Hey, I..." for a call', () => {
    for (const heard of ["Hey, I think that's right", 'Hey I was going to say', 'Hey, I need a coffee']) {
      expect(isConversationTrigger(heard), heard).toBe(false);
    }
  });

  it('recognizes calling her and asking to talk', () => {
    for (const heard of ["Hey Eya, let's talk", 'Eya talk to me', 'hey eya are you there', 'Hey Aya, can we talk?', 'Eya start a conversation']) {
      expect(isConversationTrigger(heard), heard).toBe(true);
    }
  });

  it('does not treat a request as a call: those are commands', () => {
    for (const heard of ['Hey Eya, open Notepad', 'Eya close chrome', 'open notepad', 'Hey Eya what time is it']) {
      expect(isConversationTrigger(heard), heard).toBe(false);
    }
  });

  it('does not fire on ordinary speech that merely contains similar sounds', () => {
    for (const heard of ['I read the ayah aloud', 'talk to me about the weather', "let's talk later", 'hey', '', '   ', 'the idea is good']) {
      expect(isConversationTrigger(heard), heard).toBe(false);
    }
  });
});
