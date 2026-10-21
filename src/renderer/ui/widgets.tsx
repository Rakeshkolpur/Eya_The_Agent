import React from 'react';
import type { ActivityKind } from '../../shared/ipcContract';
import { useMotion } from '../motion';
import { Icon } from './icons';
import type { IconName } from './icons';

/** An on/off switch. */
export function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }): React.ReactElement {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span className="switch-knob" />
    </button>
  );
}

/** A settings line: a name, what it does, and its control on the right. */
export function SettingRow({ name, desc, children }: { name: string; desc?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-name">{name}</div>
        {desc !== undefined && <div className="set-desc">{desc}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

const KIND_ICON: Record<ActivityKind, IconName> = { action: 'bolt', file: 'file', web: 'globe', chat: 'chat' };
export const KIND_LABEL: Record<ActivityKind, string> = { action: 'Actions', file: 'Files', web: 'Web', chat: 'Communication' };

/** The little round icon that says what kind of thing an entry was. */
export function KindIcon({ kind, ok }: { kind: ActivityKind; ok: boolean }): React.ReactElement {
  return (
    <span className={`kind-icon k-${kind} ${ok ? "" : "failed"}`} title={KIND_LABEL[kind]}>
      <Icon name={KIND_ICON[kind]} size={17} />
    </span>
  );
}

/** A face for Eya: the same blue orb as the bubble, large, with the same moods. */
export function BigOrb({ state, size = 120 }: { state: string; size?: number }): React.ReactElement {
  useMotion(state !== 'idle');
  return (
    <div className="big-orb" style={{ width: size, height: size }} data-state={state}>
      <span className="eye left" />
      <span className="eye right" />
      <span className="smile" />
    </div>
  );
}

/** A busy spinner. It turns from the page's motion clock (a few steps a second), not a CSS loop, which would keep the graphics chip busy. */
export function Spinner({ className = '' }: { className?: string }): React.ReactElement {
  useMotion(true);
  return <span className={`spinner ${className}`.trim()} aria-hidden="true" />;
}
