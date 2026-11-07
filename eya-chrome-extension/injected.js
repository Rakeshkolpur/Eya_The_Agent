/**
 * The part of Eya that runs INSIDE a web page.
 *
 * The service worker injects this with `chrome.scripting.executeScript({ func })`,
 * which serialises the function's source text — so everything it needs must
 * live inside it (no imports, no module-level helpers). One function, several
 * commands, one persistent bit of state per page (`globalThis.__eyaAgentState`,
 * in the extension's own isolated world, invisible to the page's scripts).
 *
 * Commands: observe | click | fill | press | waitQuiet | extractSearch | attachBegin | attachChunk | attachCommit.
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
  const MAX_CTA_CHECKS = 600;
  // The words of a call to action. STRONG ones are what a button says and almost nothing else does ("Buy now", "Buy at ₹14,249", "Add to cart", "Place order"): a short
  // text that starts so is a button, whatever it is painted with (Flipkart paints its buttons with a background IMAGE, or with a separate layer behind the words, so no
  // colour can be found on them). WEAK ones ("Continue", "Login", "Next") are also ordinary words in a sentence: they count only on a painted box.
  const CTA_STRONG = /^(?:buy\s+now|buy\s+at\b|add\s+to\s+(?:cart|bag|basket)|go\s+to\s+(?:cart|bag|checkout)|view\s+cart|check\s*out|place\s+(?:your\s+)?order|proceed\s+to\s+\w+|pay\s+now|order\s+now)(?:\s|$)/i;
  const CTA_WEAK = /^(?:continue(?:\s+to\s+\w+)?|log\s*in|sign\s*in|sign\s*up|register$|submit$|confirm(?:\s+\w+)?|next$|apply$|get\s+otp|request\s+otp|verify$|save\s+and\s+\w+|deliver\s+here|book\s+now)(?:\s|$)/i;
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

  // A one-time verification code field (an SMS or authenticator code), as against a password, a card number or a PIN. Eya types into one
  // only when the person said the code out loud (the desktop side checks that and says so with `allowCode`).
  const ONE_TIME_NAME = /one[- ]time|\botp\b|verification code|verify code|authenticator|2fa|two[- ]factor|6[- ]digit|sms code|confirmation code|login code|code sent/i;
  const CARD_CONTEXT = /card|cvv|cvc|cc-|expir|credit|debit|\bpin\b/i;
  function isOneTimeCodeField(el, name) {
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password') return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(cc-|current-password|new-password)/.test(ac)) return false;
    if (CARD_CONTEXT.test(name || '')) return false;
    if (/(^|\s)one-time-code/.test(ac)) return true;
    return ONE_TIME_NAME.test(name || '');
  }

  /** A box a person would take for a button: the element or one of its parents (up to 8 levels) is painted with a colour (not white, not clear) or an image, and is button-sized. */
  function isFilledBox(el) {
    const win = el.ownerDocument.defaultView;
    let n = el;
    for (let i = 0; n && i < 8; i++, n = n.parentElement) {
      const style = win.getComputedStyle(n);
      let painted = false;
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(style.backgroundColor || '');
      if (m) {
        const alpha = m[4] === undefined ? 1 : Number(m[4]);
        if (alpha >= 0.5 && !(Number(m[1]) > 244 && Number(m[2]) > 244 && Number(m[3]) > 244)) painted = true; // (white is the page's own paper)
      }
      if (!painted && style.backgroundImage && style.backgroundImage !== 'none') painted = true;
      if (!painted) continue;
      const r = n.getBoundingClientRect();
      if (r.height >= 24 && r.height <= 120 && r.width >= 56 && r.width <= 700) return true;
    }
    return false;
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

  /**
   * Which item a repeated button belongs to ("ADD" under a dish, "Add to cart" under a product): the first line of the card it sits in that is
   * not the button itself, a price, a rating or a badge. Only asked for names that occur more than once on the page.
   */
  function nearOf(el, ownName) {
    const own = norm(ownName);
    const ownLower = own.toLowerCase();
    const noise = /^(?:[\u20B9$\u20AC\u00A3]\s?)?\d[\d,.\s]*(?:\/-)?$|^(?:add|buy now|\+|-|veg|non[- ]?veg|bestseller|new|customi[sz]able|out of stock|sold out|\d(?:\.\d)?(?:\s?\(.*\))?|\d+(?:\.\d+)?\s?(?:%|off|mins?|km|ratings?|reviews?).*)$/i;
    let a = el.parentElement;
    for (let i = 0; a && i < 8; i++, a = a.parentElement) {
      const text = String(a.innerText ?? '');
      if (text.length > 700) break; // a whole list, not one item
      // The card's words without the buttons' own (this one's, and its neighbours' such as "Add to wishlist"): what is left is the item.
      let rest = own ? text.split(own).join('\n') : text;
      for (const b of Array.from(a.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]')).slice(0, 12)) {
        const n = norm(accName(b));
        if (n && n.length > 1) rest = rest.split(n).join('\n');
      }
      const lines = rest.split('\n').map(norm).filter(Boolean);
      const title = lines
        .map((l) => norm(l.replace(/\s*[\u20B9$\u20AC\u00A3]\s?\d[\d,.]*.*$/, '')))
        .find((l) => l.toLowerCase() !== ownLower && l.length > 2 && !noise.test(l));
      if (title) return clip(title, 60);
    }
    return '';
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

    // A page asking for card or UPI details: the payment step, which is the person's (checked before the code test, because a card's
    // "security code" is not a verification code).
    const payField = Array.from(document.querySelectorAll('input')).find((i) => {
      if (!isVisible(i)) return false;
      const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
      if (/(^|\s)cc-(number|csc|exp)/.test(ac)) return true;
      return /card number|\bcvv\b|\bcvc\b|expiry date|\bupi id\b|\bvpa\b/i.test(accName(i));
    });
    // A field that is plainly a one-time code beats a card field on the same page; "security code" counts as a code only when the page has
    // no card fields (on a card form it is the CVV).
    const otp = Array.from(document.querySelectorAll('input')).find((i) => {
      if (!isVisible(i)) return false;
      const ac = (i.getAttribute('autocomplete') || '').toLowerCase();
      if (ac.includes('one-time-code')) return true;
      const words = payField ? /verification code|one[- ]time|\botp\b|authenticator|6-digit|2-step|two-factor/i : /verification code|one[- ]time|\botp\b|authenticator|security code|6-digit|2-step|two-factor/i;
      return shortPage && words.test(accName(i));
    });
    if (otp) return { kind: 'mfa', hint: 'This page is asking for a verification (one-time) code.' };
    if (payField) return { kind: 'payment', hint: 'This page is asking for card or payment details.' };

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
      // (the rows that hold data, counted here by the page script, so that "how many are listed" is never answered by counting a sample of six by eye)
      const dataRowEls = Array.from(t.querySelectorAll('tbody tr, tr')).filter((r) => r.querySelectorAll('td').length > 0);
      const rows = dataRowEls.slice(0, 6).map((r) => Array.from(r.querySelectorAll('td')).slice(0, 12).map((c) => clip(c.innerText, 60)));
      if (rows.length === 0 && headerCells.length === 0) continue;
      tables.push({
        ...(caption ? { caption: clip(caption.innerText, 80) } : {}),
        headers: headerCells.map((h) => clip(h.innerText, 40)),
        rows,
        totalRows: t.querySelectorAll('tr').length,
        dataRows: dataRowEls.length,
      });
    }
    return tables;
  }

  // The delivery marks beside messages a person has sent ("Sent", "Delivered", "Read", "Pending", "Failed to send"…).
  // Only these words are ever reported, never the message next to them, so a chat can be checked without reading it.
  const STATUS_WORD =
    /^(?:message )?(sent|delivered|read|seen|pending|sending|failed|failed to send|not sent|couldn'?t send|couldn'?t be sent|undelivered|send failed|retry|tap to retry|click to retry)$/;
  function collectStatuses() {
    const found = [];
    let checked = 0;
    for (const el of document.querySelectorAll('[aria-label], [title], [data-icon], span, small, i, time')) {
      if (++checked > 8000) break;
      let raw = el.getAttribute('aria-label');
      if (raw === null || raw === '') raw = el.getAttribute('title');
      if (raw === null || raw === '') raw = el.childElementCount === 0 ? el.textContent : '';
      const label = norm(raw)
        .replace(/^[^a-z]+/i, '')
        .replace(/[^a-z']+$/i, '')
        .toLowerCase();
      if (label !== '' && label.length <= 20 && STATUS_WORD.test(label)) found.push(label.replace(/^message /, ''));
    }
    return found.slice(-6);
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

    // Pass 2b: the call-to-action boxes that are NOT marked as controls. Flipkart's "Buy at ₹14,249" and "Buy now" are plain <div>s (no role, no tabindex,
    // cursor: auto, painted by an image or a layer behind them), so a page full of them looked like it had no way to buy: "Buy at ₹14,249" was "not visible on the page"
    // although it was on the screen. A short text that starts like a button's (strong words), or a weaker one on a painted box, is a button.
    let ctaChecks = 0;
    for (const [el, inFrame] of out) {
      if (ctaChecks >= MAX_CTA_CHECKS) break;
      if (!CLICKY_TAGS.has(el.tagName.toUpperCase()) || pickedSet.has(el)) continue;
      if (el.children.length > 0) continue; // the words themselves (the innermost element)
      const raw = el.textContent || '';
      const said = raw.trim();
      if (said.length < 2 || said.length > 48) continue;
      const strong = CTA_STRONG.test(said);
      if (!strong && !CTA_WEAK.test(said)) continue;
      ctaChecks++;
      if (el.closest('a[href], button, [role="button"], [role="link"], label')) continue;
      if (!isVisible(el)) continue;
      if (!strong && !isFilledBox(el)) continue;
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

    // Same-named buttons that belong to different items (every dish's "ADD", every product's "Add to cart") are told apart by the item they sit
    // under; without that they all collapsed into one, and "the" ADD button was whichever came first.
    const REPEATABLE = new Set(['button', 'clickable', 'link', 'option', 'menuitem']);
    const nameCounts = new Map();
    for (const [el] of picked) {
      const r = roleOf(el);
      if (!REPEATABLE.has(r)) continue;
      const n = clip(accName(el), MAX_NAME);
      if (n) nameCounts.set(r + '|' + n, (nameCounts.get(r + '|' + n) || 0) + 1);
    }
    let nearBudget = 200;

    const records = [];
    const seen = new Set();
    function addRecord(el, inFrame, hidden) {
      const role = roleOf(el);
      const name = clip(accName(el), MAX_NAME);
      const region = regionOf(el);
      let near = '';
      if (!hidden && nearBudget > 0 && (nameCounts.get(role + '|' + name) || 0) > 1) {
        nearBudget--;
        near = nearOf(el, name);
      }
      const href = el.tagName === 'A' ? redactUrl(el.getAttribute('href') || '') : '';
      // A popup's "Send" is not the same control as the page's own "Send" behind it: both must stay, the popup's first.
      const dedupeKey = `${role}|${name}|${href}|${region === 'dialog' ? 'dialog' : ''}|${role === 'input' || role === 'select' ? records.length : ''}|${near}`;
      if (name === '' && role !== 'input' && role !== 'select' && role !== 'checkbox' && role !== 'radio') return;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      const win = el.ownerDocument.defaultView;
      const rect = hidden ? { bottom: 0, right: 0, top: 0, left: 0 } : el.getBoundingClientRect();
      const inViewport = !hidden && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth;
      const sensitive = isSensitiveField(el, name);
      const rec = { role, name };
      if (near) rec.near = near;
      if (href) rec.href = href;
      if (role === 'input') {
        const type = el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || (el.isContentEditable ? 'editable' : 'text')).toLowerCase();
        rec.type = type;
        if (sensitive) {
          rec.sensitive = true;
          if (isOneTimeCodeField(el, name)) rec.oneTimeCode = true;
        } else {
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
      // A list row (a chat, a search result) shows several lines; its first line is what a person calls it.
      if (role === 'clickable' || role === 'link' || role === 'option' || role === 'tab' || role === 'menuitem' || role === 'button') {
        // (not the screen-reader text of an unread badge — "12 unread messages" — which can come first in a chat row and is not the chat's name)
        const lines = String(el.innerText ?? '')
          .split('\n')
          .map((l) => norm(l))
          .filter(Boolean)
          .filter((l) => !/^(\d+\s+)?(unread|new)\s+messages?$/i.test(l));
        if (lines.length > 1 && lines[0].length < name.length) rec.primary = clip(lines[0], 80);
      }
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
    if (document.readyState === 'loading') notes.push('The page is still loading.');
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
      statuses: collectStatuses(),
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
    // (a page nobody is looking at at the moment never draws a frame, so do not wait for one for ever)
    await Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(120)]);
    await sleep(60);

    // Where a real mouse click would land: the innermost element at the point, with the click bubbling up through the element that was chosen.
    // (An app that listens on an inner node of a row — a React chat list, say — never hears events fired on the outer element.)
    let hit = el;
    if (!entry.inFrame) {
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
      const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
      const top = deepElementFromPoint(document, x, y);
      if (top && top !== el && el.contains(top) && top.ownerDocument === el.ownerDocument) hit = top;
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        const blocker = clip(accName(top) || top.tagName.toLowerCase(), 60);
        // A link has an address of its own: following it is exactly what the click would have done, and nothing drawn over it (a menu that drops down
        // over another one, a banner) can stop that. A court site's "Cause List" link, covered by the next menu, cost a whole model step to find that
        // out. A button could be behind a dialog that has to be dealt with first, so for anything else the click is still refused.
        const link = typeof el.closest === 'function' ? el.closest('a[href]') : null;
        const href = link ? (link.getAttribute('href') || '').trim() : '';
        if (link && href !== '' && !/^(?:javascript:|#|mailto:|tel:)/i.test(href) && !link.hasAttribute('download')) {
          link.click();
          return { ok: true, role: 'link', tag: 'a', via: `followed the link directly, because "${blocker}" was drawn over it` };
        }
        return { ok: false, reason: 'obscured', detail: `Something else is covering it ("${blocker}") — likely a popup or banner to deal with first.` };
      }
    }

    const view = el.ownerDocument.defaultView;
    const fire = (type, Ctor, extra) => hit.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view, ...extra }));
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
    // Does this click look like it fetches a file? (a download link, an address ending .pdf, a control that says "Download"): only then is it worth waiting
    // a couple of seconds for a download to begin. Any other click is judged by the page after it, not by waiting for a file that is not coming.
    const link = typeof el.closest === 'function' ? el.closest('a[href]') : null;
    const likelyDownload =
      (link !== null && (link.hasAttribute('download') || /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|mp3|mp4|exe|msi|apk|dmg)(?:[?#]|$)/i.test(link.getAttribute('href') || ''))) ||
      /\b(?:download|export|save as|print|pdf|excel|csv|zip|receipt|invoice|certificate|order copy|judg(?:e)?ment|attachment)\b/i.test(accName(el));
    // (an SVG node has no click(): its nearest element that has one is clicked, and the click bubbles from there)
    (typeof hit.click === 'function' ? hit : el).click();
    return { ok: true, role: roleOf(el), tag: el.tagName.toLowerCase(), ...(likelyDownload ? { likelyDownload: true } : {}) };
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
    if (isSensitiveField(el, name) && !(p.allowCode === true && isOneTimeCodeField(el, name))) {
      return { ok: false, reason: 'sensitive_field', detail: 'That is a password, card or one-time-code field. Eya types a one-time code only when the user says it out loud; a password or card number is always the user\'s to type.' };
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

  function forwardOp() {
    const from = location.href;
    history.forward();
    return { ok: true, from };
  }

  /** Scroll the page (or, on a page that scrolls inside a panel instead, the biggest scrollable panel in view). */
  function scrollOp(p) {
    const direction = ['up', 'down', 'top', 'bottom'].includes(p?.direction) ? p.direction : 'down';
    const viewport = window.innerHeight;
    const amount = Number(p?.amount) > 0 ? Number(p.amount) : Math.round(viewport * 0.85);
    let target = null; // null = the window itself
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight <= viewport + 8) {
      let best = 0;
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 8 && isVisible(el)) {
          const area = el.clientWidth * el.clientHeight;
          if (area > best) {
            best = area;
            target = el;
          }
        }
      }
    }
    const read = () => (target ? { y: target.scrollTop, max: target.scrollHeight - target.clientHeight } : { y: window.scrollY, max: root.scrollHeight - viewport });
    const before = read();
    const to = (top) => (target ? target.scrollTo({ top, behavior: 'instant' }) : window.scrollTo({ top, behavior: 'instant' }));
    if (direction === 'top') to(0);
    else if (direction === 'bottom') to(before.max + 10_000);
    else to(before.y + (direction === 'up' ? -amount : amount));
    const after = read();
    return {
      ok: true,
      moved: Math.abs(after.y - before.y) > 1,
      y: Math.round(after.y),
      max: Math.round(Math.max(0, after.max)),
      atTop: after.y <= 1,
      atBottom: after.y >= after.max - 2,
      inPanel: target !== null,
    };
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
    // A loading indicator that is really showing: visible, not tucked away in a hidden or inert part of the page, and — for a progress bar —
    // one with no value. A bar that has a value (step 2 of 3 at checkout, a delivery tracker, an upload) is part of the page, not a page
    // that is still loading; counting it made every checkout page "still loading" for ever.
    const marked = Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).some((e) => {
      if (!isVisible(e) || e.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
      if (e.getAttribute('role') === 'progressbar' && (e.hasAttribute('aria-valuenow') || /\d/.test(e.getAttribute('aria-valuetext') || ''))) return false;
      const r = e.getBoundingClientRect();
      return r.width >= 2 && r.height >= 2;
    });
    if (marked) return true;
    const text = document.body ? document.body.innerText.slice(0, 3000) : '';
    return text.split('\n').some((line) => LOADING_LINE.test(line));
  }

  async function waitQuiet(opts) {
    ensureObserver();
    const quietMs = Number(opts?.quietMs) || 450;
    // Busy real-world pages (ads, carousels, live tickers) never go fully quiet, so this is a ceiling, not a target.
    const timeoutMs = Number(opts?.timeoutMs) || 2500;
    // (an explicit 0 means "no extra wait": quick mode asks for exactly that, and `|| 2500` turned it back into 2.5 s, so on a chat page that merely LOOKS
    // busy — WhatsApp Web nearly always does — every click waited about three seconds before it answered, long after the message had gone)
    const busyExtraMs = opts?.busyExtraMs === undefined ? 2500 : Math.max(0, Number(opts.busyExtraMs) || 0);
    const minMs = Number(opts?.minMs) || 250;
    const start = Date.now();
    await sleep(minMs);
    for (;;) {
      const now = Date.now();
      const quiet = now - state.lastMutationAt >= quietMs && document.readyState !== 'loading';
      if (quiet && !looksBusy()) return { settled: true, waitedMs: now - start };
      // Still-busy pages get a little longer than a merely-animated one, but never forever.
      if (now - start >= (quiet ? timeoutMs + busyExtraMs : timeoutMs)) {
        // Out of patience. A page that keeps moving (an advert, a ticker, a carousel, a timer) but has finished loading and shows no loading
        // indicator is READY: only a page still being built, or one that really shows a spinner, is "still loading" (saying so of every busy
        // page sent Eya waiting for pages that were not loading at all).
        const busy = looksBusy();
        const loading = document.readyState === 'loading';
        return { settled: !(busy || loading), waitedMs: now - start, busy, noisy: !quiet };
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

  // ------------------------------------------------------------- file attach
  // A page's own file chooser is a native window no script can drive. Chat apps keep (usually hidden) file inputs, though,
  // and putting a file on one is exactly what the chooser would have done. The file arrives in pieces (a message to this
  // page can only be so big), is rebuilt here, and is handed to the input; nothing is sent anywhere by this step.
  const MAX_UPLOAD_BYTES = 110 * 1024 * 1024;

  function fileFit(accept, file) {
    const parts = String(accept || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (parts.length === 0) return 'any';
    const name = file.name.toLowerCase();
    const type = (file.type || '').toLowerCase();
    let generic = false;
    for (const p of parts) {
      if (p === '*' || p === '*/*') generic = true;
      else if (p.startsWith('.')) {
        if (name.endsWith(p)) return 'specific';
      } else if (p.endsWith('/*')) {
        if (type.startsWith(p.slice(0, -1))) return 'specific';
      } else if (type === p) return 'specific';
    }
    return generic ? 'any' : null;
  }

  function bytesFromBase64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function fileInputs() {
    return allElements()
      .out.map(([el]) => el)
      .filter((el) => el.tagName === 'INPUT' && (el.getAttribute('type') || '').toLowerCase() === 'file' && !el.disabled);
  }

  function noPicker() {
    return {
      ok: false,
      reason: 'no_file_input',
      detail:
        'This page has no file picker right now. Open its attach menu (the paperclip, plus or Attach button) so the app creates one, then try again. Do not click Document or Photos inside it: that opens a window only the user can use.',
    };
  }

  /** Is there a file picker on the page at all? Asked before a (possibly large) file is sent across. */
  function attachProbe() {
    const n = fileInputs().length;
    return n === 0 ? noPicker() : { ok: true, inputs: n };
  }

  function attachBegin(p) {
    const size = Number(p?.size);
    if (!Number.isFinite(size) || size <= 0 || size > MAX_UPLOAD_BYTES) {
      return { ok: false, reason: 'bad_size', detail: 'That file is empty or too large to attach this way.' };
    }
    state.upload = { id: String(p.id), name: clip(p.name, 200), mime: clip(p.mime, 100), size, parts: [], received: 0 };
    return { ok: true };
  }

  function attachChunk(p) {
    const up = state.upload;
    if (!up || up.id !== String(p?.id)) return { ok: false, reason: 'no_upload', detail: 'The file transfer was not started on this page.' };
    const bytes = bytesFromBase64(String(p.data));
    if (up.received + bytes.length > up.size) {
      state.upload = null;
      return { ok: false, reason: 'too_much_data', detail: 'More data arrived than the file holds.' };
    }
    up.parts.push(bytes);
    up.received += bytes.length;
    return { ok: true, received: up.received };
  }

  function attachCommit(p) {
    const up = state.upload;
    if (!up || up.id !== String(p?.id)) return { ok: false, reason: 'no_upload', detail: 'The file transfer was not started on this page.' };
    state.upload = null;
    if (up.received !== up.size) return { ok: false, reason: 'incomplete', detail: `Only ${up.received} of ${up.size} bytes arrived.` };
    const file = new File(up.parts, up.name, { type: up.mime || 'application/octet-stream', lastModified: Date.now() });

    const inputs = fileInputs();
    if (inputs.length === 0) return noPicker();
    const fits = inputs.map((el) => ({ el, fit: fileFit(el.getAttribute('accept'), file) })).filter((x) => x.fit !== null);
    if (fits.length === 0) {
      return { ok: false, reason: 'type_not_accepted', detail: `None of this page's file pickers accepts a ${file.type || 'file like'} "${file.name}".` };
    }
    const specific = fits.filter((x) => x.fit === 'specific');
    const generic = fits.filter((x) => x.fit === 'any');
    const prefer = p?.prefer === 'media' || p?.prefer === 'document' ? p.prefer : 'auto';
    // "As a document" wants the picker that takes anything; otherwise the picker made for this kind of file comes first.
    const pool = prefer === 'document' ? (generic.length > 0 ? generic : specific) : specific.length > 0 ? specific : generic;
    const target = pool[pool.length - 1].el;

    try {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      target.files = transfer.files;
    } catch (err) {
      return { ok: false, reason: 'not_accepted', detail: `The page would not take the file: ${String(err?.message ?? err)}` };
    }
    target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: true, name: file.name, size: file.size, accept: clip(target.getAttribute('accept') || '', 60), inputs: inputs.length };
  }

  // ---------------------------------------------------------------- adverts
  // Skippable adverts on YouTube, and the small adverts it lays over a video. Only the page's OWN controls are pressed (the Skip button,
  // an overlay advert's close button, a survey's dismiss button) exactly as a person would; an advert that cannot be skipped is simply
  // waited through, and nothing is hidden, sped up or blocked. `watch` keeps doing that every half second until `stop` or the page goes.
  const ADS_KEY = '__eyaAds';
  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button-container button',
    '.videoAdUiSkipButton',
  ];
  const AD_CLOSE_SELECTORS = [
    '.ytp-ad-overlay-close-button',
    '.ytp-ad-overlay-close-container',
    'ytd-button-renderer#dismiss-button button',
    '#dismiss-button button',
    '.ytp-ad-survey-questions button[aria-label*="Close" i]',
  ];

  function adVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function pressFirst(selectors) {
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (adVisible(el) && !el.disabled) {
          el.click();
          return true;
        }
      }
    }
    return false;
  }

  function adsSnapshot(st) {
    const player = document.querySelector('.html5-video-player');
    const video = document.querySelector('video.html5-main-video') || document.querySelector('video');
    const showing = !!player && player.classList.contains('ad-showing');
    return {
      ok: true,
      onYouTube: /(^|[.])youtube[.]com$/.test(location.hostname),
      title: clip(document.title, 120),
      adShowing: showing,
      // An advert is on but offers no Skip button (yet): Eya waits.
      waitingForAd: showing && !st.justSkipped,
      skipped: st.skipped,
      closed: st.closed,
      watching: st.timer !== null,
      video: video
        ? { paused: !!video.paused, ended: !!video.ended, seconds: Math.round(video.currentTime || 0), length: Number.isFinite(video.duration) ? Math.round(video.duration) : null }
        : null,
    };
  }

  function adsOp(params) {
    const mode = params?.mode || 'once';
    const st = (globalThis[ADS_KEY] ??= { skipped: 0, closed: 0, timer: null, justSkipped: false, keepPlaying: false, lastPressAt: 0 });
    if (mode === 'stop') {
      if (st.timer !== null) clearInterval(st.timer);
      st.timer = null;
      return adsSnapshot(st);
    }
    const tick = () => {
      st.justSkipped = false;
      if (pressFirst(SKIP_SELECTORS)) {
        st.skipped += 1;
        st.justSkipped = true;
        st.lastPressAt = Date.now();
      } else if (pressFirst(AD_CLOSE_SELECTORS)) {
        st.closed += 1;
        st.lastPressAt = Date.now();
      }
      // The video the person asked for can be left paused right after an advert is skipped: carry on playing it (only when asked to).
      if (st.keepPlaying && Date.now() - st.lastPressAt < 5000) {
        const player = document.querySelector('.html5-video-player');
        const video = document.querySelector('video.html5-main-video');
        if (video && video.paused && !video.ended && !(player && player.classList.contains('ad-showing'))) video.play().catch(() => undefined);
      }
    };
    if (params?.keepPlaying === true) st.keepPlaying = true;
    tick();
    // Start the video if the browser left it paused (it was opened by a program, so it may wait for a click): its own Play button, as a person would.
    if (params?.play === true) {
      const player = document.querySelector('.html5-video-player');
      const video = document.querySelector('video.html5-main-video');
      if (video && video.paused && !video.ended && !(player && player.classList.contains('ad-showing'))) {
        const button = document.querySelector('.ytp-play-button');
        if (button && adVisible(button)) button.click();
        else video.play().catch(() => undefined);
      }
    }
    if (mode === 'watch' && st.timer === null) st.timer = setInterval(tick, 500);
    return adsSnapshot(st);
  }

  // ---------------------------------------------------------------- how the page was answered
  // The HTTP status the site answered the page's own address with, and whether the page came up empty. Read from the browser's own record of the navigation
  // (no extra permission); null when the browser does not give one.
  function navInfoOp() {
    const entry = performance.getEntriesByType('navigation')[0];
    const status = entry && typeof entry.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : null;
    const text = (document.body ? document.body.innerText : '').trim();
    const blank = text.length === 0 && document.querySelectorAll('img, canvas, video, svg, iframe, input, button, a').length === 0;
    return { ok: true, status, blank };
  }

  // ---------------------------------------------------------------- one key
  // Only Escape, which closes what is open (a chat, a popup) the way a person's keyboard does. Nothing is typed and no other key can be sent.
  function pressKeyOp(p) {
    if (p?.key !== 'Escape') return { ok: false, reason: 'key_not_allowed', detail: 'Only the Escape key can be pressed this way.' };
    const target = document.activeElement && document.activeElement !== document.documentElement ? document.activeElement : document.body;
    const view = target.ownerDocument.defaultView;
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true, view };
    target.dispatchEvent(new view.KeyboardEvent('keydown', init));
    target.dispatchEvent(new view.KeyboardEvent('keyup', init));
    return { ok: true };
  }

  // ---------------------------------------------------------------- structure probe
  // Read-only, and only for finding out how a chat app's page is built (Eya's own diagnostics; see pageProbe.ts): the text fields and file
  // inputs of the page, which of the labelling attributes each has, and where it sits. Nothing is clicked, typed or changed.
  function probeOp() {
    const shapeOfId = (s) => String(s || '').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 24);
    const dialogSel = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
    const chainOf = (el) => {
      const out = [];
      for (let a = el.parentElement, i = 0; a && i < 5; a = a.parentElement, i++) {
        const role = a.getAttribute('role');
        out.push(a.tagName.toLowerCase() + (role ? `[${role}]` : '') + (a.id ? `#${a.id.slice(0, 24)}` : ''));
      }
      return out;
    };
    const describeField = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      editable: el.isContentEditable === true,
      role: el.getAttribute('role') || '',
      ariaLabel: norm(el.getAttribute('aria-label')),
      labelledby: !!el.getAttribute('aria-labelledby'),
      placeholder: norm(el.getAttribute('placeholder')),
      title: norm(el.getAttribute('title')),
      nameAttr: !!el.getAttribute('name'),
      idShape: shapeOfId(el.id),
      labels: el.labels ? el.labels.length : 0,
      accName: clip(accName(el), 60),
      accept: clip(el.getAttribute('accept') || '', 80),
      multiple: el.multiple === true,
      visible: isVisible(el),
      inDialog: !!el.closest(dialogSel),
      inMain: !!el.closest('main, [role="main"], #main'),
      inFooter: !!el.closest('footer'),
      inHeader: !!el.closest('header'),
      chain: chainOf(el),
    });
    const fields = Array.from(document.querySelectorAll('input:not([type="file"]):not([type="hidden"]):not([type="checkbox"]), textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"]')).slice(0, 14);
    const files = Array.from(document.querySelectorAll('input[type="file"]')).slice(0, 14);
    const roleCounts = {};
    for (const role of ['row', 'listitem', 'gridcell', 'grid', 'list', 'option', 'button', 'checkbox', 'textbox', 'searchbox', 'dialog', 'heading', 'tab', 'listbox']) {
      roleCounts[role] = document.querySelectorAll(`[role="${role}"]`).length;
    }
    return {
      ok: true,
      fields: fields.map(describeField),
      files: files.map(describeField),
      roleCounts,
      landmarks: { main: !!document.querySelector('main, [role="main"], #main'), footer: !!document.querySelector('footer'), header: !!document.querySelector('header'), dialogs: document.querySelectorAll(dialogSel).length },
      focused: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.getAttribute('role') ? `[${document.activeElement.getAttribute('role')}]` : ''}` : '',
    };
  }

  // ------------------------------------------------- live chat (a WhatsApp-shaped page)
  // One chat only: the conversation that is OPEN (`#main`). The watcher says THAT something changed there — never what — and Eya then reads the open
  // chat with `chatRead`. Nothing else on the page is read: not the chat list, not other chats, not the contacts. Message ids are the page's own `data-id`
  // ("true_…" is a message the account itself sent, "false_…" one it received).
  const CHAT_KEY = '__eyaChatWatch';
  const CHAT_ID = /^(true|false)_/;
  const CHAT_MAX_ROWS = 40;
  const CHAT_MAX_TEXT = 1200;
  const SELECTABLE = 'span.selectable-text, [data-testid="selectable-text"]';
  const CHAT_BUBBLE_MARKS = '[data-pre-plain-text], [data-testid="msg-meta"], [data-icon^="msg-"], .message-in, .message-out';
  const CHAT_NOTICE_ROWS_MAX = 3;

  // (the open conversation: `#main`; the second is the same panel under the name a newer page may give it)
  const chatPanel = () => document.querySelector('#main, [data-testid="conversation-panel-wrapper"]');
  // Rows by the page's own ids ("true_…" / "false_…"): the shape this reader was written for.
  const chatRows = (main) => Array.from(main.querySelectorAll('[data-id]')).filter((el) => CHAT_ID.test(el.getAttribute('data-id') || '') && !(el.parentElement && el.parentElement.closest('[data-id]')));

  // When the ids are not of that shape (a page that changed, or never had them), a message bubble is still recognised by what only a bubble has: its copy block with the
  // time and the sender ("[10:42, 27/10/2026] Rahul: ") or its time-and-ticks line. Which side it is on is read from the page's own direction mark, never guessed: a bubble
  // whose side cannot be told makes the page unreadable (replying to one's own message would be worse than not replying).
  const MARKED = '[data-pre-plain-text], [data-testid="msg-meta"]';
  function chatBubbleRoots(main) {
    const roots = [];
    const seen = new Set();
    for (const m of main.querySelectorAll(MARKED)) {
      const root = m.closest('[data-id]') || m.closest('[role="row"]') || m.closest('.message-in, .message-out') || m.parentElement;
      if (root && root !== main && !seen.has(root)) {
        seen.add(root);
        roots.push(root);
      }
    }
    const inner = (r) => roots.some((o) => o !== r && o.contains(r));
    return roots.filter((r) => !inner(r)).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
  const chatPlain = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  // Delivery ticks: only a message the account itself sent has one (a received message shows only its time).
  const CHAT_TICKS = '[data-icon^="msg-check"], [data-icon^="msg-dblcheck"], [data-icon="msg-time"]';
  /**
   * Which side of the conversation a bubble is DRAWN on: 'out' (right) or 'in' (left), or '' when it sits too near the middle to say. This is the page's own layout, which
   * holds whatever the names of its elements are today (the real page has no direction in its ids or classes). The bubble is what the page shows of it: its copy block, its time
   * line and any picture.
   */
  function chatGeoSide(el, main) {
    const panel = main.getBoundingClientRect();
    if (panel.width < 120) return '';
    let left = Infinity;
    let right = -Infinity;
    for (const p of el.querySelectorAll('[data-pre-plain-text], [data-testid="msg-meta"], img, video, canvas')) {
      const r = p.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    if (!(right > left)) return '';
    let x = ((left + right) / 2 - panel.left) / panel.width;
    if (getComputedStyle(main).direction === 'rtl') x = 1 - x;
    if (x >= 0.54) return 'out';
    if (x <= 0.46) return 'in';
    return '';
  }
  /**
   * { dir: 'in' | 'out' | '', how } for a bubble found without an id of the known shape. In this order: the id, an old-style direction class, a delivery tick (only the account's
   * own messages have one), where the bubble is drawn, and — last — the sender in its copy block compared with the chat's title. Where the last two disagree the layout wins
   * and the disagreement is counted (a sender's name does not always match the title: "~JK" for "JK").
   */
  function chatDirOf(el, title, main) {
    const id = el.getAttribute('data-id') || '';
    if (id.startsWith('true_')) return { dir: 'out', how: 'id' };
    if (id.startsWith('false_')) return { dir: 'in', how: 'id' };
    if (el.closest('.message-out') || el.querySelector('.message-out')) return { dir: 'out', how: 'class' };
    if (el.closest('.message-in') || el.querySelector('.message-in')) return { dir: 'in', how: 'class' };
    if (el.querySelector(CHAT_TICKS)) return { dir: 'out', how: 'ticks' };
    const pre = el.querySelector('[data-pre-plain-text]');
    const author = /^\[[^\]]*\]\s*(.*?):\s*$/.exec((pre && pre.getAttribute('data-pre-plain-text')) || '');
    const byAuthor = author && author[1] && title ? (chatPlain(author[1]) === chatPlain(title) ? 'in' : 'out') : '';
    const geo = chatGeoSide(el, main);
    if (geo !== '') return { dir: geo, how: 'geometry', conflict: byAuthor !== '' && byAuthor !== geo };
    if (byAuthor !== '') return { dir: byAuthor, how: 'author' };
    return { dir: '', how: 'none' };
  }
  const chatHash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const chatTitle = (main) => {
    const el = main.querySelector('header [data-testid="conversation-info-header-chat-title"], header span[title], header [title]');
    return clip(el ? el.getAttribute('title') || el.textContent : '', 120);
  };

  function chatRowText(el) {
    const parts = Array.from(el.querySelectorAll(SELECTABLE))
      .filter((s) => !(s.parentElement && s.parentElement.closest(SELECTABLE)))
      .map((s) => String(s.innerText || s.textContent || '').trim())
      .filter((t) => t !== '');
    let text = parts.join('\n');
    if (text === '') {
      // (a page that does not use the usual text spans: the copy block's own text, which is the message without its time)
      const pre = el.querySelector('[data-pre-plain-text]');
      if (pre) text = String(pre.innerText || pre.textContent || '').trim();
    }
    return text.slice(0, CHAT_MAX_TEXT);
  }

  // A document's bubble ALWAYS has words in it (its file name, how many pages, how big), so "has words" cannot mean "is a text message": on the real WhatsApp a PDF was read as
  // a text message called "07 - … .pdf" and never taken. A bubble is a document when it offers a file — a document icon or a download control — together with a file name.
  function chatIsDocument(el) {
    const marked = el.querySelector('[data-icon*="document"], [data-icon*="pdf"], [data-icon*="download"], [aria-label*="ownload" i], [title*="ownload" i]');
    return marked !== null && chatMediaName(el) !== '';
  }

  function chatRowKind(el, text) {
    const shown = String(el.innerText || '');
    if (/this message was deleted|you deleted this message/i.test(shown)) return 'deleted';
    if (chatIsDocument(el)) return 'document';
    if (text !== '') return 'text';
    if (el.querySelector('[data-testid*="sticker"], img[src*="sticker"]')) return 'sticker';
    if (el.querySelector('[data-testid*="audio"], [data-icon*="audio"], [data-icon*="ptt"], [aria-label*="oice message"]')) return 'audio';
    if (el.querySelector('video, [data-icon*="video"]')) return 'video';
    if (el.querySelector('img')) return 'image';
    if (el.querySelector('[data-icon*="document"]')) return 'document';
    return 'other';
  }

  function chatReadRow(el, mode, title, main, seenAnon) {
    const text = chatRowText(el);
    const kind = chatRowKind(el, text);
    const pre = el.querySelector('[data-pre-plain-text]');
    const preText = (pre && pre.getAttribute('data-pre-plain-text')) || '';
    const stamp = /^\[([^\]]{0,40})\]/.exec(preText);
    let id = el.getAttribute('data-id') || '';
    let side = { dir: id.startsWith('true_') ? 'out' : 'in', how: 'id' };
    if (mode === 'bubbles') {
      side = chatDirOf(el, title, main);
      // A message that is not text (a picture, a voice note, a sticker…) whose side cannot be told is read as received: it has no words to answer, so as a received message it
      // can only ever be "nothing to reply to" — whereas calling it the person's own would make a waiting reply look as if the person had answered it themselves.
      // (A TEXT message whose side cannot be told is never guessed: the page is then unreadable.)
      if (side.dir === '' && kind !== 'text') side = { dir: 'in', how: 'default' };
      if (!CHAT_ID.test(id)) {
        if (id !== '') {
          id = `wa_${id}`; // the page's own id for the message, as it is
        } else {
          // No id at all: one is made from the bubble's own time, sender and words (and which of identical ones it is), stable while the chat grows.
          const key = chatHash(`${preText}|${text}`);
          const n = (seenAnon.get(key) || 0) + 1;
          seenAnon.set(key, n);
          id = `${side.dir === 'out' ? 'true' : 'false'}_anon_${key}_${n}`;
        }
      }
    }
    return { id, dir: side.dir, kind, text, at: stamp ? stamp[1] : '', how: side.how, conflict: side.conflict === true };
  }

  // ("shape" text: the kind of thing and where it sits, with every letter, digit and word of the chat masked — A a 9 — so that it can be kept and read without a message,
  // a name or a number being in it)
  const chatMask = (s) => String(s || '').replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/[0-9]/g, '9').slice(0, 40);
  const chatSafeTestId = (v) => (/^[a-z][a-z-]{0,29}$/.test(v) ? v : chatMask(v));
  function chatChain(el, n) {
    const out = [];
    for (let a = el, i = 0; a && i < n; a = a.parentElement, i++) {
      const role = a.getAttribute('role');
      const tid = a.getAttribute('data-testid');
      out.push(`${a.tagName.toLowerCase()}${role ? `[${role}]` : ''}${tid ? `{${chatSafeTestId(tid)}}` : ''}${a.id ? `#${chatMask(a.id)}` : ''}${a.hasAttribute('data-id') ? '(data-id)' : ''}`);
    }
    return out.join('<');
  }
  function chatShape(main, how, counts) {
    const ids = [...new Set(Array.from(main.querySelectorAll('[data-id]')).slice(0, 6).map((e) => chatMask(e.getAttribute('data-id'))))].slice(0, 3);
    const first = main.querySelector('[data-pre-plain-text]');
    const pre = first ? chatMask(first.getAttribute('data-pre-plain-text')) : '';
    const parts = [
      `main=${main.id ? '#' + chatMask(main.id) : main.tagName.toLowerCase()}`,
      `how=${how}`,
      `counts=${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(',')}`,
      `ids=${ids.join('|') || '-'}`,
      `pre=${pre || '-'}`,
      `bubble=${first ? chatChain(first, 6) : '-'}`,
    ];
    return parts.join('; ').slice(0, 600);
  }

  function chatReadOp(params) {
    const main = chatPanel();
    if (!main) return { ok: true, hasMain: false, title: '', messages: [], reliable: true, diagnostics: { rows: 0, otherRows: 0, messageLike: 0 } };
    const max = Math.max(1, Math.min(CHAT_MAX_ROWS, Number(params && params.max) || 30));
    const title = chatTitle(main);
    const known = chatRows(main);
    const bubbles = known.length === 0 ? chatBubbleRoots(main) : [];
    const how = known.length > 0 ? 'ids' : bubbles.length > 0 ? 'bubbles' : 'none';
    const rows = known.length > 0 ? known : bubbles;
    const otherRows = main.querySelectorAll('[role="row"], .message-in, .message-out').length;
    // Things only a message bubble has (a time/ticks line, a copy block, an old-style direction class), whatever its id looks like. A NEW chat, with only the page's own
    // notices in it ("Messages are end-to-end encrypted…", a date chip), has none: it is empty, not unreadable.
    const messageLike = main.querySelectorAll(CHAT_BUBBLE_MARKS).length;
    const seenAnon = new Map();
    const all = rows.map((el) => chatReadRow(el, how, title, main, seenAnon));
    // (a TEXT bubble whose side could not be told is not read at all, and makes the page unreadable: see chatDirOf)
    const unknownSide = all.filter((m) => m.dir === '').length;
    const by = (h) => all.filter((m) => m.how === h).length;
    const sides = { id: by('id'), cls: by('class'), ticks: by('ticks'), geo: by('geometry'), author: by('author'), dflt: by('default'), conflicts: all.filter((m) => m.conflict).length };
    const messages = all
      .filter((m) => m.dir !== '')
      .slice(-max)
      .map((m) => ({ id: m.id, dir: m.dir, kind: m.kind, text: m.text, at: m.at }));
    const counts = { rows: rows.length, other: otherRows, marks: messageLike, ids: main.querySelectorAll('[data-id]').length, pre: main.querySelectorAll('[data-pre-plain-text]').length, sel: main.querySelectorAll(SELECTABLE).length, text: all.filter((m) => m.text !== '').length, unknownSide, ...sides };
    return {
      ok: true,
      hasMain: true,
      title,
      messages,
      // A page that shows message bubbles this reader does not recognise is said to be unreadable, never read as "no messages". (Several rows and none recognised is
      // taken the same way: a chat with only notices has one or two rows at most.)
      reliable: unknownSide === 0 && !(rows.length === 0 && (messageLike > 0 || otherRows >= CHAT_NOTICE_ROWS_MAX + 1)),
      // (counts and masked shapes only: never a word of the chat)
      diagnostics: { rows: rows.length, otherRows, messageLike, withText: messages.filter((m) => m.text !== '').length, how, unknownSide, sides, shape: chatShape(main, how, counts) },
    };
  }

  // A cheap fingerprint of the open chat: its title, how many message rows, and the id and size of the last three. (textContent, not innerText: reading
  // innerText forces the page to lay itself out, which is slow, and in a hidden tab pointless.)
  function chatSignature(main) {
    if (!main) return 'none';
    let rows = chatRows(main);
    if (rows.length === 0) rows = chatBubbleRoots(main);
    const tail = rows.slice(-3).map((el) => {
      const t = String(el.textContent || '');
      return `${el.getAttribute('data-id') || ''}:${t.length}:${t.slice(0, 24)}`;
    });
    return `${chatTitle(main)}|${rows.length}|${tail.join('|')}`;
  }

  function stopChatWatch(st) {
    if (st.observer) st.observer.disconnect();
    if (st.timer !== null) clearTimeout(st.timer);
    st.observer = null;
    st.timer = null;
    st.inflight = false;
  }

  function chatWatchOp(params) {
    const st = (globalThis[CHAT_KEY] ??= { observer: null, timer: null, signature: '', title: '', sent: 0, inflight: false, delivered: 0 });
    const mode = params && params.mode;
    if (mode === 'stop') {
      stopChatWatch(st);
      return { ok: true, watching: false };
    }
    if (mode === 'status') return { ok: true, watching: st.observer !== null, sent: st.sent, delivered: st.delivered };
    stopChatWatch(st);
    const main = chatPanel();
    // `signature` is what Eya was LAST TOLD (and confirmed receiving) about: a change is reported again, on the next change or after a moment, until it has been.
    st.signature = chatSignature(main);
    st.title = main ? chatTitle(main) : '';

    // No waiting on a timer to look: a page in a background tab has its timers slowed, but a mutation callback runs the moment the page changes. The look is cheap.
    const check = () => {
      if (st.observer === null || st.inflight) return;
      const now = chatPanel();
      const signature = chatSignature(now);
      if (signature === st.signature) return;
      const title = now ? chatTitle(now) : '';
      const reason = now === null ? 'closed' : title !== st.title ? 'switched' : 'messages';
      const rows = now ? chatRows(now).length : 0;
      st.inflight = true;
      st.sent += 1;
      try {
        // (only that something changed, and how many rows: never a message, a name or a number)
        chrome.runtime.sendMessage({ t: 'chat_event', reason, rows }, (reply) => {
          st.inflight = false;
          void chrome.runtime.lastError;
          if (st.observer === null) return;
          if (reply && reply.stop === true) {
            stopChatWatch(st);
            return;
          }
          if (reply && reply.delivered === true) {
            st.delivered += 1;
            st.signature = signature;
            st.title = title;
            check(); // anything that changed while that was on its way
          } else {
            // Eya did not get it (the connection was down): it is reported again very soon, by the next change or by this retry.
            if (st.timer === null) {
              st.timer = setTimeout(() => {
                st.timer = null;
                check();
              }, 1500);
            }
          }
        });
      } catch {
        stopChatWatch(st); // the extension was reloaded: this copy is orphaned
      }
    };
    st.observer = new MutationObserver(check);
    st.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return { ok: true, watching: true, hasMain: main !== null, rows: main ? chatRows(main).length : 0, title: st.title };
  }

  // ------------------------------------------------- pictures and documents in the open chat
  // Only a message the OTHER person sent, found the way chatRead finds it (so the id means the same thing). A picture: its own bytes, when the page holds them (a blob or a
  // data address) — nothing is pressed. A document: what the bubble offers (its file name, whether it has a download control) and then, only when Eya asks, a press on that
  // control; the browser does the download and Eya watches it (see service-worker 'chat_media'). Nothing is sent to anyone, changed or deleted.
  function chatFindRow(wanted) {
    const main = chatPanel();
    if (!main) return { error: 'no_chat' };
    const title = chatTitle(main);
    const known = chatRows(main);
    const how = known.length > 0 ? 'ids' : 'bubbles';
    const rows = known.length > 0 ? known : chatBubbleRoots(main);
    const seenAnon = new Map();
    for (const el of rows) {
      const m = chatReadRow(el, how, title, main, seenAnon);
      if (m.id === wanted) return { el, m };
    }
    return { error: 'not_found' };
  }

  // A document's file name: the page puts it in a title or a label, or shows it as a line of text. A name ends in a short extension.
  function chatMediaName(el) {
    const candidates = [];
    for (const n of el.querySelectorAll('[title], [aria-label]')) candidates.push(n.getAttribute('title') || '', n.getAttribute('aria-label') || '');
    for (const n of el.querySelectorAll('span, div')) if (n.children.length === 0) candidates.push(n.textContent || '');
    for (const raw of candidates) {
      const t = String(raw).trim();
      if (t.length >= 3 && t.length <= 160 && /\.[A-Za-z0-9]{2,5}$/.test(t) && !/^[\d:.\s]+$/.test(t) && !/^(?:https?:|www\.)/i.test(t) && !/\n/.test(t)) return t;
    }
    return '';
  }

  // The control that downloads: an icon or a button named for it. Failing that — the real page may draw the arrow as a bare icon with no name — the button the document's own
  // icon sits in: pressing a document on WhatsApp Web downloads it. (Nothing else in the bubble is pressed: not a link, not the message's menu. Whatever the browser then saves
  // is still checked afterwards — it must be in Downloads, an ordinary document or picture, and not too big.)
  function chatMediaControl(el) {
    const selectors = ['[data-icon*="download"]', 'button[aria-label*="ownload" i]', '[role="button"][aria-label*="ownload" i]', '[aria-label*="ownload" i]', '[title*="ownload" i]'];
    for (const selector of selectors) {
      const n = el.querySelector(selector);
      if (n) return n.closest('[role="button"], button') || n;
    }
    const icon = el.querySelector('[data-icon*="document"], [data-icon*="pdf"]');
    const holder = icon ? icon.closest('[role="button"], button, [tabindex]') : null;
    return holder && holder !== el && el.contains(holder) && !holder.closest('a[href]') ? holder : null;
  }

  // What icons the bubble shows (the page's own icon names, never a word of the chat): enough to see, afterwards, why no download control was found.
  function chatMediaIcons(el) {
    return [...new Set(Array.from(el.querySelectorAll('[data-icon]')).map((n) => String(n.getAttribute('data-icon') || '').slice(0, 30)))].slice(0, 8);
  }

  function chatMediaPress(control) {
    control.scrollIntoView({ block: 'center', inline: 'center' });
    const view = control.ownerDocument.defaultView;
    const fire = (type, Ctor, extra) => control.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view, ...extra }));
    try {
      fire('pointerdown', view.PointerEvent, { pointerType: 'mouse', button: 0, buttons: 1 });
      fire('mousedown', view.MouseEvent, { button: 0, buttons: 1 });
      fire('pointerup', view.PointerEvent, { pointerType: 'mouse', button: 0 });
      fire('mouseup', view.MouseEvent, { button: 0 });
    } catch {
      // the click below is what matters
    }
    (typeof control.click === 'function' ? control : control.parentElement).click();
  }

  const blobToBase64 = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('could not read the picture'));
      reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
      reader.readAsDataURL(blob);
    });

  async function chatMediaOp(params) {
    const found = chatFindRow(String((params && params.id) || ''));
    if (found.error) return { ok: false, reason: found.error };
    const { el, m } = found;
    if (m.dir !== 'in') return { ok: false, reason: 'not_incoming' };
    if (m.kind === 'image') {
      const max = Math.max(1, Math.min(8 * 1024 * 1024, Number(params && params.maxBytes) || 5 * 1024 * 1024));
      // (the biggest picture in the bubble that is really loaded: a blurred little placeholder is not the picture)
      const pictures = Array.from(el.querySelectorAll('img'))
        .filter((i) => i.naturalWidth >= 120 && i.naturalHeight >= 120 && /^(?:blob:|data:image\/)/.test(i.currentSrc || i.src || ''))
        .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
      if (pictures.length === 0) return { ok: false, reason: 'not_loaded' };
      try {
        const res = await fetch(pictures[0].currentSrc || pictures[0].src);
        if (!res.ok) return { ok: false, reason: 'failed' };
        const blob = await res.blob();
        if (blob.size > max) return { ok: false, reason: 'too_big' };
        return { ok: true, via: 'bytes', mime: String(blob.type || 'image/jpeg').slice(0, 60), data: await blobToBase64(blob) };
      } catch {
        return { ok: false, reason: 'failed' };
      }
    }
    if (m.kind === 'document') {
      const control = chatMediaControl(el);
      if (params && params.phase === 'click') {
        if (!control) return { ok: false, reason: 'no_control', icons: chatMediaIcons(el) };
        chatMediaPress(control);
        return { ok: true, likelyDownload: true };
      }
      return { ok: true, via: 'document', name: chatMediaName(el), hasControl: control !== null, icons: chatMediaIcons(el) };
    }
    return { ok: false, reason: 'not_media' };
  }

  // ---------------------------------------------------------------- dispatch
  switch (command) {
    case 'chatMedia':
      return chatMediaOp(params);
    case 'chatWatch':
      return chatWatchOp(params);
    case 'chatRead':
      return chatReadOp(params);
    case 'probe':
      return probeOp();
    case 'pressKey':
      return pressKeyOp(params);
    case 'navInfo':
      return navInfoOp();
    case 'ads':
      return adsOp(params);
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
    case 'forward':
      return forwardOp();
    case 'scroll':
      return scrollOp(params);
    case 'waitQuiet':
      return waitQuiet(params);
    case 'extractSearch':
      return extractSearch(params?.engine);
    case 'attachProbe':
      return attachProbe();
    case 'attachBegin':
      return attachBegin(params);
    case 'attachChunk':
      return attachChunk(params);
    case 'attachCommit':
      return attachCommit(params);
    default:
      return { ok: false, reason: 'unknown_command', detail: String(command) };
  }
}
