import { describe, expect, it } from 'vitest';
import {
  countryContext,
  DEFAULT_COUNTRY,
  foldDigits,
  maskNumber,
  numberShownIn,
  phoneDigitsOf,
  readPhoneReference,
  spokenNumbersToDigits,
} from '../src/main/chat/phoneNumbers';

const US = countryContext('US');

describe('country context', () => {
  it('is India until another country is chosen, and never guesses from nonsense', () => {
    expect(DEFAULT_COUNTRY.region).toBe('IN');
    expect(countryContext(undefined).region).toBe('IN');
    expect(countryContext('').region).toBe('IN');
    expect(countryContext('ZZ').region).toBe('IN');
    expect(countryContext('india').region).toBe('IN'); // not a two-letter code
    expect(countryContext(' us ').region).toBe('US');
    expect(countryContext('gb').region).toBe('GB');
  });
});

describe('whole numbers', () => {
  it.each([
    '+91 9361113900',
    '+91-93611-13900',
    '+91 (936) 111-3900',
    '91 9361113900',
    '919361113900',
    '0091 9361113900',
    '00919361113900',
  ])('%s is an international number: the code was written by the person', (text) => {
    const r = readPhoneReference(text);
    expect(r?.kind).toBe('international');
    expect(r?.e164).toBe('919361113900');
    expect(r?.national).toBe('9361113900');
    expect(r?.region).toBe('IN');
    expect(r?.countryAssumed).toBe(false);
  });

  it.each(['9361113900', '93611 13900', '93611-13900', '(936) 111 3900', '09361113900', '0 9361113900'])(
    '%s is a national number: the country code comes from the configured country',
    (text) => {
      const r = readPhoneReference(text);
      expect(r?.kind).toBe('national');
      expect(r?.e164).toBe('919361113900');
      expect(r?.countryAssumed).toBe(true);
      expect(r?.notes.join(' ')).toContain('+91');
    },
  );

  it('reads the same digits against another configured country, not India', () => {
    const r = readPhoneReference('(415) 555-2671', US);
    expect(r?.kind).toBe('national');
    expect(r?.e164).toBe('14155552671');
    expect(r?.region).toBe('US');
    // the very same digits read against India are an Indian number (a landline, and it says so): the configured country decides, never a guess
    const india = readPhoneReference('4155552671');
    expect(india?.kind).toBe('national');
    expect(india?.e164).toBe('914155552671');
    expect(india?.lineType).toBe('FIXED_LINE');
    expect(india?.notes.join(' ')).toContain('landline');
  });

  it('never adds a country code to a number that is not valid there: it could be somebody else', () => {
    for (const text of ['5361113900', '5999999999', '1111111111', '0000000000']) {
      const r = readPhoneReference(text);
      expect(r?.kind, text).toBe('unclear');
      expect(r?.e164, text).toBeUndefined();
      expect(r?.digits, text).toBe(text);
    }
  });

  it('keeps a foreign number that was written with its code, whatever the configured country is', () => {
    const r = readPhoneReference('+44 7911 123456');
    expect(r?.kind).toBe('international');
    expect(r?.e164).toBe('447911123456');
    const us = readPhoneReference('+1 415 555 2671');
    expect(us?.e164).toBe('14155552671');
    // without the plus, a UK number is NOT turned into an Indian one
    expect(readPhoneReference('447911123456')?.e164).toBeUndefined();
    expect(readPhoneReference('447911123456')?.kind).toBe('unclear');
  });

  it('does not accept a code that does not belong to the number', () => {
    expect(readPhoneReference('+91 12345')?.kind).not.toBe('international');
    expect(readPhoneReference('+999 9361113900')?.kind).toBe('unclear');
    expect(readPhoneReference('+91 5361113900')?.kind).toBe('unclear');
  });

  it('says a landline is a landline', () => {
    const r = readPhoneReference('+91 40 2345 6789');
    expect(r?.kind).toBe('international');
    expect(r?.notes.join(' ')).toContain('landline');
  });

  it('phoneDigitsOf gives digits with the code only for numbers that are valid', () => {
    expect(phoneDigitsOf('9361113900')).toBe('919361113900');
    expect(phoneDigitsOf('+91 9361113900')).toBe('919361113900');
    expect(phoneDigitsOf('5361113900')).toBeNull();
    expect(phoneDigitsOf('anna')).toBeNull();
    expect(phoneDigitsOf('3900')).toBeNull();
    expect(phoneDigitsOf('(415) 555-2671', US)).toBe('14155552671');
  });

  it('refuses text that is not about a number at all', () => {
    for (const t of ['', '   ', 'anna', 'my brother', 'him', 'Anna 3900', 'send 9361113900 hello', '7']) {
      expect(readPhoneReference(t), t).toBeNull();
    }
  });
});

describe('part of a number', () => {
  it.each([
    ['3900', 'any'],
    ['ending 3900', 'ends'],
    ['ending with 3900', 'ends'],
    ['the number ending in 3900', 'ends'],
    ['whose number ends with 3900', 'ends'],
    ['the last 4 digits 3900', 'ends'],
    ['last four digits 3900', 'ends'],
    ['starting 93611', 'starts'],
  ] as const)('%s', (text, mode) => {
    const r = readPhoneReference(text);
    expect(r?.kind).toBe('partial');
    expect(r?.mode).toBe(mode);
    // the "4" in "last 4 digits" is a count, never a digit of the number
    expect(r?.digits).toBe(text.includes('93611') ? '93611' : '3900');
  });

  it('is never expanded into a whole number', () => {
    const r = readPhoneReference('ending 3900');
    expect(r?.e164).toBeUndefined();
    expect(r?.national).toBeUndefined();
  });
});

describe('numbers said out loud and in other scripts', () => {
  it('turns spoken digits into digits', () => {
    expect(spokenNumbersToDigits('send to nine three six one one one three nine zero zero hello')).toBe('send to 9361113900 hello');
    expect(spokenNumbersToDigits('nine three six triple one three nine double zero')).toBe('9361113900');
    expect(spokenNumbersToDigits('nine three six double one three nine double zero')).toBe('936113900');
    expect(spokenNumbersToDigits('triple five one two three four')).toBe('5551234');
    expect(spokenNumbersToDigits('hello there')).toBe('hello there');
  });

  it('leaves a few spoken digits in a sentence alone, unless a number was announced', () => {
    expect(spokenNumbersToDigits('buy one two three apples')).toBe('buy one two three apples');
    expect(spokenNumbersToDigits('one message')).toBe('one message');
    expect(spokenNumbersToDigits('the number ending three nine zero zero')).toBe('the number ending 3900');
  });

  it('reads a full spoken number', () => {
    const r = readPhoneReference('nine three six one one one three nine zero zero');
    expect(r?.kind).toBe('national');
    expect(r?.e164).toBe('919361113900');
    expect(r?.spoken).toBe(true);
  });

  it('reads a spoken number with a spoken plus and country code', () => {
    const r = readPhoneReference('plus nine one nine three six one one one three nine zero zero');
    expect(r?.kind).toBe('international');
    expect(r?.e164).toBe('919361113900');
    const uk = readPhoneReference('plus four four seven nine one one one two three four five six');
    expect(uk?.kind).toBe('international');
    expect(uk?.e164).toBe('447911123456');
  });

  it('reads a spoken partial number', () => {
    const r = readPhoneReference('ending three nine zero zero');
    expect(r?.kind).toBe('partial');
    expect(r?.digits).toBe('3900');
    expect(r?.mode).toBe('ends');
    expect(r?.spoken).toBe(true);
  });

  it('reads digits of other scripts (Devanagari, Telugu, Arabic-Indic)', () => {
    expect(foldDigits('९३६१११३९००')).toBe('9361113900');
    expect(foldDigits('౯౩౬౧౧౧౩౯౦౦')).toBe('9361113900');
    expect(foldDigits('٩٣٦١١١٣٩٠٠')).toBe('9361113900');
    expect(foldDigits('Ａｎｎａ ３９００')).toBe('Anna 3900'); // full-width
    const r = readPhoneReference('९३६१११३९००');
    expect(r?.e164).toBe('919361113900');
    expect(r?.spoken).toBe(true);
  });
});

describe('showing a number', () => {
  it('masks all but the last four digits and never shows the whole number', () => {
    const m = maskNumber('919361113900');
    expect(m).toBe('+91 ••••••3900');
    expect(m).not.toContain('936111');
    expect(maskNumber('9361113900')).toMatch(/3900$/);
    expect(maskNumber('9361113900')).not.toContain('936');
    expect(maskNumber('')).toBe('');
  });

  it('finds the number a chat is shown under', () => {
    expect(numberShownIn('+91 93611 13900')).toBe('919361113900');
    expect(numberShownIn('Anna Reddy')).toBeNull();
    expect(numberShownIn('Anna 2 hours ago')).toBeNull();
    expect(numberShownIn('Typing…')).toBeNull();
  });
});
