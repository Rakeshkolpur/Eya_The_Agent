/**
 * The page of the small suggestion card. It is a single self-contained document (no files, no network), and everything it shows that
 * came from the user's document is put on the page as TEXT, never as HTML — a document can contain anything, and it must not be able to
 * run or style anything here.
 */
export const CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Eya</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; background: transparent; overflow: hidden; font: 13px/1.4 "Segoe UI", system-ui, sans-serif; color: #e6eefc; user-select: none; }
  #root { padding: 8px; }
  .card { background: rgba(10, 24, 48, 0.97); border: 1px solid #2b4170; border-radius: 14px; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45); overflow: hidden; }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #4c8dff; flex: none; }
  .head b { font-weight: 600; }
  .head .count { margin-left: auto; color: #8da4cf; font-size: 12px; }
  .list { max-height: 330px; overflow-y: auto; }
  .list::-webkit-scrollbar { width: 8px; }
  .list::-webkit-scrollbar-thumb { background: #2b4170; border-radius: 8px; }
  .item { padding: 8px 12px 10px; border-top: 1px solid #1d3157; }
  .chip { display: inline-block; font-size: 11px; color: #9ec2ff; background: #14305f; border-radius: 999px; padding: 1px 8px; margin-bottom: 4px; }
  .msg { margin: 0 0 6px; }
  .excerpt { margin: 0 0 8px; padding: 5px 8px; border-radius: 8px; background: #0a1a36; color: #c4d4f0; font: 12px/1.4 Consolas, "Cascadia Mono", monospace; word-break: break-word; }
  .excerpt del { color: #ff9b9b; text-decoration-thickness: 1.5px; }
  .excerpt ins { color: #8fe3a5; text-decoration: none; font-weight: 600; }
  .row { display: flex; gap: 8px; }
  button { font: inherit; border-radius: 8px; border: 1px solid #36508a; background: transparent; color: #e6eefc; padding: 3px 12px; cursor: pointer; }
  button:hover { background: #162a50; }
  button.primary { background: #3b79e8; border-color: #3b79e8; color: #fff; }
  button.primary:hover { background: #4c8dff; }
  button:disabled { opacity: 0.5; cursor: default; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 6px 12px 9px; border-top: 1px solid #1d3157; color: #8da4cf; font-size: 11.5px; }
  .foot span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  .foot button { padding: 1px 9px; font-size: 11.5px; }
</style>
</head>
<body>
<div id="root"></div>
<script>
  var root = document.getElementById('root');
  var KINDS = { repeated_word: 'Repeated word', spacing: 'Spacing', punctuation: 'Punctuation', brackets: 'Brackets', quotes: 'Quotation marks', capital: 'Capital letter', date: 'Date', number: 'Number', amount: 'Amount', name: 'Name', case_number: 'Case number', numbering: 'Paragraph numbers', term: 'Wording', spelling: 'Spelling', ai: 'Gemini' };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function short(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function render(state) {
    root.textContent = '';
    if (!state || !state.findings || state.findings.length === 0) return;
    var card = el('div', 'card');
    var head = el('div', 'head');
    head.append(el('span', 'dot'), el('b', null, 'Eya noticed'), el('span', 'count', state.findings.length + (state.more > 0 ? ' + ' + state.more + ' more' : '') + ' to look at'));
    card.append(head);
    var list = el('div', 'list');
    state.findings.forEach(function (f) {
      var item = el('div', 'item');
      item.append(el('div', 'chip', (KINDS[f.kind] || 'Note') + ' · paragraph ' + f.paragraph));
      item.append(el('p', 'msg', short(f.message, 240)));
      var ex = el('p', 'excerpt');
      if (f.replace) { ex.append(el('del', null, short(f.replace.from, 90)), document.createTextNode('  →  '), el('ins', null, short(f.replace.to, 90))); }
      else { ex.textContent = short(f.excerpt, 140); }
      item.append(ex);
      var row = el('div', 'row');
      if (f.canFix) {
        var fix = el('button', 'primary', 'Fix');
        fix.addEventListener('click', function () { fix.disabled = true; window.eyaCard.act(f.id, 'fix'); });
        row.append(fix);
      }
      var ignore = el('button', null, 'Ignore');
      ignore.addEventListener('click', function () { ignore.disabled = true; window.eyaCard.act(f.id, 'ignore'); });
      row.append(ignore);
      item.append(row);
      list.append(item);
    });
    card.append(list);
    var foot = el('div', 'foot');
    var where = 'Watching ' + (state.source || 'your writing') + (state.title ? ' · ' + short(state.title, 28) : '') + (state.cloudAllowed ? ' · Gemini check on' : ' · on this PC only');
    foot.append(el('span', null, where));
    var hide = el('button', null, 'Hide');
    hide.addEventListener('click', function () { window.eyaCard.hide(); });
    foot.append(hide);
    card.append(foot);
    root.append(card);
    window.eyaCard.size(Math.ceil(card.getBoundingClientRect().height) + 16);
  }
  window.eyaCard.onState(render);
  window.eyaCard.ready();
</script>
</body>
</html>`;
