import React, { useRef } from 'react';
import type { OrbState } from '../shared/types';

/** How far the pointer must travel (in pixels) before a press becomes a drag instead of a click. */
export const DRAG_THRESHOLD = 5;

export interface BubbleProps {
  readonly state: OrbState;
  /** The microphone is open (voice on and listening). */
  readonly live: boolean;
  /** The window is open as the quick assistant. */
  readonly open: boolean;
  /** Eya may use chat apps right now. */
  readonly chatsOn: boolean;
  /** She has an open offer (save this as a routine?) waiting for an answer. */
  readonly offer: boolean;
  /** Eya is looking at the screen: always visible, so it can never happen unnoticed. */
  readonly sharing: boolean;
  /** A click: open the assistant (or, when it is already open, put it away). */
  readonly onClick: () => void;
}

/**
 * Eya's bubble: a small orb you can leave anywhere. Click it to ask her something; drag it anywhere and it settles against the nearest
 * edge; right-click for the menu. The dragging itself is done by the main process following the pointer (the window moves, not the
 * page), so this only has to tell a click from a drag.
 */
export function Bubble({ state, live, open, chatsOn, offer, sharing, onClick }: BubbleProps): React.ReactElement {
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);

  return (
    <div className="bubble-cell">
      <div
        className="orb"
        data-state={state}
        data-expanded={open ? 'true' : 'false'}
        data-live={live ? 'true' : 'false'}
        data-chats={chatsOn ? 'true' : 'false'}
        data-sharing={sharing ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        aria-label="Eya"
        title="Eya — click to ask, drag to move, right-click for more"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          press.current = { x: e.screenX, y: e.screenY, dragging: false };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p === null || p.dragging || open) return;
          if (Math.hypot(e.screenX - p.x, e.screenY - p.y) > DRAG_THRESHOLD) {
            p.dragging = true;
            window.eya.dragWindow('start');
          }
        }}
        onPointerUp={(e) => {
          const p = press.current;
          press.current = null;
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
          if (p === null) return;
          if (p.dragging) window.eya.dragWindow('end');
          else onClick();
        }}
        onPointerCancel={() => {
          if (press.current?.dragging === true) window.eya.dragWindow('end');
          press.current = null;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          window.eya.showBubbleMenu();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick();
          }
        }}
      />
      {chatsOn && <span className="bubble-badge chats" title="Chats are ON" />}
      {offer && <span className="bubble-badge offer" title="Eya has a question" />}
      {sharing && <span className="bubble-badge sharing" title="Eya can see your screen" />}
    </div>
  );
}
