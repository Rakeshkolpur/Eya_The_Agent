/**
 * Some models (Llama on Groq, small local ones) write a tool call as plain TEXT in their answer instead of using the service's tool-calling
 * channel — `{"name":"clickonlink","parameters":{...}}`. The providers hand that back as the answer, and without a check it was shown to the
 * person as the result of their request. This reads such an answer and says which of three things it is:
 *
 *   - prose: an ordinary answer. Left alone.
 *   - calls: the WHOLE answer is nothing but calls, and every one names a tool that is registered (the exact name, or the same name written
 *     without its underscores or in another case: `clickonpage` for `click_on_page`). They are returned as real calls, and go through the same
 *     dispatcher, argument checks and send gates as any other call.
 *   - invalid: it is written as a call but cannot be run (a tool that does not exist, an unfinished piece of JSON). It is never shown as an
 *     answer and never run; the model is told what was wrong, and if it keeps doing it the person is told honestly that nothing was done.
 *
 * Nothing inside ordinary prose is ever run: a JSON example in the middle of a sentence is prose. And a name is never GUESSED from a similar
 * one — `clickonlink` is not `click_on_page`.
 */

export interface TextCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type TextCallVerdict =
  | { readonly kind: 'prose' }
  | { readonly kind: 'calls'; readonly calls: readonly TextCall[] }
  | { readonly kind: 'invalid'; readonly reason: string; readonly names: readonly string[] };

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Fences and wrappers the models put around a call: ```json … ```, <tool_call> … </tool_call>, <|python_tag|>, [TOOL_CALLS]. */
function unwrap(text: string): string {
  let t = text.trim();
  t = t.replace(/^<\|python_tag\|>/i, '').replace(/^\[TOOL_CALLS\]/i, '').trim();
  const fence = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence?.[1] !== undefined) t = fence[1].trim();
  const tagged = /^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i.exec(t);
  if (tagged?.[1] !== undefined) t = tagged[1].trim();
  return t;
}

/** The pieces of JSON that make up the text, if the text is nothing but JSON values (one, an array, or several one after another). */
function jsonPieces(text: string): unknown[] | null {
  const t = text.trim();
  if (t === '' || (t[0] !== '{' && t[0] !== '[')) return null;
  try {
    const whole: unknown = JSON.parse(t);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // several objects one after another ("{...}\n{...}" or "{...}; {...}")
  }
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(t.slice(start, i + 1)));
        } catch {
          return null;
        }
        start = -1;
      }
    } else if (depth === 0 && !/[\s;,]/.test(c)) return null; // something else between the objects: prose
  }
  return depth === 0 && out.length > 0 ? out : null;
}

const NAME_KEYS = ['name', 'tool', 'tool_name', 'function_name', 'action'] as const;
const ARG_KEYS = ['parameters', 'arguments', 'args', 'input', 'params'] as const;

/** One value as a call: `{name, parameters}`, `{function:{name, arguments}}`, `{tool, args}`. Null when it is not shaped like one. */
function asCall(value: unknown): { readonly name: string; readonly args: Record<string, unknown> | null } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const inner = typeof v['function'] === 'object' && v['function'] !== null && !Array.isArray(v['function']) ? (v['function'] as Record<string, unknown>) : null;
  const source = inner ?? v;
  const nameKey = NAME_KEYS.find((k) => typeof source[k] === 'string');
  if (nameKey === undefined) return null;
  const name = (source[nameKey] as string).trim();
  if (name === '' || name.length > 80 || /\s/.test(name)) return null;
  const argKey = ARG_KEYS.find((k) => source[k] !== undefined) ?? ARG_KEYS.find((k) => v[k] !== undefined);
  // a lone {"name": "..."} is just an object with a name in it: a call has arguments (even empty ones), or says it is a function call
  if (argKey === undefined && inner === null && v['type'] !== 'function') return null;
  const raw = argKey === undefined ? {} : (source[argKey] ?? v[argKey]);
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { name, args: {} };
    try {
      const parsed: unknown = JSON.parse(raw);
      return { name, args: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null };
    } catch {
      return { name, args: null };
    }
  }
  if (raw === null || raw === undefined) return { name, args: {} };
  return typeof raw === 'object' && !Array.isArray(raw) ? { name, args: raw as Record<string, unknown> } : { name, args: null };
}

/** `<function=click_on_page>{"text":"Send"}</function>` (Llama's own text format). */
function functionTags(text: string): Array<{ name: string; body: string }> | null {
  const t = text.trim();
  const re = /<function=([A-Za-z0-9_.-]+)>\s*([\s\S]*?)\s*<\/function>/gy;
  const out: Array<{ name: string; body: string }> = [];
  let consumed = 0;
  for (let m = re.exec(t); m !== null; m = re.exec(t)) {
    out.push({ name: m[1] as string, body: m[2] as string });
    consumed = re.lastIndex;
    while (/\s/.test(t[consumed] ?? '')) consumed += 1;
    re.lastIndex = consumed;
  }
  return out.length > 0 && consumed >= t.length ? out : null;
}

const LOOKS_LIKE_CALL = /^\s*(?:<\|python_tag\|>|\[TOOL_CALLS\]|<tool_call>|<function=|```(?:json)?\s*[\[{]|[\[{]\s*"?(?:name|tool|tool_name|function|function_name|action|type)"?\s*:)/i;

/**
 * What an answer is (see the top of this file). `registered` are the tools the model was offered in this request.
 */
export function readTextToolCalls(text: string, registered: readonly string[]): TextCallVerdict {
  const body = unwrap(text);
  if (body === '') return { kind: 'prose' };
  const byCanon = new Map<string, string[]>();
  for (const name of registered) byCanon.set(canon(name), [...(byCanon.get(canon(name)) ?? []), name]);
  const resolve = (name: string): string | null => {
    if (registered.includes(name)) return name;
    const same = byCanon.get(canon(name));
    return same !== undefined && same.length === 1 ? (same[0] as string) : null;
  };

  const tags = functionTags(body);
  const pieces = tags === null ? jsonPieces(body) : null;
  if (tags === null && pieces === null) {
    // Not a clean run of calls. If it STARTS like a call it is a broken one (cut short, quote missing): never shown, never run.
    // Anything else is prose, whatever it mentions.
    return LOOKS_LIKE_CALL.test(text) ? { kind: 'invalid', reason: 'it starts like a tool call but is not complete valid JSON', names: [] } : { kind: 'prose' };
  }

  const wanted: Array<{ name: string; args: Record<string, unknown> | null }> = [];
  if (tags !== null) {
    for (const t of tags) {
      const parsed = jsonPieces(t.body);
      const first = parsed?.[0];
      wanted.push({ name: t.name, args: t.body.trim() === '' ? {} : typeof first === 'object' && first !== null && !Array.isArray(first) ? (first as Record<string, unknown>) : null });
    }
  } else {
    for (const piece of pieces as unknown[]) {
      const call = asCall(piece);
      // A JSON answer that is not shaped like a call at all ({"answer": "yes"}) is prose.
      if (call === null) return LOOKS_LIKE_CALL.test(text) ? { kind: 'invalid', reason: 'it is written like a tool call but has no tool name and arguments', names: [] } : { kind: 'prose' };
      wanted.push(call);
    }
  }

  const calls: TextCall[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const name = resolve(w.name);
    if (name === null) {
      unknown.push(w.name);
      continue;
    }
    if (w.args === null) return { kind: 'invalid', reason: `the arguments of ${name} are not a JSON object`, names: [name] };
    calls.push({ name, args: w.args });
  }
  if (unknown.length > 0) return { kind: 'invalid', reason: `${unknown.map((n) => `"${n}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not ${unknown.length === 1 ? 'a tool' : 'tools'} I have`, names: unknown };
  return calls.length > 0 ? { kind: 'calls', calls } : { kind: 'prose' };
}
