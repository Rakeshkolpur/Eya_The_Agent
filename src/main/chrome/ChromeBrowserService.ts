import { basename } from 'node:path';
import { rootLogger } from '@main/logging/logger';
import type {
  ActOnPageResult,
  BrowserAutomationService,
  BrowserTabControl,
  ClickGate,
  FillOptions,
} from '@main/browser/BrowserAutomationService';
import { BrowserUnavailableError } from '@main/browser/errors';
import type { ActionEffects, BrowserTabInfo, DownloadInfo } from '@main/browser/pageEffects';
import { challengeMessage, isBlockingChallenge } from '@main/browser/challenges';
import type { PageSnapshot } from '@main/browser/pageSnapshot';
import { SEARCH_ENGINE_URLS } from '@main/browser/searchEngines';
import { cleanSearchHits } from '@main/browser/webSearchResults';
import type { RawSearchHit, WebSearchHit } from '@main/browser/webSearchResults';
import { BridgeError } from './ChromeBridge';
import { findClickTarget, findFillTarget, normalizePageState, stateToSnapshot } from './pageState';
import type { PageElement, PageState } from './pageState';
import { diffStates } from './stateDiff';

const log = rootLogger.child('chrome.browser');

/** What the service needs from the bridge — small on purpose, so tests can stand in for the real thing. */
export interface BridgeLike {
  isConnected(): boolean;
  request<T = unknown>(op: string, args?: Readonly<Record<string, unknown>>, timeoutMs?: number): Promise<T>;
}

interface ActionReply {
  readonly performed: { readonly ok: boolean; readonly reason?: string; readonly detail?: string; readonly options: readonly string[] };
  readonly tabId: number | null;
  readonly state: PageState;
  readonly settled: boolean;
  readonly stillBusy: boolean;
  readonly newTab: { readonly tabId: number } | null;
  readonly download: DownloadInfo | null;
  readonly reuse: 'focused' | 'navigated' | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function parseDownload(raw: unknown): DownloadInfo | null {
  const d = asRecord(raw);
  if (typeof d['filename'] !== 'string') return null;
  const state = d['state'] === 'complete' || d['state'] === 'interrupted' ? d['state'] : 'in_progress';
  return {
    path: d['filename'],
    name: d['filename'] === '' ? '' : basename(d['filename'].replace(/\\/g, '/')),
    state,
    bytes: typeof d['bytes'] === 'number' ? d['bytes'] : -1,
    ...(typeof d['mime'] === 'string' && d['mime'] !== '' ? { mime: d['mime'] } : {}),
    ...(typeof d['error'] === 'string' ? { error: d['error'] } : {}),
  };
}

function parseReply(raw: unknown): ActionReply {
  const r = asRecord(raw);
  const p = asRecord(r['performed']);
  const newTab = asRecord(r['newTab']);
  return {
    performed: {
      ok: p['ok'] !== false,
      ...(typeof p['reason'] === 'string' ? { reason: p['reason'] } : {}),
      ...(typeof p['detail'] === 'string' ? { detail: p['detail'] } : {}),
      options: Array.isArray(p['options']) ? p['options'].filter((o): o is string => typeof o === 'string').slice(0, 25) : [],
    },
    tabId: typeof r['tabId'] === 'number' ? r['tabId'] : null,
    state: normalizePageState(r['state']),
    settled: r['settled'] !== false,
    stillBusy: r['stillBusy'] === true,
    newTab: typeof newTab['tabId'] === 'number' ? { tabId: newTab['tabId'] } : null,
    download: parseDownload(r['download']),
    reuse: r['reuse'] === 'focused' || r['reuse'] === 'navigated' ? r['reuse'] : null,
  };
}

/**
 * Eya's hands in the user's own, already-signed-in browser, through the Eya
 * Browser Bridge extension. Nothing here assumes a page's shape: every action
 * is look → choose something that really is there → act → look again, and what
 * the model is shown afterwards is that second look, not a prediction.
 */
export class ChromeBrowserService implements BrowserAutomationService, BrowserTabControl {
  constructor(private readonly bridge: BridgeLike) {}

  private async call<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    try {
      return await this.bridge.request<T>(op, args, timeoutMs);
    } catch (err) {
      if (err instanceof BridgeError && (err.code === 'not_connected' || err.code === 'disconnected')) {
        throw new BrowserUnavailableError(
          'Eya has lost her connection to your browser. Make sure the browser is open with the Eya Browser Bridge extension turned on (or ask Eya to "connect my browser").',
        );
      }
      throw err;
    }
  }

  private snapshot(state: PageState, notes: readonly string[] = []): PageSnapshot {
    return stateToSnapshot(state, { environment: 'your_browser', notes });
  }

  /** A fresh look at the page Eya is on (or, if none yet, the tab the user is looking at). */
  private async look(): Promise<{ tabId: number | null; state: PageState }> {
    const raw = asRecord(await this.call('observe', {}));
    return { tabId: typeof raw['tabId'] === 'number' ? raw['tabId'] : null, state: normalizePageState(raw['state']) };
  }

  private blockedByChallenge(state: PageState): ActOnPageResult | null {
    // Eya stops at a CAPTCHA / bot check / verification-code prompt: no clicking around it, no trying to get past it.
    if (state.challenge !== null && isBlockingChallenge(state.challenge.kind)) {
      return { ok: false, reason: 'needs_user', message: challengeMessage(state.challenge.kind), snapshot: this.snapshot(state) };
    }
    return null;
  }

  private effectsOf(before: PageState, reply: ActionReply): ActionEffects {
    return {
      changes: diffStates(before, reply.state),
      settled: reply.settled,
      ...(reply.stillBusy ? { stillBusy: true } : {}),
      ...(reply.newTab !== null ? { newTab: { url: reply.state.url, title: reply.state.title } } : {}),
      ...(reply.download !== null ? { download: reply.download } : {}),
    };
  }

  private okResult(before: PageState, reply: ActionReply): ActOnPageResult {
    const notes: string[] = [];
    if (reply.newTab !== null) notes.push('That opened a new tab, and Eya moved to it.');
    if (!reply.settled) notes.push('The page was still changing when Eya looked — if something seems missing, look again.');
    return { ok: true, snapshot: this.snapshot(reply.state, notes), effects: this.effectsOf(before, reply) };
  }

  private failureResult(reply: ActionReply): ActOnPageResult {
    const snapshot = this.snapshot(reply.state);
    const reason = reply.performed.reason ?? 'failed';
    const detail = reply.performed.detail ?? 'The page would not let that happen.';
    if (reason === 'sensitive_field' || reason === 'file_input') return { ok: false, reason: 'needs_user', message: detail, snapshot };
    if (reason === 'no_such_option' && reply.performed.options.length > 0) {
      return { ok: false, reason: 'could_not', message: `${detail} The choices are: ${reply.performed.options.join(', ')}.`, snapshot };
    }
    return { ok: false, reason: 'could_not', message: detail, snapshot };
  }

  async openWebsite(url: string): Promise<PageSnapshot> {
    const reply = parseReply(await this.call('open_url', { url }, 60_000));
    const notes: string[] = [];
    if (reply.reuse === 'focused') notes.push('You already had a tab open on this site, so Eya switched to it instead of opening another (it was left as it was).');
    if (reply.reuse === 'navigated') notes.push('Eya reused the tab she opened earlier for this site.');
    if (!reply.settled) notes.push('The page was still loading when Eya looked — look again if something seems missing.');
    return this.snapshot(reply.state, notes);
  }

  async inspectPage(): Promise<PageSnapshot> {
    return this.snapshot((await this.look()).state);
  }

  async clickOnPage(text: string, gate?: ClickGate): Promise<ActOnPageResult> {
    for (let attempt = 0; ; attempt++) {
      const { tabId, state } = await this.look();
      const blocked = this.blockedByChallenge(state);
      if (blocked !== null) return blocked;

      const el: PageElement | null = findClickTarget(state, text);
      if (el === null) return { ok: false, reason: 'not_found', snapshot: this.snapshot(state) };

      const why = gate?.({ name: el.name, role: el.role }) ?? null;
      if (why !== null) return { ok: false, reason: 'needs_confirmation', why, target: el.name, snapshot: this.snapshot(state) };

      const reply = parseReply(await this.call('click', { ...(tabId !== null ? { tabId } : {}), id: el.id, name: el.name }, 90_000));
      if (reply.performed.ok) return this.okResult(state, reply);
      // The page moved under us between looking and clicking: look again once and re-choose.
      if (reply.performed.reason === 'stale_element' && attempt === 0) {
        log.info('element went stale; re-observing', { text });
        continue;
      }
      return this.failureResult(reply);
    }
  }

  async fillOnPage(label: string, value: string, options: FillOptions = {}): Promise<ActOnPageResult> {
    for (let attempt = 0; ; attempt++) {
      const { tabId, state } = await this.look();
      const blocked = this.blockedByChallenge(state);
      if (blocked !== null) return blocked;

      const el = findFillTarget(state, label);
      if (el === null) return { ok: false, reason: 'not_found', snapshot: this.snapshot(state) };
      if (el.sensitive === true) {
        return {
          ok: false,
          reason: 'needs_user',
          message: 'That is a password, card or one-time-code field. Eya never types those — please enter it yourself.',
          snapshot: this.snapshot(state),
        };
      }

      const reply = parseReply(
        await this.call('fill', { ...(tabId !== null ? { tabId } : {}), id: el.id, name: el.name, value, submit: options.submit === true }, 90_000),
      );
      if (reply.performed.ok) return this.okResult(state, reply);
      if (reply.performed.reason === 'stale_element' && attempt === 0) continue;
      return this.failureResult(reply);
    }
  }

  async goBack(): Promise<ActOnPageResult> {
    const { state: before } = await this.look();
    const reply = parseReply(await this.call('back', {}, 60_000));
    if (!reply.performed.ok) return this.failureResult(reply);
    return this.okResult(before, reply);
  }

  async searchWeb(query: string): Promise<WebSearchHit[]> {
    let lastError: unknown;
    for (const engine of SEARCH_ENGINE_URLS) {
      try {
        const raw = asRecord(await this.call('search_page', { url: engine.url(query), engine: engine.name }, 45_000));
        const hits = cleanSearchHits(Array.isArray(raw['hits']) ? (raw['hits'] as RawSearchHit[]) : []);
        log.info('browser web search (your browser)', { engine: engine.name, hits: hits.length });
        if (hits.length > 0) return hits;
      } catch (err) {
        lastError = err;
        log.warn('browser web search failed (your browser)', { engine: engine.name, err: String(err) });
      }
    }
    if (lastError !== undefined) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return [];
  }

  async listTabs(): Promise<BrowserTabInfo[]> {
    const raw = asRecord(await this.call('list_tabs', {}));
    const tabs = Array.isArray(raw['tabs']) ? raw['tabs'] : [];
    return tabs.flatMap((t): BrowserTabInfo[] => {
      const r = asRecord(t);
      if (typeof r['tabId'] !== 'number') return [];
      return [
        {
          tabId: r['tabId'],
          title: typeof r['title'] === 'string' ? r['title'] : '',
          url: typeof r['url'] === 'string' ? r['url'] : '',
          active: r['active'] === true,
          openedByEya: r['openedByEya'] === true,
          workingHere: r['workingHere'] === true,
        },
      ];
    });
  }

  async switchToTab(tabId: number): Promise<PageSnapshot> {
    const reply = parseReply(await this.call('focus_tab', { tabId }));
    return this.snapshot(reply.state);
  }

  /** Eya does not own the user's browser, so there is nothing for her to close. */
  async close(): Promise<void> {
    // intentionally empty
  }
}
