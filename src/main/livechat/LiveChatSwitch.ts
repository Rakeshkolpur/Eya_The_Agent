import { rootLogger } from '@main/logging/logger';
import { realIo } from '@main/privacy/communicationAccessStore';
import type { StoreIo } from '@main/privacy/communicationAccessStore';
import type { LiveChatEnableItem, LiveChatEnableView } from '@shared/liveChat';
import type { PluginChange, PluginChangeResult, PluginView } from '@shared/plugins';

const log = rootLogger.child('livechat');

/**
 * The ONE switch for the live chat ("Enable live chat" on the Live chat page). Without it the live chat needed four separate yeses in four places — WhatsApp allowed in
 * Eya, the plugin's find / live-chat / send permissions, then a question each time about replying by itself — and the person had to know all of them. With it, one click
 * (only the person's own, on Eya's own page) puts everything the live chat needs in place, and stands as their confirmation that the people they live-chat with know
 * that replies are written with AI help, so a live chat then replies by itself with no further question.
 *
 * It does exactly what the person could do by hand on the Plugins page, through the same plugin manager (so every rule there still holds), and it remembers what IT
 * changed, so that switching it off puts back only that — never a permission or an app the person had allowed on their own before.
 */

export const SWITCH_PLUGIN = 'whatsapp';
/** What the live chat needs from the WhatsApp plugin, with what each is for. */
export const SWITCH_PERMISSIONS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'chats.read', label: 'Find the chat (permission: Find chats and contacts)' },
  { id: 'chats.live', label: 'Watch the chat and write replies (permission: Live chat companion)' },
  { id: 'messages.send', label: 'Send the replies (permission: Send text messages)' },
];

export interface SwitchPlugins {
  list(): readonly PluginView[];
  apply(change: PluginChange): PluginChangeResult;
}

/** What is saved: whether the person turned it on, and exactly what the switch itself changed (to put back, and nothing else, when it is turned off). */
export interface SwitchSaved {
  readonly version: 1;
  readonly on: boolean;
  readonly granted: readonly string[];
  readonly enabledPlugin: boolean;
  readonly connected: boolean;
  readonly at: number | null;
  /** What Eya calls the person in the chat ("I am Eya, <name>'s assistant"). Empty: the Windows account's name is used. Kept when the switch is turned off. */
  readonly ownerName: string;
}

export const SWITCH_OFF: SwitchSaved = { version: 1, on: false, granted: [], enabledPlugin: false, connected: false, at: null, ownerName: '' };

/** A name as a person is called: letters, spaces and the usual marks, not long. Anything else is not a name (it could carry an instruction or a number into a chat). */
export function cleanOwnerName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name === '') return '';
  return name.length <= 40 && /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name) ? name : null;
}

export function parseSwitchSaved(raw: unknown): SwitchSaved | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) return null;
  const known = new Set(SWITCH_PERMISSIONS.map((p) => p.id));
  return {
    version: 1,
    on: r['on'] === true,
    granted: Array.isArray(r['granted']) ? r['granted'].filter((g): g is string => typeof g === 'string' && known.has(g)) : [],
    enabledPlugin: r['enabledPlugin'] === true,
    connected: r['connected'] === true,
    at: typeof r['at'] === 'number' && Number.isFinite(r['at']) ? r['at'] : null,
    ownerName: typeof r['ownerName'] === 'string' ? (cleanOwnerName(r['ownerName']) ?? '') : '',
  };
}

export class LiveChatSwitchStore {
  constructor(
    private readonly path: string,
    private readonly io: StoreIo = realIo,
  ) {}

  load(): SwitchSaved | null {
    const text = this.io.read(this.path);
    if (text === null) return null;
    try {
      return parseSwitchSaved(JSON.parse(text));
    } catch {
      return null; // a damaged file is the same as no file: the switch is off
    }
  }

  save(saved: SwitchSaved): void {
    this.io.write(this.path, JSON.stringify(saved));
  }
}

export interface SwitchResult {
  readonly ok: boolean;
  readonly message: string;
}

export class LiveChatSwitch {
  private saved: SwitchSaved;

  constructor(
    private readonly plugins: SwitchPlugins,
    private readonly store: { load(): SwitchSaved | null; save(saved: SwitchSaved): void },
    private readonly now: () => number = Date.now,
    /** The name to use when the person has not set one (the Windows account's name). */
    private readonly defaultOwnerName: () => string = () => '',
  ) {
    this.saved = store.load() ?? SWITCH_OFF;
  }

  private plugin(): PluginView | undefined {
    return this.plugins.list().find((p) => p.id === SWITCH_PLUGIN);
  }

  private persist(next: SwitchSaved): void {
    this.saved = next;
    try {
      this.store.save(next);
    } catch (err) {
      log.warn('could not save the live chat switch', { err: String(err) });
    }
  }

  /** What Eya calls the person in the chat: the name they set, else their Windows name, else nothing (then she says "the person I assist"). */
  ownerName(): string {
    return this.saved.ownerName !== '' ? this.saved.ownerName : (cleanOwnerName(this.defaultOwnerName()) ?? '');
  }

  setOwnerName(raw: string): SwitchResult {
    const name = cleanOwnerName(raw);
    if (name === null) return { ok: false, message: 'That does not look like a name. Use letters only, up to 40.' };
    this.persist({ ...this.saved, ownerName: name });
    return { ok: true, message: name === '' ? 'Eya will use your Windows name.' : `Eya will say she is ${name}'s assistant.` };
  }

  /** What the switch covers and whether each part is in place right now (read from the plugin itself, so a permission taken away later shows). */
  view(): LiveChatEnableView {
    const p = this.plugin();
    const has = (id: string): boolean => p?.permissions.find((x) => x.id === id)?.granted === true;
    const items: LiveChatEnableItem[] = [
      { id: 'plugin', label: 'The WhatsApp plugin is installed and on', ok: p !== undefined && p.installed && p.enabled },
      { id: 'connected', label: 'Eya may use your WhatsApp (Chats on for WhatsApp)', ok: p?.connection === 'connected' },
      ...SWITCH_PERMISSIONS.map((perm) => ({ id: perm.id, label: perm.label, ok: has(perm.id) })),
      { id: 'replies', label: 'Replies go out by themselves, with no question each time (you confirm that the people you live-chat with know replies are written with AI help)', ok: this.saved.on },
    ];
    return { ownerName: this.ownerName(), on: this.saved.on, ready: this.saved.on && items.every((i) => i.ok), items };
  }

  /** On, and everything it needs is in place. This is the person's standing confirmation, and it is only as good as the permissions underneath it. */
  standing(): boolean {
    return this.view().ready;
  }

  turnOn(): SwitchResult {
    let p = this.plugin();
    if (p === undefined) return { ok: false, message: 'The WhatsApp plugin is not part of this Eya, so the live chat cannot be enabled.' };
    let state: SwitchSaved = { ...this.saved, on: false };
    const fail = (message: string): SwitchResult => {
      this.persist(state); // (what was already done is remembered, so that switching off puts it back)
      return { ok: false, message: `${message} The live chat was not enabled.` };
    };
    if (!p.installed) {
      const r = this.plugins.apply({ kind: 'install', id: SWITCH_PLUGIN });
      if (!r.ok) return fail(r.message);
    }
    p = this.plugin();
    if (p !== undefined && !p.enabled) {
      const r = this.plugins.apply({ kind: 'enable', id: SWITCH_PLUGIN });
      if (!r.ok) return fail(r.message);
      state = { ...state, enabledPlugin: true };
    }
    p = this.plugin();
    if (p !== undefined && p.connection !== 'connected') {
      const r = this.plugins.apply({ kind: 'connect', id: SWITCH_PLUGIN });
      if (!r.ok) return fail(r.message);
      state = { ...state, connected: true };
    }
    for (const perm of SWITCH_PERMISSIONS) {
      p = this.plugin();
      if (p?.permissions.find((x) => x.id === perm.id)?.granted === true) continue;
      const r = this.plugins.apply({ kind: 'grant', id: SWITCH_PLUGIN, permission: perm.id });
      if (!r.ok) return fail(r.message);
      state = { ...state, granted: [...new Set([...state.granted, perm.id])] };
    }
    this.persist({ ...state, on: true, at: this.now() });
    log.info('live chat enabled', { granted: state.granted.length, connected: state.connected, enabledPlugin: state.enabledPlugin });
    return {
      ok: true,
      message:
        'Live chat is enabled. WhatsApp is allowed in Eya, the plugin may find chats, watch a live chat and send replies, and a live chat now replies by itself, with no question each time. ' +
        'By switching it on you confirm that the people you live-chat with know that replies are written with AI help. Turn it off here at any moment.',
    };
  }

  /** Puts back only what the switch itself changed. Anything the person had allowed on their own before stays as it was. */
  turnOff(): SwitchResult {
    const before = this.saved;
    const notes: string[] = [];
    for (const perm of before.granted) {
      const r = this.plugins.apply({ kind: 'revoke', id: SWITCH_PLUGIN, permission: perm });
      if (!r.ok && this.plugin()?.permissions.find((x) => x.id === perm)?.granted === true) return { ok: false, message: `Could not take back a permission: ${r.message}` };
    }
    if (before.granted.length > 0) notes.push('the permissions it gave are taken back');
    if (before.connected) {
      const r = this.plugins.apply({ kind: 'disconnect', id: SWITCH_PLUGIN });
      if (r.ok) notes.push('WhatsApp is switched off in Eya again');
    }
    if (before.enabledPlugin) {
      const r = this.plugins.apply({ kind: 'disable', id: SWITCH_PLUGIN });
      if (r.ok) notes.push('the plugin is switched off again');
    }
    this.persist({ ...SWITCH_OFF, ownerName: before.ownerName }); // (the name stays: it is not a permission)
    log.info('live chat switched off');
    return { ok: true, message: `Live chat is switched off${notes.length > 0 ? `: ${notes.join(', ')}` : ''}. Anything you had allowed yourself on the Plugins page is left as it was.` };
  }
}
