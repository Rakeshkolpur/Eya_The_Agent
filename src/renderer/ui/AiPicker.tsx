import React from 'react';
import { routeBadge, shortModel } from '../../shared/aiRoute';
import type { EyaControl } from '../control';

/**
 * Which AI is answering — and the way to change it.
 *
 * The badge says who is connected: "Gemini connected", or, once Gemini's allowance is over, the model that took over ("OpenRouter ·
 * nemotron-3-super-120b-a12b" with "Gemini limit over" under it). Clicking it opens the list: Automatic (Gemini first, then the
 * backups in order) or any model of any backup AI, which is then asked first.
 */
export function AiPicker({ c, whileLoading = 'Connecting…', className = '' }: { c: EyaControl; whileLoading?: string; className?: string }): React.ReactElement {
  const route = c.aiRoute;
  const badge = routeBadge(route, whileLoading);
  const backups = route?.backups ?? [];
  // (The local AI is always on the list, so there is always something to pick.)
  const canPick = true;
  // The one the user chose is the first backup, and only while "the backup first" is on.
  const chosen = route !== null && route.prefer === 'backup' ? backups[0] : undefined;
  const value = route !== null && (route.prefer === 'local' || route.prefer === 'local-only') ? route.prefer : chosen !== undefined && chosen.model !== null ? `m:${chosen.id}|${chosen.model}` : 'auto';
  const localModel = shortModel(route?.local.model ?? '') || 'llama3.2:1b';

  return (
    <label className={`ai-badge ai-picker ${canPick ? 'pickable' : ''} ${className}`.trim()} title={canPick ? `${badge.title} Click to choose the model.` : badge.title}>
      <span className="ai-badge-main">
        {badge.text}
        {canPick ? ' ▾' : ''}
      </span>
      {badge.sub !== '' && <span className="ai-badge-sub">{badge.sub}</span>}
      {canPick && route !== null && (
        <select
          className="ai-picker-select"
          value={value}
          aria-label="Which AI Eya uses"
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'auto' || v === 'local' || v === 'local-only') {
              void c.chooseAi(v);
              return;
            }
            const cut = v.indexOf('|');
            void c.chooseAi({ id: v.slice(2, cut), model: v.slice(cut + 1) });
          }}
        >
          <option value="auto">{route.gemini === 'no-key' ? 'Automatic' : 'Automatic — Gemini first, then the backups'}</option>
          <optgroup label="On this PC (Ollama, no key)">
            <option value="local">{`Local AI first — ${localModel}, a cloud AI helps with hard requests`}</option>
            <option value="local-only">{`Local AI only — ${localModel}, no cloud AI is asked`}</option>
          </optgroup>
          {backups.map((b) => (
            <optgroup key={b.id} label={`${b.label} — asked first when chosen`}>
              {b.models.map((m) => (
                <option key={m} value={`m:${b.id}|${m}`}>
                  {shortModel(m)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
    </label>
  );
}
