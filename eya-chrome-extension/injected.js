/**
 * The part of Eya that runs INSIDE a web page.
 *
 * The service worker injects this with `chrome.scripting.executeScript({ func })`,
 * which serialises the function's source text — so everything it needs must
 * live inside it (no imports, no module-level helpers). One function, several
 * commands, one persistent bit of state per page (`globalThis.__eyaAgentState`,
 * in the extension's own isolated world, invisible to the page's scripts).
 *
 * Commands: observe | click | fill | press | waitQuiet | extractSearch.
 *
 * What it will never do, on purpose:
 *  - report the value of a password / card / one-time-code field, or any
 *    cookie, storage entry or token (it never reads those at all);
 *  - type into a password / card / one-time-code field;
 *  - touch a CAPTCHA, MFA or bot-check widget — it only *notices* one and says so.
 */
export async function eyaPageAgent(command, params) {
  'use strict';

  const STATE_KEY = '__eyaAgentState';
  const MAX_NODES = 40000;
  const MAX_CURSOR_CHECKS = 6000;
  const MAX_NAME = 100;
  const MAX_HIDDEN = 200;
  const MAX_BODY_TEXT = 40000;

  const state = (globalThis[STATE_KEY] ??= {
    epoch: 0,
    elements: new Map(),
    lastMutationAt: Date.now(),
    observer: null,
  });

  // ---------------------------------------------------------------- helpers
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const clip = (s, n) => {
    const t = norm(s);
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Page text that must never reach the model or be typed into by Eya.
  const SENSITIVE_NAME = /pass(word|code|phrase)|\bpin\b|cvv|cvc|card number|credit card|security code|one[- ]time|\botp\b|verification code|2fa|authenticator/i;

  // Elements inside a same-origin frame belong to that frame's own JavaScript
  // realm, so `instanceof Element` / `instanceof HTMLInputElement` is false for
  // them — compare tag names and node types instead.
  const isElement = (el) => el !== null && typeof el === 'object' && el.nodeType === 1;
  const realmOf = (el) => el.ownerDocument.defaultView;

  function isSensitiveField(el, name) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(cc-|one-time-code|current-password|new-password)/.test(ac)) return true;
    return SENSITIVE_NAME.test(name || '');
  }

  function isVisible(el) {
    if (!isElement(el)) return false;
    if (el.closest('[inert]') !== null) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    } else {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textById(el, ids) {
    const root = el.getRootNode();
    return ids
      .split(/\s+/)
      .map((id) => {
        const target = root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
        return target ? norm(target.textContent) : '';
      })
      .filter(Boolean)
      .join(' ');
  }

  /**
   * A label's own words. A label that WRAPS its control ("Year <select>…") would
   * otherwise contribute the control's text too — every option of a drop-down.
   */
  function labelTextWithoutControls(label) {
    const copy = label.cloneNode(true);
    copy.querySelectorAll('input, select, textarea, button, option').forEach((n) => n.remove());
    return norm(copy.textContent);
  }

  /** What a person looking at the control would call it. */
  function accName(el) {
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = textById(el, labelledBy);
      if (t) return t;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'INPUT' && (type === 'submit' || type === 'button' || type === 'reset')) {
        return norm(el.value) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
      }
      if (tag === 'INPUT' && type === 'image') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
      if (el.labels && el.labels.length > 0) {
        const t = norm(Array.from(el.labels).map((l) => labelTextWithoutControls(l)).join(' '));
        if (t) return t;
      }
      return (
        norm(el.getAttribute('placeholder')) ||
        norm(el.getAttribute('title')) ||
        norm(el.getAttribute('name')) ||
        norm(el.id)
      );
    }
    const text = norm(el.innerText ?? el.textContent);
    if (text) return text;
    const title = norm(el.getAttribute('title'));
    if (title) return title;
    const img = el.querySelector('img[alt]');
    if (img && norm(img.getAttribute('alt'))) return norm(img.getAttribute('alt'));
    const svgTitle = el.querySelector('svg title');
    if (svgTitle && norm(svgTitle.textContent)) return norm(svgTitle.textContent);
    const href = el.getAttribute('href');
    return href ? '' : '';
  }

  const INTERACTIVE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, label[for], ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
    '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], ' +
    '[role="searchbox"], [role="textbox"], [contenteditable=""], [contenteditable="true"], ' +
    '[tabindex]:not([tabindex="-1"]), [onclick]';

  function roleOf(el) {
    const explicit = (el.getAttribute('role') || '').toLowerCase();
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'input';
    if (tag === 'SUMMARY') return 'button';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'LABEL') return 'clickable';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'file') return 'file';
      return 'input';
    }
    if (['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option'].includes(explicit)) {
      return explicit === 'menuitemcheckbox' || explicit === 'menuitemradio' ? 'menuitem' : explicit;
    }
    if (['combobox', 'searchbox', 'textbox'].includes(explicit)) return 'input';
    if (el.isContentEditable) return 'input';
    return 'clickable';
  }

  function regionOf(el) {
    if (el.closest('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')) return 'dialog';
    if (el.closest('nav, [role="navigation"]')) return 'nav';
    if (el.closest('header, [role="banner"]')) return 'header';
    if (el.closest('footer, [role="contentinfo"]')) return 'footer';
    if (el.closest('main, [role="main"]')) return 'main';
    // Plenty of sites (especially older or hand-built ones) have no landmark elements at all, only class names.
    // Header and footer are recognised by those, so a site-wide top bar still counts as the site's frame.
    let a = el.parentElement;
    for (let i = 0; a && i < 10; i++, a = a.parentElement) {
      const hint = `${typeof a.className === 'string' ? a.className : ''} ${a.id || ''}`.toLowerCase();
      if (hint.trim() === '') continue;
      if (/(^|[\s_-])(footer|site-footer|page-footer|bottom-bar)($|[\s_-])/.test(hint)) return 'footer';
      if (/(^|[\s_-])(header|site-header|page-header|navbar|nav-bar|topbar|top-bar|masthead|menubar)($|[\s_-])/.test(hint)) return 'header';
    }
    return '';
  }

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  }

  // Is this element part of a navigation menu (as opposed to some other hidden thing: a template, an offscreen copy)?
  const MENU_WORDS = /menu|dropdown|drop-down|submenu|sub-menu|mega|flyout|nav/i;
  function inMenuContext(el) {
    if (el.closest('nav, [role="menu"], [role="menubar"], [role="navigation"]')) return true;
    let a = el.parentElement;
    for (let i = 0; a && i < 6; i++, a = a.parentElement) {
      const cls = typeof a.className === 'string' ? a.className : '';
      if (MENU_WORDS.test(`${cls} ${a.id || ''}`)) return true;
    }
    return false;
  }

  /** The visible menu title a closed menu item belongs under ("Services" for the Cause List link inside it). */
  function menuLabelOf(el) {
    let a = el.parentElement;
    for (let depth = 0; a && depth < 6; depth++, a = a.parentElement) {
      const prev = a.previousElementSibling;
      if (prev && isVisible(prev)) {
        const t = clip(prev.innerText, 40);
        if (t) return t;
      }
      const holder = a.parentElement;
      if (holder) {
        for (const c of holder.children) {
          if (c === a || c.contains(el)) continue;
          if (c.matches('a, button, span, [role="button"], [aria-haspopup]') && isVisible(c)) {
            const t = clip(c.innerText, 40);
            if (t) return t;
          }
        }
      }
    }
    return '';
  }

  /** Every element in the page: the document, open shadow roots, and same-origin frames. */
  function allElements() {
    const out = [];
    let crossOriginFrames = 0;
    let budget = MAX_NODES;
    const scan = (root, inFrame) => {
      const els = root.querySelectorAll('*');
      for (const el of els) {
        if (budget-- <= 0) return;
        out.push([el, inFrame]);
        if (el.shadowRoot) scan(el.shadowRoot, inFrame);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          let doc = null;
          try {
            doc = el.contentDocument;
          } catch {
            doc = null;
          }
          if (doc && doc.documentElement) scan(doc, true);
          else crossOriginFrames++;
        }
      }
    };
    scan(document, false);
    return { out, crossOriginFrames };
  }

  function redactUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      return `${u.origin}${u.pathname}`.slice(0, 160);
    } catch {
      return '';
    }
  }

  // --------------------------------------------------------------- challenge
  function detectChallenge() {
    const title = (document.title || '').toLowerCase();
    const bodyText = norm(document.body ? document.body.innerText : '').toLowerCase();
    const shortPage = bodyText.length < 1800;

    const captchaBox = Array.from(
      document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[title*="challenge" i]'),
    ).find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 40 && isVisible(el);
    });
    const captchaFrame = Array.from(document.querySelectorAll('iframe')).find((f) => {
      const src = (f.getAttribute('src') || '').toLowerCase();
      if (!/recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/.test(src)) return false;
      if (f.closest('.grecaptcha-badge')) return false; // the invisible-score badge, not a challenge
      const r = f.getBoundingClientRect();
      return r.width > 100 && r.height > 40 && isVisible(f);
    });
    if (captchaBox || captchaFrame) {
      return { kind: 'captcha', hint: 'This page is showing a CAPTCHA ("I am not a robot" style check).' };
    }

    const botTitle = /just a moment|attention required|access denied|are you a robot|security check|verify you are human/.test(title);
    const botText =
      /verify (that )?you are (a )?human|are you a robot|unusual traffic from your|checking your browser before accessing|verifying you are human|confirm you are not a robot|press (&|and) hold/.test(
        bodyText,
      );
    if ((botTitle && shortPage) || (botText && shortPage)) {
      return { kind: 'bot_check', hint: 'This site is checking that a real person is visiting (a bot check).' };
    }

    const otp = Array.from(document.querySelectorAll('input')).find((i) => {
      if (!isVisible(i)) return false;
      const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.includes('one-time-code')) return true;
      return shortPage && /verification code|one[- ]time|\botp\b|authenticator|security code|6-digit|2-step|two-factor/i.test(accName(i));
    });
    if (otp) return { kind: 'mfa', hint: 'This page is asking for a verification (one-time) code.' };

    const pw = Array.from(document.querySelectorAll('input[type="password"]')).find((i) => isVisible(i));
    if (pw) return { kind: 'login', hint: 'This page is asking you to sign in.' };
    return null;
  }

  // ----------------------------------------------------------------- observe
  function collectTables() {
    const tables = [];
    for (const t of Array.from(document.querySelectorAll('table')).filter((x) => isVisible(x)).slice(0, 3)) {
      const caption = t.querySelector('caption');
      const headerCells = Array.from(t.querySelectorAll('thead th, tr:first-child th')).slice(0, 12);
      const rows = Array.from(t.querySelectorAll('tbody tr, tr'))
        .filter((r) => r.querySelectorAll('td').length > 0)
        .slice(0, 6)
        .map((r) => Array.from(r.querySelectorAll('td')).slice(0, 12).map((c) => clip(c.innerText, 60)));
      if (rows.length === 0 && headerCells.length === 0) continue;
      tables.push({
        ...(caption ? { caption: clip(caption.innerText, 80) } : {}),
        headers: headerCells.map((h) => clip(h.innerText, 40)),
        rows,
        totalRows: t.querySelectorAll('tr').length,
      });
    }
    return tables;
  }

  function observe(opts) {
    const maxElements = Math.min(Math.max(Number(opts?.maxElements) || 300, 20), 500);
    state.epoch += 1;
    const epoch = state.epoch;
    state.elements = new Map();

    const { out, crossOriginFrames } = allElements();

    // First pass: things that are interactive by their markup.
    const picked = [];
    const pickedSet = new Set();
    for (const [el, inFrame] of out) {
      if (!el.matches(INTERACTIVE)) continue;
      if (el.tagName === 'LABEL') {
        // A label is only useful as a click target when it has no real control we can already see.
        const forId = el.getAttribute('for');
        const control = forId ? el.getRootNode().getElementById?.(forId) : null;
        if (control && isVisible(control)) continue;
      }
      if (!isVisible(el)) continue;
      picked.push([el, inFrame]);
      pickedSet.add(el);
    }

    // Second pass: divs/spans/images that only LOOK clickable (cursor: pointer). Topmost ones only.
    let cursorChecks = 0;
    const CLICKY_TAGS = new Set(['DIV', 'SPAN', 'LI', 'TD', 'IMG', 'SVG', 'I', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'IMG', 'FIGURE']);
    for (const [el, inFrame] of out) {
      if (cursorChecks >= MAX_CURSOR_CHECKS) break;
      if (!CLICKY_TAGS.has(el.tagName.toUpperCase()) || pickedSet.has(el)) continue;
      cursorChecks++;
      const win = el.ownerDocument.defaultView;
      if (win.getComputedStyle(el).cursor !== 'pointer') continue;
      const parent = el.parentElement;
      if (parent && win.getComputedStyle(parent).cursor === 'pointer') continue;
      if (el.closest('a[href], button, [role="button"], [role="link"]')) continue;
      if (el.querySelector(INTERACTIVE)) continue; // a container of real controls, not a control itself
      if (!isVisible(el)) continue;
      if (!norm(el.innerText ?? '') && !el.getAttribute('aria-label') && !el.getAttribute('title')) continue;
      picked.push([el, inFrame]);
      pickedSet.add(el);
    }

    // Third pass: links inside menus that are closed until you hover or open them. They are real links of the
    // page — the options a person finds by moving the mouse over the menu — so they are reported (marked hidden,
    // with the menu they live in) instead of pretending the page has nothing but what is showing.
    const hiddenPicked = [];
    for (const [el, inFrame] of out) {
      if (hiddenPicked.length >= MAX_HIDDEN * 3) break; // before de-duplication, so a mobile copy of the menu cannot use the budget up
      if (pickedSet.has(el)) continue;
      const isLink = el.tagName === 'A' && el.hasAttribute('href');
      if (!isLink && el.getAttribute('role') !== 'menuitem') continue;
      if (isLink && /^\s*(#|javascript:|mailto:|tel:)/i.test(el.getAttribute('href') || '')) continue;
      if (el.closest('[role="dialog"], dialog, template, noscript')) continue;
      if (isVisible(el) || !inMenuContext(el)) continue;
      hiddenPicked.push([el, inFrame]);
    }

    const records = [];
    const seen = new Set();
    function addRecord(el, inFrame, hidden) {
      const role = roleOf(el);
      const name = clip(accName(el), MAX_NAME);
      const region = regionOf(el);
      const href = el.tagName === 'A' ? redactUrl(el.getAttribute('href') || '') : '';
      const dedupeKey = `${role}|${name}|${href}|${role === 'input' || role === 'select' ? records.length : ''}`;
      if (name === '' && role !== 'input' && role !== 'select' && role !== 'checkbox' && role !== 'radio') return;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const win = el.ownerDocument.defaultView;
      const rect = hidden ? { bottom: 0, right: 0, top: 0, left: 0 } : el.getBoundingClientRect();
      const inViewport = !hidden && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
      const sensitive = isSensitiveField(el, name);
      const rec = { role, name };
      if (href) rec.href = href;
      if (role === 'input') {
        const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || (el.isContentEditable ? 'editable' : 'text')).toLowerCase();
        rec.type = type;
        if (sensitive) rec.sensitive = true;
        else {
          const v = el.value !== undefined ? el.value : el.isContentEditable ? el.innerText : '';
          if (v) rec.value = clip(v, 80);
        }
      }
      if (role === 'select') {
        rec.value = clip(el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text : '', 60);
        rec.options = Array.from(el.options || []).slice(0, 12).map((o) => clip(o.text, 40));
      }
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        rec.checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
      }
      const expanded = el.getAttribute('aria-expanded');
      if (expanded !== null) rec.expanded = expanded === 'true';
      if (isDisabled(el)) rec.disabled = true;
      if (region) rec.region = region;
      if (hidden) {
        rec.hidden = true;
        const menu = menuLabelOf(el);
        if (menu) rec.menu = menu;
      }
      rec.inViewport = inViewport;
      rec._el = el;
      rec._frame = inFrame;
      records.push(rec);
    }
    for (const [el, inFrame] of picked) addRecord(el, inFrame, false);
    const visibleCount = records.length;
    for (const [el, inFrame] of hiddenPicked) {
      if (records.length - visibleCount >= MAX_HIDDEN) break;
      addRecord(el, inFrame, true);
    }

    // Dialog controls first (they are what the user can actually reach), then what is on screen, then the rest of
    // the page, then the links that only a closed menu is holding.
    const rank = (r) => (r.hidden ? 3 : r.region === 'dialog' ? 0 : r.inViewport ? 1 : 2);
    const ordered = records
      .map((r, i) => [r, i])
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
      .map(([r]) => r);
    const shownVisible = ordered.filter((r) => !r.hidden).slice(0, maxElements);
    const shown = [...shownVisible, ...ordered.filter((r) => r.hidden)];
    shown.forEach((rec, n) => {
      const id = `e${epoch}.${n}`;
      rec.id = id;
      state.elements.set(id, { ref: new WeakRef(rec._el), name: rec.name, inFrame: rec._frame, hidden: rec.hidden === true });
      delete rec._el;
      delete rec._frame;
    });

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter((h) => isVisible(h))
      .map((h) => clip(h.innerText, 120))
      .filter(Boolean)
      .slice(0, 25);

    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]'))
      .filter((d) => isVisible(d))
      .map((d) => clip(d.innerText, 300))
      .filter(Boolean)
      .slice(0, 3);
    const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"][aria-live="assertive"]'))
      .filter((d) => isVisible(d))
      .map((d) => `(alert) ${clip(d.innerText, 200)}`)
      .filter((t) => t.length > 9)
      .slice(0, 3);

    const mainEl = document.querySelector('main, [role="main"]') || document.body;
    const visibleText = clip(mainEl ? mainEl.innerText : '', 1500);
    // The page's whole readable text, line structure kept, for "read me this page" — capped, never a password field's value.
    const bodyText = String(mainEl ? mainEl.innerText : '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_BODY_TEXT);

    const active = document.activeElement;
    let focused = null;
    if (active && active !== document.body && active !== document.documentElement) {
      const n = clip(accName(active), 60);
      focused = isSensitiveField(active, n) ? '(a sensitive field)' : n || active.tagName.toLowerCase();
    }

    const scrollMax = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const notes = [];
    if (document.readyState !== 'complete') notes.push('The page is still loading.');
    if (crossOriginFrames > 0) {
      notes.push(`${crossOriginFrames} embedded frame(s) come from another site and cannot be seen into.`);
    }
    const omitted = ordered.filter((r) => !r.hidden).length - shownVisible.length;
    if (omitted > 0) notes.push(`${omitted} more controls exist further down the page.`);
    const hiddenCount = shown.length - shownVisible.length;
    if (hiddenCount > 0) notes.push(`${hiddenCount} more links are inside menus that are closed until opened or hovered.`);

    return {
      url: location.href,
      title: document.title,
      epoch,
      headings,
      elements: shown,
      dialogs: [...dialogs, ...alerts],
      visibleText,
      bodyText,
      tables: collectTables(),
      focused,
      scroll: { y: Math.round(window.scrollY), max: Math.round(scrollMax), atBottom: window.scrollY >= scrollMax - 2 },
      challenge: detectChallenge(),
      loading: document.readyState !== 'complete',
      notes,
    };
  }

  // ------------------------------------------------------------ element ops
  function lookup(id, expectName) {
    const entry = state.elements.get(id);
    if (!entry) return { error: { ok: false, reason: 'stale_element', detail: 'That element is from an older look at the page.' } };
    const el = entry.ref.deref();
    if (!el || !el.isConnected) {
      return { error: { ok: false, reason: 'stale_element', detail: 'That element is no longer on the page.' } };
    }
    const currentName = clip(accName(el), MAX_NAME);
    const expected = expectName !== undefined ? clip(expectName, MAX_NAME) : entry.name;
    if (norm(currentName).toLowerCase() !== norm(expected).toLowerCase()) {
      return { error: { ok: false, reason: 'stale_element', detail: `That element changed (it now reads "${currentName}").` } };
    }
    return { el, entry };
  }

  function deepElementFromPoint(doc, x, y) {
    let el = doc.elementFromPoint(x, y);
    for (let i = 0; i < 6 && el && el.shadowRoot; i++) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  async function clickOp(p) {
    const found = lookup(p.id, p.expectName);
    if (found.error) return found.error;
    const { el, entry } = found;
    if (isDisabled(el)) return { ok: false, reason: 'disabled', detail: 'That control is disabled right now.' };

    // An item inside a menu that is closed until hovered/opened: do what a person does — move over the menu — and
    // if the page only opens it with CSS :hover (which a script cannot trigger), follow the link itself, which is a
    // real address the page contains.
    if (entry.hidden === true || !isVisible(el)) {
      const view0 = realmOf(el);
      const chain = [];
      for (let a = el.parentElement, i = 0; a && i < 6; a = a.parentElement, i++) {
        chain.push(a);
        if (a.previousElementSibling) chain.push(a.previousElementSibling);
      }
      for (const node of chain.reverse()) {
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'focusin']) {
          try {
            const Ctor = type.startsWith('pointer') ? view0.PointerEvent : type === 'focusin' ? view0.FocusEvent : view0.MouseEvent;
            node.dispatchEvent(new Ctor(type, { bubbles: type === 'mouseover' || type === 'pointerover' || type === 'focusin', composed: true, view: view0 }));
          } catch {
            // best effort
          }
        }
      }
      await sleep(250);
      if (!isVisible(el)) {
        if (el.tagName === 'A' && el.getAttribute('href')) {
          el.click();
          return { ok: true, role: 'link', tag: 'a', via: 'followed the link inside a closed menu directly' };
        }
        return { ok: false, reason: 'hidden', detail: 'That item is inside a menu that is closed. Open its parent menu first (click or hover it).' };
      }
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((r) => requestAnimationFrame(() => r()));
    await sleep(60);

    if (!entry.inFrame) {
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
      const top = deepElementFromPoint(document, x, y);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        const blocker = clip(accName(top) || top.tagName.toLowerCase(), 60);
        return { ok: false, reason: 'obscured', detail: `Something else is covering it ("${blocker}") — likely a popup or banner to deal with first.` };
      }
    }

    const view = el.ownerDocument.defaultView;
    const fire = (type, Ctor, extra) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view, ...extra }));
    try {
      fire('pointerover', view.PointerEvent, { pointerType: 'mouse' });
      fire('mouseover', view.MouseEvent, {});
      fire('mousemove', view.MouseEvent, {});
      fire('pointerdown', view.PointerEvent, { pointerType: 'mouse', button: 0, buttons: 1 });
      fire('mousedown', view.MouseEvent, { button: 0, buttons: 1 });
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      fire('pointerup', view.PointerEvent, { pointerType: 'mouse', button: 0 });
      fire('mouseup', view.MouseEvent, { button: 0 });
    } catch {
      // Synthetic pointer events are a courtesy for hover/press handlers; the click below is what matters.
    }
    el.click();
    return { ok: true, role: roleOf(el), tag: el.tagName.toLowerCase() };
  }

  function setNativeValue(el, value) {
    const win = realmOf(el);
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  async function fillOp(p) {
    const found = lookup(p.id, p.expectName);
    if (found.error) return found.error;
    const { el } = found;
    const name = clip(accName(el), MAX_NAME);
    if (isSensitiveField(el, name)) {
      return { ok: false, reason: 'sensitive_field', detail: 'That is a password, card or one-time-code field. Eya never types those — the user has to.' };
    }
    if (isDisabled(el) || el.readOnly === true) return { ok: false, reason: 'disabled', detail: 'That field cannot be edited right now.' };
    const value = String(p.value ?? '');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });

    if (el.tagName === 'SELECT') {
      const options = Array.from(el.options);
      const want = norm(value).toLowerCase();
      const hit =
        options.find((o) => norm(o.text).toLowerCase() === want) ||
        options.find((o) => o.value.toLowerCase() === want) ||
        options.find((o) => norm(o.text).toLowerCase().includes(want));
      if (!hit) {
        return { ok: false, reason: 'no_such_option', detail: 'That option is not in the list.', options: options.slice(0, 25).map((o) => clip(o.text, 50)) };
      }
      el.selectedIndex = hit.index;
      el.dispatchEvent(new (realmOf(el).Event)('input', { bubbles: true }));
      el.dispatchEvent(new (realmOf(el).Event)('change', { bubbles: true }));
      return { ok: true, applied: clip(hit.text, 60) };
    }

    if (el.tagName === 'INPUT' && (el.type === 'file')) {
      return { ok: false, reason: 'file_input', detail: 'That is a file-upload field; the user has to choose the file.' };
    }

    if (el.isContentEditable && !('value' in el)) {
      document.execCommand('selectAll', false);
      document.execCommand('insertText', false, value);
      return { ok: true, applied: clip(el.innerText, 60) };
    }

    setNativeValue(el, value);
    const win = realmOf(el);
    el.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    if (el.value !== value) {
      return { ok: false, reason: 'value_not_applied', detail: 'The page did not accept that value (it may have been reformatted or rejected).', now: clip(el.value, 60) };
    }
    return { ok: true, applied: clip(value, 60) };
  }

  async function pressOp(p) {
    const found = lookup(p.id, p.expectName);
    if (found.error) return found.error;
    const { el } = found;
    if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    const Key = realmOf(el).KeyboardEvent;
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    const down = el.dispatchEvent(new Key('keydown', init));
    el.dispatchEvent(new Key('keypress', init));
    el.dispatchEvent(new Key('keyup', init));
    // A real Enter in a text field submits its form unless the page's own handler took over.
    if (down && el.form && typeof el.form.requestSubmit === 'function') {
      try {
        el.form.requestSubmit();
      } catch {
        // validation failed: the browser shows its own message, nothing more to do
      }
    }
    return { ok: true };
  }

  // `history.back()` rather than chrome.tabs.goBack(): the browser's own Back skips entries for pages
  // that never received a real user gesture, and pages Eya reached with script-made clicks never did.
  function backOp() {
    if (history.length <= 1) return { ok: false, reason: 'no_history', detail: 'There is nothing to go back to in this tab.' };
    const from = location.href;
    history.back();
    return { ok: true, from };
  }

  // -------------------------------------------------------------- quiet wait
  function ensureObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.attributeName === 'style') continue; // animations / carousels
        state.lastMutationAt = Date.now();
        return;
      }
    });
    state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    state.lastMutationAt = Date.now();
  }

  // A page can go quiet while still waiting on the network. The page's own
  // loading indicators are the honest signal for that: an element marked busy,
  // a progress bar, or a line of text that is nothing but "Loading…".
  const LOADING_LINE = /^\s*(loading|please wait|processing|searching|fetching|just a moment)\b[\s….]*$/i;
  function looksBusy() {
    const marked = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some((e) => isVisible(e));
    if (marked) return true;
    const text = document.body ? document.body.innerText.slice(0, 3000) : '';
    return text.split('\n').some((line) => LOADING_LINE.test(line));
  }

  async function waitQuiet(opts) {
    ensureObserver();
    const quietMs = Number(opts?.quietMs) || 450;
    // Busy real-world pages (ads, carousels, live tickers) never go fully quiet, so this is a ceiling, not a target.
    const timeoutMs = Number(opts?.timeoutMs) || 2500;
    const busyExtraMs = Number(opts?.busyExtraMs) || 2500;
    const minMs = Number(opts?.minMs) || 250;
    const start = Date.now();
    await sleep(minMs);
    for (;;) {
      const now = Date.now();
      const quiet = now - state.lastMutationAt >= quietMs && document.readyState !== 'loading';
      if (quiet && !looksBusy()) return { settled: true, waitedMs: now - start };
      // Still-busy pages get a little longer than a merely-animated one, but never forever.
      if (now - start >= (quiet ? timeoutMs + busyExtraMs : timeoutMs)) {
        return { settled: false, waitedMs: now - start, busy: quiet ? looksBusy() : false };
      }
      await sleep(50);
    }
  }

  // ----------------------------------------------------------- search results
  function extractSearch(engine) {
    if (engine === 'duckduckgo') {
      return Array.from(document.querySelectorAll('.result')).map((r) => ({
        title: r.querySelector('a.result__a')?.textContent,
        href: r.querySelector('a.result__a')?.getAttribute('href'),
        snippet: r.querySelector('.result__snippet')?.textContent,
      }));
    }
    return Array.from(document.querySelectorAll('li.b_algo')).map((li) => ({
      title: li.querySelector('h2 a')?.textContent,
      href: li.querySelector('h2 a')?.getAttribute('href'),
      snippet: li.querySelector('.b_caption p, p')?.textContent,
    }));
  }

  // ---------------------------------------------------------------- dispatch
  switch (command) {
    case 'observe':
      ensureObserver();
      return observe(params);
    case 'click':
      return clickOp(params);
    case 'fill':
      return fillOp(params);
    case 'press':
      return pressOp(params);
    case 'back':
      return backOp();
    case 'waitQuiet':
      return waitQuiet(params);
    case 'extractSearch':
      return extractSearch(params?.engine);
    default:
      return { ok: false, reason: 'unknown_command', detail: String(command) };
  }
}
