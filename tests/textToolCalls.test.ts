import { describe, expect, it } from 'vitest';
import { NUMBER_NOTE, phoneNumbersIn, unverifiedNumbers, withoutInventedNumbers } from '../src/main/agent/factGuard';
import { readTextToolCalls } from '../src/main/agent/textToolCalls';

/**
 * The reproduced conversation: a Groq model answered with `{"name":"clickonlink","parameters":{...}}` and `{"name":"getmessage",...}` as plain text,
 * and that was shown to the person as if it were the result; and, asked for Anna's number, it wrote "+1 800 234 5678" out of nowhere.
 */

const TOOLS = ['find_chat', 'attach_file', 'verify_sent', 'click_on_page', 'fill_on_page', 'open_website'];

describe('a tool call written as text', () => {
  it('is NOT run when it names a tool that does not exist (clickonlink, getmessage): it is invalid, never shown', () => {
    const a = readTextToolCalls('{"name":"clickonlink","parameters":{"text":"Send"}}', TOOLS);
    expect(a).toMatchObject({ kind: 'invalid' });
    expect(a.kind === 'invalid' && a.reason).toContain('"clickonlink"');
    expect(readTextToolCalls('{"name":"getmessage","parameters":{}}', TOOLS)).toMatchObject({ kind: 'invalid', names: ['getmessage'] });
  });

  it('is run as the real call when it is a registered tool (exact name, or the same name without underscores)', () => {
    expect(readTextToolCalls('{"name":"click_on_page","parameters":{"text":"Send"}}', TOOLS)).toEqual({ kind: 'calls', calls: [{ name: 'click_on_page', args: { text: 'Send' } }] });
    expect(readTextToolCalls('{"name":"clickonpage","arguments":{"text":"Send"}}', TOOLS)).toEqual({ kind: 'calls', calls: [{ name: 'click_on_page', args: { text: 'Send' } }] });
  });

  it('reads the other shapes models use: OpenAI style, a string of arguments, fences, tags, several calls', () => {
    expect(readTextToolCalls('{"type":"function","function":{"name":"find_chat","arguments":"{\\"query\\":\\"Anna\\"}"}}', TOOLS)).toEqual({ kind: 'calls', calls: [{ name: 'find_chat', args: { query: 'Anna' } }] });
    expect(readTextToolCalls('```json\n{"name":"find_chat","parameters":{"query":"Anna"}}\n```', TOOLS)).toMatchObject({ kind: 'calls' });
    expect(readTextToolCalls('<tool_call>{"name":"find_chat","arguments":{"query":"Anna"}}</tool_call>', TOOLS)).toMatchObject({ kind: 'calls' });
    expect(readTextToolCalls('<function=find_chat>{"query":"Anna"}</function>', TOOLS)).toEqual({ kind: 'calls', calls: [{ name: 'find_chat', args: { query: 'Anna' } }] });
    const several = readTextToolCalls('[{"name":"find_chat","parameters":{"query":"Anna"}},{"name":"verify_sent","parameters":{"text":"hi"}}]', TOOLS);
    expect(several.kind === 'calls' && several.calls.map((c) => c.name)).toEqual(['find_chat', 'verify_sent']);
    const lines = readTextToolCalls('{"name":"find_chat","parameters":{"query":"Anna"}}\n{"name":"verify_sent","parameters":{"text":"hi"}}', TOOLS);
    expect(lines.kind === 'calls' && lines.calls).toHaveLength(2);
  });

  it('one bad call among good ones makes the whole answer invalid: half of a plan is never run', () => {
    expect(readTextToolCalls('[{"name":"find_chat","parameters":{"query":"Anna"}},{"name":"getmessage","parameters":{}}]', TOOLS)).toMatchObject({ kind: 'invalid' });
  });

  it('is invalid (never shown) when it is cut short, or its arguments are not an object', () => {
    expect(readTextToolCalls('{"name":"find_chat","parameters":{"query":"Ann', TOOLS)).toMatchObject({ kind: 'invalid' });
    expect(readTextToolCalls('{"name":"find_chat","parameters":"not json"}', TOOLS)).toMatchObject({ kind: 'invalid' });
    expect(readTextToolCalls('{"name":"find_chat","parameters":[1,2]}', TOOLS)).toMatchObject({ kind: 'invalid' });
  });

  it('never guesses a name from a similar one', () => {
    expect(readTextToolCalls('{"name":"click_on_link","parameters":{}}', TOOLS)).toMatchObject({ kind: 'invalid' });
    expect(readTextToolCalls('{"name":"find","parameters":{}}', TOOLS)).toMatchObject({ kind: 'invalid' });
  });

  it('leaves ordinary answers alone, even when they mention JSON or tools', () => {
    for (const prose of [
      'Found Anna. Send the message "where are u" to this chat?',
      'I sent it. The tool find_chat said {"status":"opened"} earlier, which means it worked.',
      'Here is an example: {"name": "click_on_page"} is how a call looks, but I will use the tool directly.',
      '[1] First option, [2] second option',
      '',
      'Done.',
    ]) {
      expect(readTextToolCalls(prose, TOOLS).kind).toBe('prose');
    }
  });
});

describe('a phone number the model made up', () => {
  const sources = ['send msg to anna in whatsapp "where are u"', 'tool result: Found Anna, number ending in 678', 'Rahul: +91 98765 43210'];

  it('finds the numbers in an answer, and not dates, times or small figures', () => {
    expect(phoneNumbersIn("Anna's phone number is +1 800 234 5678.")).toEqual(['+1 800 234 5678']);
    expect(phoneNumbersIn('Call 98765 43210 now')).toEqual(['98765 43210']);
    expect(phoneNumbersIn('On 25/10/2026 at 10:41, the fee is ₹1,00,000 for 3 files.')).toEqual([]);
  });

  it('removes a number that is in nothing Eya had in front of her, and says so', () => {
    const r = withoutInventedNumbers("Anna's phone number is +1 800 234 5678.", sources);
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain('800');
    expect(r.text).toContain(NUMBER_NOTE);
  });

  it('keeps a number that really came from a contact, a page or the person (in any way of writing it)', () => {
    expect(withoutInventedNumbers("Rahul's number is +91 98765 43210.", sources)).toEqual({ text: "Rahul's number is +91 98765 43210.", removed: 0 });
    expect(withoutInventedNumbers('That is 9876543210.', sources).removed).toBe(0);
    expect(unverifiedNumbers('You said 9999988888', ['you said 9999988888'])).toEqual([]);
  });

  it('leaves an answer with no number untouched', () => {
    expect(withoutInventedNumbers('I found Anna. Which one do you mean?', sources)).toEqual({ text: 'I found Anna. Which one do you mean?', removed: 0 });
  });
});
