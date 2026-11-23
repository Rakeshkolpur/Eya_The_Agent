import { describe, expect, it } from 'vitest';
import { checkComputerName, COMPUTER_NAME, suggestComputerName } from '../src/main/pc/computerName';

/** What a PC may be called: the rule, the reason it gives, the nearby name it offers, and that nothing else can ever reach the one command that is run with rights. */

describe('what a PC may be called', () => {
  for (const good of ['Rakhi', 'rakhi', 'RAKHI-PC', 'Rakhi-2', 'A', 'a1', 'abcdefghijklmno', 'PC1', 'Rakhi-Laptop']) {
    it(`"${good}" is allowed`, () => {
      expect(checkComputerName(good)).toEqual({ ok: true, name: good });
    });
  }

  it('what was said is trimmed', () => {
    expect(checkComputerName('  Rakhi ')).toEqual({ ok: true, name: 'Rakhi' });
  });

  it('an empty name is asked for', () => {
    const r = checkComputerName('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.say).toBe('Tell me the name you want for this PC.');
  });

  it('a name of more than fifteen characters is refused, with the count and a shorter name', () => {
    const r = checkComputerName('ThisNameIsWayTooLongForWindows');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.say).toContain('at most 15 characters');
      expect(r.say).toContain('has 30');
      expect(r.suggestion).toBe('ThisNameIsWayTo');
    }
  });

  it('"Rakhi\'s PC" is refused, and Rakhis-PC is offered', () => {
    const r = checkComputerName("Rakhi's PC");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.say).toContain('letters, numbers and hyphens');
      expect(r.say).toContain('How about Rakhis-PC?');
      expect(r.suggestion).toBe('Rakhis-PC');
    }
  });

  it('spaces and underscores become hyphens in what is offered', () => {
    expect(suggestComputerName('Rakhi PC')).toBe('Rakhi-PC');
    expect(suggestComputerName('my_laptop')).toBe('my-laptop');
    expect(suggestComputerName('my   big  pc')).toBe('my-big-pc');
  });

  it('a name that is already fine has nothing to suggest', () => {
    expect(suggestComputerName('Rakhi')).toBeNull();
  });

  it('a hyphen at either end is refused (and removed in what is offered)', () => {
    for (const bad of ['-Rakhi', 'Rakhi-', '-']) {
      const r = checkComputerName(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.say, bad).toContain('cannot start or end with a hyphen');
    }
    expect(suggestComputerName('-Rakhi-')).toBe('Rakhi');
  });

  it('only numbers is refused, and not made into a name', () => {
    const r = checkComputerName('123456');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.say).toContain('only numbers');
      expect(r.suggestion).toBeNull();
    }
  });

  it('a name Windows keeps for itself is refused', () => {
    for (const bad of ['CON', 'nul', 'LPT1', 'com3', 'localhost']) {
      const r = checkComputerName(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.say, bad).toContain('keeps');
    }
  });

  it('letters of another language are refused (Windows would not take them for a PC name)', () => {
    expect(checkComputerName('రాఖీ').ok).toBe(false);
    expect(suggestComputerName('రాఖీ')).toBeNull();
  });

  it('a name meant to break out of the command is refused, and what is offered is plain', () => {
    for (const evil of ["x'; Remove-Item C:\\ -Recurse; '", 'a$(calc)', 'a`b', 'a;b', 'a&&b', 'a|b', "a'b", 'a"b', 'a\nb', 'a b', '..\\x']) {
      const r = checkComputerName(evil);
      expect(r.ok, JSON.stringify(evil)).toBe(false);
      if (!r.ok && r.suggestion !== null) {
        expect(r.suggestion, evil).toMatch(COMPUTER_NAME);
        expect(r.suggestion, evil).not.toMatch(/['";&|`$\\\s]/);
      }
    }
  });

  it('whatever is typed, an accepted name is only letters, digits and hyphens, and so is every suggestion', () => {
    // a small fixed pseudo-random sequence, so that the test is the same every time
    let seed = 12345;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = "abcXYZ019-_ .'\";&|`$\\/\n\tరాఖీé";
    for (let i = 0; i < 2000; i += 1) {
      const length = next() % 22;
      let s = '';
      for (let j = 0; j < length; j += 1) s += alphabet[next() % alphabet.length];
      const r = checkComputerName(s);
      if (r.ok) {
        expect(r.name, JSON.stringify(s)).toMatch(COMPUTER_NAME);
        expect(r.name.length).toBeLessThanOrEqual(15);
      } else if (r.suggestion !== null) {
        expect(r.suggestion, JSON.stringify(s)).toMatch(COMPUTER_NAME);
      }
    }
  });
});
