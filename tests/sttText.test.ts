import { describe, it, expect } from 'vitest';
import { cleanTranscript } from '../src/renderer/sttText';

describe('cleanTranscript', () => {
  it('keeps real commands as they are', () => {
    expect(cleanTranscript(' Open Notepad.')).toBe('Open Notepad.');
    expect(cleanTranscript('Find my latest PDF in downloads and tell me the hearing date.')).toBe(
      'Find my latest PDF in downloads and tell me the hearing date.',
    );
  });

  it('drops the sign-offs Whisper invents for silence and noise', () => {
    for (const invented of ['you', 'You.', 'Thank you.', 'Thanks for watching!', 'Bye.', 'Thank you for watching.', 'the end']) {
      expect(cleanTranscript(invented), invented).toBe('');
    }
  });

  it('drops filler that is not a command', () => {
    for (const filler of ['Um', 'Hmm.', 'Uh...', 'Okay.', 'Mhm']) expect(cleanTranscript(filler), filler).toBe('');
  });

  it('removes sound annotations and keeps the speech around them', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('(music)')).toBe('');
    expect(cleanTranscript('*applause*')).toBe('');
    expect(cleanTranscript('[MUSIC] open chrome (coughs)')).toBe('open chrome');
    expect(cleanTranscript('♪ ♪')).toBe('');
  });

  it('drops decoder loops', () => {
    expect(cleanTranscript('the the the the the the')).toBe('');
    expect(cleanTranscript('open open open open open notepad')).toBe('');
    expect(cleanTranscript('go go go go go go go go')).toBe('');
  });

  it('does not mistake a normal repeated word for a loop', () => {
    expect(cleanTranscript('Open open the notepad app please')).toBe('Open open the notepad app please');
    expect(cleanTranscript('no no no I meant close it')).toBe('no no no I meant close it');
  });

  it('keeps a real command that merely contains an invented word', () => {
    expect(cleanTranscript('thank you for opening notepad')).toBe('thank you for opening notepad');
    expect(cleanTranscript('say goodbye to chrome')).toBe('say goodbye to chrome');
  });

  it('handles empty and whitespace input', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   \n ')).toBe('');
  });
});
