import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { SIDE_EXTRAS, useSections } from './sections';
import type { SectionId } from './sections';

const SIDE_KEY = 'eya.sideCollapsed';
/** Narrower than this the side panel has no room: it is put away (and comes back when the window is wide again). */
const NARROW_QUERY = '(max-width: 1020px)';
/** A task has to go on this long before the side panel opens for it (a quick command never opens it) ... */
export const PANEL_AFTER_MS = 900;
/** ... and it stays this long after the task ends, so the end of it can be read. */
export const PANEL_LINGER_MS = 5000;

/** The two panels about what Eya is doing now: they open on their own while a task works. */
export const TASK_PANELS: readonly SectionId[] = ['agentTimeline', 'agentList'];

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // blocked storage: the choice lasts until the window closes
  }
}

export interface SidePanel {
  /** The panel is on screen right now. */
  readonly shown: boolean;
  /** There is something to show or hide (a task is working, or a card was switched on): the button for it is only there then. */
  readonly canToggle: boolean;
  readonly toggle: () => void;
}

export interface LayoutApi {
  readonly narrow: boolean;
  /** Whether the sidebar is folded to its icons right now (the person's choice, or a screen that needs the room, like the browser beside Eya). */
  readonly sideFolded: boolean;
  /** The one button that folds and unfolds the sidebar. */
  readonly toggleSide: () => void;
  /** A screen that needs the whole width (the browser workspace) folds the sidebar while it is open and gives it back after. */
  readonly setSideAuto: (on: boolean) => void;
  /** Tells the layout whether Eya is working on a task now (from the browser, the tasks she keeps, or a tool running). */
  readonly setTaskActive: (active: boolean) => void;
  readonly panel: SidePanel;
}

const FALLBACK: LayoutApi = {
  narrow: false,
  sideFolded: false,
  toggleSide: () => undefined,
  setSideAuto: () => undefined,
  setTaskActive: () => undefined,
  panel: { shown: false, canToggle: false, toggle: () => undefined },
};

const LayoutContext = createContext<LayoutApi>(FALLBACK);

/**
 * Where things are on the window. Opening the app shows the sidebar and the conversation and nothing else. While a task works, a panel opens on
 * the right with what she is doing (and can be closed); when the browser opens beside Eya the sidebar folds so the two halves have the room.
 */
export function LayoutProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const sections = useSections();
  const [sidePref, setSidePref] = useState(() => read(SIDE_KEY) === 'folded');
  const [auto, setAuto] = useState(false);
  const [autoOpen, setAutoOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY).matches : false));
  const [taskNow, setTaskNow] = useState(false);
  const [taskShown, setTaskShown] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_QUERY);
    const on = (): void => setNarrow(query.matches);
    on();
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);

  // The panel opens once a task has really started and closes a while after it ended.
  useEffect(() => {
    const t = window.setTimeout(() => setTaskShown(taskNow), taskNow ? PANEL_AFTER_MS : PANEL_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [taskNow]);

  const extrasOn = SIDE_EXTRAS.some((id) => !sections.isHidden(id));
  const taskPanelsOn = TASK_PANELS.some((id) => !sections.isHidden(id));
  // A new task brings the panel back even if it was closed before.
  useEffect(() => {
    if (taskShown) setDismissed(false);
  }, [taskShown]);

  const toggleSide = useCallback(() => {
    if (auto) {
      setAutoOpen((o) => !o);
      return;
    }
    setSidePref((s) => {
      write(SIDE_KEY, s ? 'open' : 'folded');
      return !s;
    });
  }, [auto]);
  const setSideAuto = useCallback((on: boolean) => {
    setAuto(on);
    setAutoOpen(false);
  }, []);
  const setTaskActive = useCallback((active: boolean) => setTaskNow(active), []);
  const togglePanel = useCallback(() => setDismissed((d) => !d), []);

  // (only beside a task Agent is working on: nothing else opens it, however the cards are switched in the Layout menu)
  const wanted = taskShown && (taskPanelsOn || extrasOn);
  const canToggle = wanted && !narrow;
  const api = useMemo<LayoutApi>(
    () => ({
      narrow,
      sideFolded: auto ? !autoOpen : sidePref,
      toggleSide,
      setSideAuto,
      setTaskActive,
      panel: { shown: canToggle && !dismissed, canToggle, toggle: togglePanel },
    }),
    [narrow, auto, autoOpen, sidePref, toggleSide, setSideAuto, setTaskActive, canToggle, dismissed, togglePanel],
  );
  return <LayoutContext.Provider value={api}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutApi {
  return useContext(LayoutContext);
}
