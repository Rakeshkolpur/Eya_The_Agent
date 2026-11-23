/**
 * What a PC may be called. Pure.
 *
 * Windows takes a computer name of 1 to 15 characters: letters, digits and hyphens, not starting or ending with a hyphen, and not only digits. The rule is also what keeps the name safe to hand to
 * the one fixed command that renames the PC: nothing else can ever reach it.
 */

/** The only names the rename command is ever given. */
export const COMPUTER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,13}[A-Za-z0-9])?$/;

const RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'LOCALHOST', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);

export type NameCheck = { readonly ok: true; readonly name: string } | { readonly ok: false; readonly say: string; readonly suggestion: string | null };

/** The nearest allowed name to what was said ("Rakhi's PC" becomes "Rakhis-PC"), or null when nothing sensible is left or what was said is already fine. */
export function suggestComputerName(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^A-Za-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 15)
    .replace(/-$/, '');
  if (cleaned === '' || /^\d+$/.test(cleaned) || RESERVED.has(cleaned.toUpperCase()) || cleaned === raw.trim()) return null;
  return COMPUTER_NAME.test(cleaned) ? cleaned : null;
}

export function checkComputerName(raw: string): NameCheck {
  const name = raw.trim();
  const refuse = (say: string): NameCheck => {
    const suggestion = suggestComputerName(name);
    return { ok: false, say: suggestion === null ? say : `${say} How about ${suggestion}?`, suggestion };
  };
  if (name === '') return { ok: false, say: 'Tell me the name you want for this PC.', suggestion: null };
  if (name.length > 15) return refuse(`A PC name can have at most 15 characters, and "${name.slice(0, 40)}" has ${name.length}.`);
  if (!/^[A-Za-z0-9-]+$/.test(name)) return refuse('A PC name can only have letters, numbers and hyphens: no spaces or other marks.');
  if (/^-|-$/.test(name)) return refuse('A PC name cannot start or end with a hyphen.');
  if (/^\d+$/.test(name)) return { ok: false, say: 'A PC name cannot be only numbers: add a letter or two.', suggestion: null };
  if (RESERVED.has(name.toUpperCase())) return { ok: false, say: `Windows keeps "${name}" for itself: choose another name.`, suggestion: null };
  return COMPUTER_NAME.test(name) ? { ok: true, name } : refuse('That is not a name Windows accepts for a PC.');
}
