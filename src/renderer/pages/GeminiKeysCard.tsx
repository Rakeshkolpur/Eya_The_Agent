import React, { useState } from 'react';
import { describeKey } from '../../shared/geminiKeys';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';
import { SettingRow } from '../ui/widgets';

/**
 * More Gemini keys: the person's own, then keys from family or friends (each from their own free Google account), used one after another.
 * Names a key and shows how it stands; never shows or sends a key back.
 */
export function GeminiKeysCard({ c }: { c: EyaControl }): React.ReactElement {
  const status = c.geminiKeys;
  const entries = status?.entries ?? [];
  const extra = entries.filter((e) => !e.main).length;
  const [name, setName] = useState('');
  const [keyText, setKeyText] = useState('');
  const [several, setSeveral] = useState(false);
  const [lines, setLines] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const canSave = status?.canSave !== false;
  const full = status !== null && extra >= status.max;

  const add = (): void => {
    setBusy(true);
    setNote(null);
    void c
      .addGeminiKeys(several ? { lines } : { name, key: keyText })
      .then((r) => {
        setNote({ ok: r.ok, text: r.message });
        if (r.ok) {
          setName('');
          setKeyText('');
          setLines('');
        }
      })
      .catch(() => setNote({ ok: false, text: "That couldn't be saved just now. Try again in a moment." }))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <h3 className="set-sub">More Gemini keys: family and friends</h3>
      <div className="set-note">
        <Icon name="info" size={15} />
        <span>
          Each person makes their own free key at <b>aistudio.google.com/apikey</b> (signed in with their own Google account) and gives it to you. Eya uses your key first;
          when its free allowance for the day is used up she moves on to the next one by herself, for answers, reading, speech and the live voice, and comes back to
          the first when the day resets. Only add keys that people have given you for this. Each key is stored encrypted by Windows for your account only, is never shown
          again, and is sent only to Google.
        </span>
      </div>

      {entries.length > 0 && (
        <div className="set-note">
          <Icon name="bolt" size={15} />
          <span>
            {entries.length === 1 ? 'Only your own key so far.' : `${entries.length} keys, used in this order.`}
            {entries.every((e) => e.state === 'used-up') && entries.length > 1 ? ' Every key has used its free allowance for today.' : ''}
          </span>
        </div>
      )}

      {entries.map((e, i) => (
        <SettingRow key={e.id} name={`${i + 1}. ${e.main ? 'Your own key' : e.name}`} desc={`key ${e.hint} · ${describeKey(e)}`}>
          <button
            type="button"
            className="btn"
            disabled={testing !== null}
            onClick={() => {
              setTesting(e.id);
              setNote(null);
              void c
                .testGeminiKeyEntry(e.id)
                .then((r) => setNote({ ok: r.ok, text: r.message }))
                .catch(() => setNote({ ok: false, text: "The test couldn't run. Try again in a moment." }))
                .finally(() => setTesting(null));
            }}
          >
            {testing === e.id ? 'Testing…' : 'Test'}
          </button>
          {!e.main && (
            <button type="button" className="btn" onClick={() => void c.removeGeminiKeyEntry(e.id).then((r) => setNote({ ok: r.ok, text: r.message }))}>
              Remove
            </button>
          )}
        </SettingRow>
      ))}

      <h3 className="set-sub">Add a key</h3>
      {!several ? (
        <SettingRow
          name="Name and key"
          desc={
            !canSave
              ? "Windows can't protect saved keys on this account, so they can't be saved here."
              : full
                ? `That is the most (${status?.max ?? 10}) extra keys. Remove one to add another.`
                : "Who it belongs to (Father, Brother…), then their key. Eya checks it with Google, then saves it."
          }
        >
          <div className="key-row">
            <input className="ask-input" style={{ maxWidth: 120 }} type="text" autoComplete="off" spellCheck={false} value={name} placeholder="Father" aria-label="Whose key" maxLength={24} disabled={busy || !canSave || full} onChange={(e) => setName(e.target.value)} />
            <input className="ask-input" type="password" autoComplete="off" spellCheck={false} value={keyText} placeholder="AIza…" aria-label="Their Gemini API key" disabled={busy || !canSave || full} onChange={(e) => setKeyText(e.target.value)} />
            <button type="button" className="btn primary" disabled={busy || keyText.trim() === '' || !canSave || full} onClick={add}>
              {busy ? 'Checking…' : 'Add'}
            </button>
          </div>
        </SettingRow>
      ) : (
        <SettingRow name="Several keys at once" desc="One to a line: the name, then the key (Father AIza…). Each is checked with Google, then saved.">
          <div className="key-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <textarea
              className="ask-input"
              rows={5}
              spellCheck={false}
              autoComplete="off"
              value={lines}
              placeholder={'Father  AIza…\nBrother  AIza…\nMother  AIza…'}
              aria-label="Names and Gemini API keys, one to a line"
              disabled={busy || !canSave || full}
              onChange={(e) => setLines(e.target.value)}
            />
            <button type="button" className="btn primary" disabled={busy || lines.trim() === '' || !canSave || full} onClick={add}>
              {busy ? 'Checking…' : 'Add all'}
            </button>
          </div>
        </SettingRow>
      )}
      <div className="set-note">
        <button type="button" className="btn" onClick={() => setSeveral((s) => !s)}>
          {several ? 'Add one key' : 'Add several at once'}
        </button>
      </div>

      {note !== null && (
        <div className={`set-note ${note.ok ? '' : 'bad'}`}>
          <Icon name={note.ok ? 'info' : 'lock'} size={15} />
          <span>{note.text}</span>
        </div>
      )}
      {status?.pendingRestart === true && (
        <div className="set-note">
          <Icon name="info" size={15} />
          <span>Eya started without any Gemini key, so restart her once to switch on everything a key gives (reading documents and your screen, the live voice). Quit her from the tray icon and open her again.</span>
        </div>
      )}
    </>
  );
}
