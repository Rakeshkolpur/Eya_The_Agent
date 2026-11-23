// Run:  node tests/live/analyze-trace.mjs <trace.jsonl>
// Reads a trace written with EYA_TRACE_FILE (see src/main/agent/trace.ts) and says where the AI calls, the tokens and the time went.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  console.log('usage: node tests/live/analyze-trace.mjs <trace.jsonl>');
  process.exit(1);
}
const events = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const at = (e) => Date.parse(e.at);
const t0 = events.length > 0 ? at(events[0]) : 0;
const sec = (e) => ((at(e) - t0) / 1000).toFixed(1).padStart(6);
const pad = (v, n) => String(v).padStart(n);

const requests = events.filter((e) => e.kind === 'ai-request');
const responses = events.filter((e) => e.kind === 'ai-response');
const errors = events.filter((e) => e.kind === 'ai-error');
const usages = events.filter((e) => e.kind === 'usage');
const toolCalls = events.filter((e) => e.kind === 'tool-call');
const toolResults = events.filter((e) => e.kind === 'tool-result');

console.log(`events: ${events.length}, span ${((at(events[events.length - 1] ?? events[0]) - t0) / 1000).toFixed(1)} s`);
console.log(`AI requests sent: ${requests.length}   answered: ${responses.length}   failed: ${errors.length}   usage reports: ${usages.length}`);

// ---- per AI call
console.log('\n#  t(s)  what was sent (chars: system + tools + messages = approx tokens)   tools  msgs | answer after  | usage (provider prompt+answer=total, cached)');
let answered = 0;
requests.forEach((r, i) => {
  const next = [...responses, ...errors].find((x) => at(x) >= at(r) && !x.__used);
  if (next) next.__used = true;
  const u = usages.find((x) => at(x) >= at(r) && !x.__used);
  if (u) u.__used = true;
  const chars = (r.systemChars ?? 0) + (r.toolChars ?? 0) + (r.messageChars ?? 0);
  const answer = next === undefined ? '(none)' : next.kind === 'ai-error' ? `ERROR ${(next.error ?? '').slice(0, 50)}` : `${(next.toolCalls ?? []).map((c) => c.name).join(',') || 'text'}`;
  console.log(`${pad(i + 1, 2)} ${sec(r)}  ${pad(r.systemChars, 6)} + ${pad(r.toolChars, 6)} + ${pad(r.messageChars ?? 0, 6)} = ~${pad(Math.round(chars / 4), 6)}   ${pad((r.tools ?? []).length, 3)}  ${pad(r.messages ?? 0, 3)}  | ${pad(next?.ms ?? '?', 6)} ms ${answer.slice(0, 44).padEnd(44)} | ${u ? `${u.provider} ${u.prompt}+${u.completion}=${u.total}${u.cached ? ` (cached ${u.cached})` : ''}` : 'no usage reported'}`);
  if (next?.kind !== 'ai-error') answered += 1;
});

// ---- totals
const sum = (xs, f) => xs.reduce((n, x) => n + f(x), 0);
const byProvider = new Map();
for (const u of usages) {
  const v = byProvider.get(u.provider) ?? { n: 0, prompt: 0, completion: 0, total: 0, cached: 0 };
  v.n += 1; v.prompt += u.prompt; v.completion += u.completion; v.total += u.total; v.cached += u.cached;
  byProvider.set(u.provider, v);
}
console.log('\nUSAGE BY WHO (what the providers reported)');
for (const [p, v] of byProvider) console.log(`  ${p.padEnd(12)} ${pad(v.n, 3)} answers  prompt ${pad(v.prompt, 7)}  answer ${pad(v.completion, 6)}  total ${pad(v.total, 7)}  cached ${v.cached}`);
console.log(`  ALL          ${pad(usages.length, 3)} answers  prompt ${pad(sum(usages, (u) => u.prompt), 7)}  answer ${pad(sum(usages, (u) => u.completion), 6)}  total ${pad(sum(usages, (u) => u.total), 7)}  cached ${sum(usages, (u) => u.cached)}`);
for (const e of events.filter((x) => x.kind === 'tokens')) console.log(`  the app's per-request count: ${e.total} (${e.prompt} + ${e.completion}) over ${e.calls} answers  ${JSON.stringify(e.byProvider)}`);

// ---- what the first request held (the same instructions go with every step)
const first = requests[0];
if (first) console.log(`\nEVERY call carries: instructions ${first.systemChars} chars + ${(first.tools ?? []).length} tool descriptions ${first.toolChars} chars (~${Math.round(((first.systemChars ?? 0) + (first.toolChars ?? 0)) / 4)} tokens) before any conversation`);

// ---- the tools
console.log('\nTOOL CALLS (in order)');
const results = new Map();
toolResults.forEach((r) => { const list = results.get(r.name) ?? []; list.push(r); results.set(r.name, list); });
const seen = new Map();
const used = new Map();
toolCalls.forEach((c, i) => {
  const list = results.get(c.name) ?? [];
  const k = used.get(c.name) ?? 0;
  used.set(c.name, k + 1);
  const r = list[k];
  const key = `${c.name} ${c.args}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
  console.log(`${pad(i + 1, 3)} ${sec(c)}  ${c.name.padEnd(22)} ${pad(r?.ms ?? '?', 6)} ms  ${r ? (r.ok ? 'ok  ' : 'FAIL') : '?   '} ${String(c.args).slice(0, 70)}${r && !r.ok ? '  → ' + String(r.error ?? r.summary ?? '').slice(0, 70) : ''}`);
});
const repeats = [...seen].filter(([, n]) => n > 1);
console.log(`\nREPEATED identical tool calls: ${repeats.length === 0 ? 'none' : repeats.map(([k, n]) => `${n}x ${k.slice(0, 80)}`).join(' | ')}`);
const toolMs = sum(toolResults, (r) => r.ms ?? 0);
const aiMs = sum(responses, (r) => r.ms ?? 0) + sum(errors, (r) => r.ms ?? 0);
console.log(`TIME: AI answers ${(aiMs / 1000).toFixed(1)} s, tools ${(toolMs / 1000).toFixed(1)} s (the rest is Eya's own steps and waiting)`);
console.log(`AI errors: ${errors.length === 0 ? 'none' : errors.map((e) => `${e.ms}ms ${(e.error ?? '').slice(0, 90)}`).join(' | ')}`);
