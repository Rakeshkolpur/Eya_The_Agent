import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { Toggle } from './widgets';

/** Every part of the Eya window that can be hidden, and what it is called in the Layout menu. */
export const SECTIONS = [
  { id: 'agentTimeline', label: 'Your Agent at Work (live steps)' },
  { id: 'recentTasks', label: 'Recent Tasks (under the conversation)' },
  { id: 'agentList', label: 'Tasks in progress' },
  { id: 'aiKeys', label: 'Gemini keys (used one after another)' },
  { id: 'popularApps', label: 'Popular Apps' },
  { id: 'recentFiles', label: 'Recent Files' },
  { id: 'todayActivity', label: "Today's Activity" },
  { id: 'connectedApps', label: 'Connected Apps (sidebar)' },
  { id: 'aiStatus', label: 'AI status (sidebar)' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/** The other cards that can sit in the side panel; each is off until the person switches it on in the Layout menu. */
export const SIDE_EXTRAS: readonly SectionId[] = ['aiKeys', 'popularApps', 'recentFiles', 'todayActivity'];

/**
 * Off until the person turns them on: when the app opens only the conversation shows (the side panel opens by itself while a task works), and the
 * sidebar keeps to its menu and the chat list (the Connected Apps block is one switch away in the Layout menu).
 */
export const DEFAULT_HIDDEN: readonly SectionId[] = ['recentTasks', ...SIDE_EXTRAS, 'connectedApps'];

// (a new key: the old one remembered choices made about the first dashboard)
const STORE_KEY = 'eya.hiddenSections2';
// (set the first time this version opens: the Connected Apps block was taken out of the sidebar by default, so choices saved before that get it hidden ONCE; a switch the person
// turns on afterwards is theirs and is kept)
const MOVED_KEY = 'eya.connectedAppsOffByDefault';
const KNOWN: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));

/** What was hidden last time. Nothing stored, damaged or unavailable storage means the defaults. */
export function loadHidden(): ReadonlySet<SectionId> {
  try {
    const firstTime = window.localStorage.getItem(MOVED_KEY) === null;
    if (firstTime) window.localStorage.setItem(MOVED_KEY, '1');
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) return new Set(DEFAULT_HIDDEN);
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return new Set(DEFAULT_HIDDEN);
    const hidden = new Set<SectionId>(list.filter((x): x is SectionId => typeof x === 'string' && KNOWN.has(x)));
    if (firstTime) {
      hidden.add('connectedApps');
      saveHidden(hidden);
    }
    return hidden;
  } catch {
    return new Set(DEFAULT_HIDDEN);
  }
}

function saveHidden(hidden: ReadonlySet<SectionId>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify([...hidden]));
  } catch {
    // private window or blocked storage: the choice just lasts until the window closes
  }
}

interface SectionsApi {
  readonly hidden: ReadonlySet<SectionId>;
  readonly isHidden: (id: SectionId) => boolean;
  readonly setHidden: (id: SectionId, hidden: boolean) => void;
  readonly showAll: () => void;
  /** Back to how the app opens: the conversation and the panels about the task at hand, nothing else. */
  readonly resetAll: () => void;
}

const NONE: SectionsApi = { hidden: new Set(), isHidden: () => false, setHidden: () => undefined, showAll: () => undefined, resetAll: () => undefined };
const SectionsContext = createContext<SectionsApi>(NONE);

/** Keeps which sections are hidden, for the sidebar and the page at once, and remembers it between runs. */
export function SectionsProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [hidden, setHiddenState] = useState<ReadonlySet<SectionId>>(() => loadHidden());
  const setHidden = useCallback((id: SectionId, hide: boolean) => {
    setHiddenState((prev) => {
      if (prev.has(id) === hide) return prev;
      const next = new Set(prev);
      if (hide) next.add(id);
      else next.delete(id);
      saveHidden(next);
      return next;
    });
  }, []);
  const showAll = useCallback(() => {
    setHiddenState(() => {
      const next = new Set<SectionId>();
      saveHidden(next);
      return next;
    });
  }, []);
  const resetAll = useCallback(() => {
    setHiddenState(() => {
      const next = new Set<SectionId>(DEFAULT_HIDDEN);
      saveHidden(next);
      return next;
    });
  }, []);
  const api = useMemo<SectionsApi>(() => ({ hidden, isHidden: (id) => hidden.has(id), setHidden, showAll, resetAll }), [hidden, setHidden, showAll, resetAll]);
  return <SectionsContext.Provider value={api}>{children}</SectionsContext.Provider>;
}

export function useSections(): SectionsApi {
  return useContext(SectionsContext);
}

const LABEL: Record<string, string> = Object.fromEntries(SECTIONS.map((s) => [s.id, s.label]));

/**
 * One part of the window with a hide button. Hidden, it renders nothing at all (so a column with nothing left in it closes up); the Layout
 * menu in the top bar brings it back.
 */
export function Section({
  id,
  title,
  actions,
  className = '',
  children,
}: {
  id: SectionId;
  title?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement | null {
  const s = useSections();
  if (s.isHidden(id)) return null;
  return (
    <section className={`sec ${title === undefined ? 'bare' : ''} ${className}`.trim()} data-section={id} aria-label={title ?? LABEL[id]}>
      {title !== undefined ? (
        <div className="sec-head">
          <h2>{title}</h2>
          <span className="sec-spacer" />
          {actions}
          <HideButton id={id} />
        </div>
      ) : (
        <HideButton id={id} floating />
      )}
      {children}
    </section>
  );
}

function HideButton({ id, floating = false }: { id: SectionId; floating?: boolean }): React.ReactElement {
  const s = useSections();
  return (
    <button type="button" className={`sec-hide ${floating ? 'floating' : ''}`} title={`Hide ${LABEL[id] ?? 'this section'}`} aria-label={`Hide ${LABEL[id] ?? 'this section'}`} onClick={() => s.setHidden(id, true)}>
      <Icon name="eyeoff" size={14} />
    </button>
  );
}

/** The Layout button of the top bar: every section with a switch, to hide or bring back any of them. */
export function LayoutMenu(): React.ReactElement {
  const s = useSections();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  const changed = SECTIONS.filter((x) => s.isHidden(x.id) !== DEFAULT_HIDDEN.includes(x.id)).length;
  return (
    <div className="layout-menu" ref={box}>
      <button type="button" className={`tb-btn round ${open ? 'on' : ''}`} onClick={() => setOpen((o) => !o)} title="Choose what shows on screen" aria-label="Layout: show or hide sections" aria-expanded={open}>
        <Icon name="layout" size={17} />
        {changed > 0 && <span className="tb-badge">{changed}</span>}
      </button>
      {open && (
        <div className="layout-pop" role="dialog" aria-label="Show or hide sections">
          <div className="layout-title">Show on screen</div>
          <div className="layout-note">The panel on the right opens while Agent is working on a task: these are the cards it can hold.</div>
          <ul>
            {SECTIONS.map((x) => (
              <li key={x.id}>
                <span>{x.label}</span>
                <Toggle on={!s.isHidden(x.id)} onChange={(on) => s.setHidden(x.id, !on)} label={x.label} />
              </li>
            ))}
          </ul>
          <div className="layout-actions">
            <button type="button" className="btn small" disabled={s.hidden.size === 0} onClick={s.showAll}>
              Show everything
            </button>
            <button type="button" className="btn small" disabled={changed === 0} onClick={s.resetAll}>
              Back to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small line under a column that has hidden parts, to bring them back. */
export function HiddenNote({ ids }: { ids: readonly SectionId[] }): React.ReactElement | null {
  const s = useSections();
  const hidden = ids.filter((id) => s.isHidden(id));
  if (hidden.length === 0) return null;
  return (
    <div className="hidden-note">
      {hidden.map((id) => (
        <button key={id} type="button" className="hidden-chip" onClick={() => s.setHidden(id, false)} title={`Show ${LABEL[id]}`}>
          <Icon name="eye" size={12} /> {LABEL[id]}
        </button>
      ))}
    </div>
  );
}
