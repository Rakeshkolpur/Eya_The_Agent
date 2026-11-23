import { describe, it, expect } from 'vitest';
import { checkDocument, checkParagraph, formatIndian, wordsToNumber } from '../src/main/writing/checks';

const kinds = (text: string): string[] => checkParagraph(text).map((f) => f.kind);
const messages = (text: string): string[] => checkParagraph(text).map((f) => f.message);

describe('slips inside a paragraph', () => {
  it('a word written twice in a row, with the fix', () => {
    const [f] = checkParagraph('The Petitioner humbly submits that the the order is illegal.');
    expect(f).toMatchObject({ kind: 'repeated_word', message: '"the" is written twice in a row', replace: { from: 'the the', to: 'the' } });
    expect(checkParagraph('The The Court')[0]?.replace).toEqual({ from: 'The The', to: 'The' });
  });

  it('but not the pairs that are good English', () => {
    expect(kinds('She said that that was enough, and he had had enough.')).toEqual([]);
    expect(kinds('This is the order. The order is final.')).toEqual([]);
  });

  it('two spaces between words — not three (layout), not after a full stop (a habit), not in an aligned signature block', () => {
    expect(checkParagraph('The  Court may')[0]).toMatchObject({ kind: 'spacing', replace: { from: 'e  C', to: 'e C' } });
    expect(kinds('Place:   Hyderabad')).toEqual([]);
    expect(kinds('It is so.  The Court agrees.')).toEqual([]);
    expect(kinds('Petitioner      Respondent')).toEqual([]);
  });

  it('a space before a comma or full stop, and a missing one after', () => {
    expect(checkParagraph('The Court , however')[0]).toMatchObject({ kind: 'punctuation', replace: { from: 't ,', to: 't,' } });
    expect(checkParagraph('before the Court,the matter')[0]).toMatchObject({ message: 'No space after the comma', replace: { from: 'rt,th', to: 'rt, th' } });
    expect(checkParagraph('as held by the Court.The petitioner')[0]).toMatchObject({ message: 'No space after the full stop', replace: { from: 'Court.The', to: 'Court. The' } });
  });

  it('leaves addresses, numbers and abbreviations alone', () => {
    expect(kinds('write to advocate,x@example.com or visit www.Example.Com/Page')).toEqual([]);
    expect(kinds('Rs. 5,00,000/- paid on 12.03.2026, at 10:30, vide Sl. No. 5.')).toEqual([]);
    expect(kinds('W.P.No.12345 of 2026 before the Hon.Court')).not.toContain('punctuation'); // "Hon." is an abbreviation
  });

  it('brackets and quotation marks that are not closed — but not a list marker', () => {
    expect(messages('The sum (as stated in the order was paid.')).toEqual(['A bracket "(" is opened but never closed']);
    expect(messages('as stated) in the order')).toEqual(['A bracket ")" has no matching "("']);
    expect(kinds('a) The petitioner is an advocate.')).toEqual([]);
    expect(kinds('1) The facts are as follows (see Annexure P-1).')).toEqual([]);
    expect(kinds('He said "the order is final.')).toEqual(['quotes']);
    expect(kinds('He said “the order is final.')).toEqual(['quotes']);
    expect(kinds('He said "the order is final".')).toEqual([]);
  });

  it('a sentence that begins with a small letter, and the pronoun I — but not after an abbreviation', () => {
    expect(checkParagraph('The order was passed. the Petitioner appealed.')[0]).toMatchObject({ kind: 'capital', replace: { from: '. the', to: '. The' } });
    expect(kinds('See Sl. No. 4 and Rs. five thousand, i.e. the sum, etc. and so on, vs. the State, W.P. no. of the year, Dr. kumar.')).toEqual([]);
    expect(checkParagraph('Then i went to the Court')[0]).toMatchObject({ message: 'The word "I" should be a capital letter', replace: { from: ' i', to: ' I' } });
    expect(kinds('under clause (i) and (ii), i. e. the first')).toEqual([]);
  });

  it('a date that does not exist, in numbers or in words', () => {
    expect(messages('dated 31.02.2026')).toEqual(['31.02.2026 is not a real date (day, month, year)']);
    expect(kinds('dated 29/02/2024')).toEqual([]); // 2024 is a leap year
    expect(kinds('dated 29/02/2026')).toEqual(['date']);
    expect(kinds('on 15-13-2025')).toEqual(['date']);
    expect(messages('on the 31st day of April 2026').length).toBe(0); // "31st day of April" is not the pattern; no guess
    expect(kinds('on 31st April 2026')).toEqual(['date']);
    expect(kinds('on 30th April 2026 and 1st May 2026')).toEqual([]);
  });

  it('the wrong ending on a number, and the letter O for a zero', () => {
    expect(checkParagraph('the 22th day and the 3th')[0]).toMatchObject({ kind: 'number', message: '"22th" should be "22nd"', replace: { from: '22th', to: '22nd' } });
    expect(kinds('the 11th, 12th, 13th, 21st, 2nd, 3rd, 4th')).toEqual([]);
    expect(checkParagraph('W.P. No. 12345 of 2O26')[0]).toMatchObject({ kind: 'number', replace: { from: '2O26', to: '2026' } });
    expect(kinds('in 2026 for 100 men and Oxford Road, 1000 O')).toEqual([]);
  });

  it('an amount whose figures and words disagree — in the Indian way of writing numbers', () => {
    const [f] = checkParagraph('a sum of Rs. 5,00,000/- (Rupees five lakh fifty thousand only) was paid');
    expect(f).toMatchObject({ kind: 'amount', message: 'The figures say 5,00,000 but the words say 5,50,000 ("five lakh fifty thousand")' });
    expect(kinds('Rs. 5,50,000/- (Rupees five lakh fifty thousand only)')).toEqual([]);
    expect(kinds('₹ 1,25,00,000 (Rupees one crore twenty five lakh only)')).toEqual([]);
    expect(kinds('Rs. 2,000/- (Rupees two thousand only)')).toEqual([]);
    expect(kinds('Rs. 2,500 (Rupees two thousand five hundred only)')).toEqual([]);
    expect(kinds('Rs. 2,500 (Rupees two thousand six hundred only)')).toEqual(['amount']);
    expect(kinds('Rs. 5,000/- (see the receipt at Annexure P-3)')).toEqual([]); // not an amount in words: nothing is judged
  });
});

describe('numbers in words', () => {
  it('reads Indian amounts', () => {
    expect(wordsToNumber('five lakh fifty thousand only')).toBe(550000);
    expect(wordsToNumber('Rupees one crore twenty-five lakh')).toBe(12500000);
    expect(wordsToNumber('one hundred and fifty')).toBe(150);
    expect(wordsToNumber('two thousand five hundred')).toBe(2500);
    expect(wordsToNumber('a lakh')).toBeNull(); // anything it does not know is not judged
    expect(wordsToNumber('')).toBeNull();
  });
  it('writes Indian grouping', () => {
    expect(formatIndian(550000)).toBe('5,50,000');
    expect(formatIndian(12500000)).toBe('1,25,00,000');
    expect(formatIndian(999)).toBe('999');
    expect(formatIndian(1000)).toBe('1,000');
  });
});

describe('slips across the whole draft', () => {
  const draft = [
    'IN THE HIGH COURT',
    'W.P. No. 12345 of 2026',
    '1. Raghavendra is the Petitioner and the Petitioner states that Raghavendra was appointed.',
    '2. The Petitioner states that Raghavendra served well.',
    '3. Raghavedra then moved the Court, and the petitioner prays for relief as in W.P. No. 12354 of 2026.',
    '5. The Petitioner submits as in W.P. No. 12345 of 2026.',
    '5. The Petitioner again submits W.P. No. 12345 of 2026, and the Petitioner prays.',
  ];

  it('a name written once that looks like a typo of one written many times', () => {
    const found = checkDocument(draft).filter((f) => f.kind === 'name');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ paragraph: 5, message: '"Raghavedra" is written once, but "Raghavendra" is written 3 times — is it a typo?', replace: { from: 'Raghavedra', to: 'Raghavendra' } });
  });

  it('is cautious with plain words: a plural, or a real word, is not a typo', () => {
    const plural = ['The Respondent said.', 'The Respondent was heard.', 'The Respondent left.', 'The Respondents agreed.'];
    expect(checkDocument(plural).filter((f) => f.kind === 'name')).toEqual([]);
    const realWord = ['Section Section Section is there', 'And the Selection was made'];
    expect(checkDocument(realWord, { isMisspelled: (w) => w !== 'Selection' }).filter((f) => f.kind === 'name')).toEqual([]);
    expect(checkDocument(realWord).filter((f) => f.kind === 'name')).toHaveLength(0); // with no dictionary a two-letter difference is not called a typo
  });

  it('with a spell checker, a name is doubted only if the checker doubts it too', () => {
    const lines = ['Raghavendra', 'Raghavendra', 'Raghavendra', 'Raghavedra'];
    expect(checkDocument(lines, { isMisspelled: () => true }).filter((f) => f.kind === 'name')).toHaveLength(1);
    expect(checkDocument(lines, { isMisspelled: () => false }).filter((f) => f.kind === 'name')).toHaveLength(0);
  });

  it('a case number that differs by a digit from one used several times', () => {
    const found = checkDocument(draft).filter((f) => f.kind === 'case_number');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ paragraph: 5, replace: { from: 'W.P. No. 12354 of 2026', to: 'W.P. No. 12345 of 2026' } });
  });

  it('paragraph numbers that jump, repeat or go back', () => {
    const found = checkDocument(draft).filter((f) => f.kind === 'numbering');
    expect(found.map((f) => f.message)).toEqual(['The paragraph numbers jump from 3 to 5', 'Paragraph number 5 is used twice']);
    expect(checkDocument(['1. a x', '2. b x', '3. c x', '4. d x']).filter((f) => f.kind === 'numbering')).toEqual([]);
    expect(checkDocument(['1. a x', '2. b x', '1. c x', '2. d x']).filter((f) => f.kind === 'numbering')).toEqual([]); // a new list
    expect(checkDocument(['1. a x', '3. b x']).filter((f) => f.kind === 'numbering')).toEqual([]); // too short to judge
  });

  it('a party written with a small letter in a draft that capitalises it', () => {
    const found = checkDocument(draft).filter((f) => f.kind === 'term');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ paragraph: 5, replace: { from: 'petitioner', to: 'Petitioner' } });
    expect(checkDocument(['the petitioner', 'the petitioner']).filter((f) => f.kind === 'term')).toEqual([]); // consistently small: fine
  });
});
