import React, { useEffect, useState } from 'react';
import { VOICE_OPTIONS } from '../../shared/constants';
import { OPENAI_VOICES } from '../../shared/openaiVoice';
import { BACKUP_AI_PRESETS, backupPreset, isBackupAiProvider, providerFromKey } from '../../shared/backupAi';
import { shortModel } from '../../shared/aiRoute';
import type { BackupAiProvider } from '../../shared/backupAi';
import { CommunicationBox } from '../AssistantPanel';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';
import type { IconName } from '../ui/icons';
import { SettingRow, Toggle } from '../ui/widgets';
import { AiPicker } from '../ui/AiPicker';
import { TIER_LABEL, TIER_SUMMARY } from '../../shared/performance';
import type { PerformanceSetting } from '../../shared/performance';

export type Section = 'general' | 'voice' | 'gemini' | 'openai' | 'backup' | 'writing' | 'performance' | 'privacy' | 'about';
const SECTIONS: ReadonlyArray<{ id: Section; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'settings' },
  { id: 'voice', label: 'Voice & Wake Word', icon: 'mic' },
  { id: 'gemini', label: 'Gemini key', icon: 'lock' },
  { id: 'openai', label: 'ChatGPT (OpenAI)', icon: 'bolt' },
  { id: 'backup', label: 'Backup AI', icon: 'bolt' },
  { id: 'writing', label: 'Writing Watch', icon: 'eye' },
  { id: 'performance', label: 'Performance', icon: 'bolt' },
  { id: 'privacy', label: 'Privacy & Chats', icon: 'shield' },
  { id: 'about', label: 'About', icon: 'info' },
];

/** How an AI is named in the usage list: "gemini" → Gemini, "openrouter" → OpenRouter, "custom-api.example.com" → api.example.com. */
function aiName(name: string): string {
  if (name === 'gemini') return 'Gemini';
  if (name.startsWith('custom-')) return name.slice('custom-'.length);
  if (isBackupAiProvider(name)) return backupPreset(name).label;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Settings. Chats ON/OFF (Communication Access) lives under Privacy; everything here is the user's own switch. */
export function SettingsPage({ c, startOn }: { c: EyaControl; startOn?: Section }): React.ReactElement {
  const [section, setSection] = useState<Section>(startOn ?? 'general');
  const [sure, setSure] = useState(false);
  const [keyText, setKeyText] = useState('');
  const [keyNote, setKeyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [keyBusy, setKeyBusy] = useState(false);
  const [checkNote, setCheckNote] = useState('');
  const [checking, setChecking] = useState(false);
  const [backupProvider, setBackupProvider] = useState<BackupAiProvider>('mistral');
  const [backupKey, setBackupKey] = useState('');
  const [backupModel, setBackupModel] = useState('');
  const [backupUrl, setBackupUrl] = useState('');
  const [backupNote, setBackupNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiNote, setOpenaiNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [openaiBusy, setOpenaiBusy] = useState(false);
  const [voiceTesting, setVoiceTesting] = useState(false);
  const { refreshAiUsage } = c;
  const backups = c.backupAi?.entries ?? [];
  useEffect(() => {
    if (section === 'backup') refreshAiUsage();
  }, [section, refreshAiUsage]);
  const w = c.writing;
  const key = c.geminiKey;
  const s = c.settings?.settings;
  const info = c.settings?.info;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((x) => (
          <button key={x.id} type="button" className={`settings-nav-item ${section === x.id ? 'on' : ''}`} onClick={() => setSection(x.id)} aria-current={section === x.id}>
            <Icon name={x.icon} size={17} />
            {x.label}
          </button>
        ))}
      </nav>
      <div className="settings-body card scroll">
        {section === 'general' && (
          <>
            <h2>General</h2>
            <SettingRow name="Show the floating bubble" desc="A small bubble you can leave in any corner. Click it to ask Eya something; drag it to move it. If you hide it, open Eya from the tray icon.">
              <Toggle on={s?.showBubble ?? true} label="Show the floating bubble" onChange={(on) => c.changeSettings({ showBubble: on })} />
            </SettingRow>
            <SettingRow name="Click the bubble to talk" desc="Start a live conversation as soon as you click the bubble, like tapping a phone assistant. Off: it just opens the box to type in.">
              <Toggle on={s?.tapToTalk ?? true} label="Click the bubble to talk" onChange={(on) => c.changeSettings({ tapToTalk: on })} />
            </SettingRow>
            <SettingRow
              name="Start with Windows"
              desc={info?.startWithWindows === null ? 'Available in the installed app. When run from source it would start a bare Electron, so it is switched off here.' : 'Open Eya as a bubble when you sign in.'}
            >
              <Toggle on={info?.startWithWindows === true} label="Start with Windows" disabled={info?.startWithWindows === null || info === undefined} onChange={(on) => c.changeSettings({ startWithWindows: on })} />
            </SettingRow>
            <SettingRow name="Let me talk over Eya" desc="Interrupt her while she is speaking and she stops. Works best with headphones.">
              <Toggle on={c.interruptOn} label="Let me talk over Eya" onChange={c.toggleInterrupt} />
            </SettingRow>
          </>
        )}
        {section === 'voice' && (
          <>
            <h2>Voice &amp; Wake Word</h2>
            <SettingRow name="Voice and wake word “Hey Eya”" desc={c.wakeReady ? 'Eya listens for her name on this PC and speaks her answers.' : 'Eya listens and speaks. (The on-device wake-word model is not available, so she notices her name in what she hears.)'}>
              <Toggle on={c.voiceOn} label="Voice and wake word" onChange={c.toggleVoice} />
            </SettingRow>
            {c.voiceEngine === 'openai' && (
              <SettingRow name="Eya's voice" desc="ChatGPT is your main AI, so Eya speaks with ChatGPT's voice. Choose it, and listen to it, in the ChatGPT (OpenAI) page.">
                <span className="pill">{(OPENAI_VOICES.find((v) => v.id === c.openaiVoice)?.label ?? c.openaiVoice).split(' — ')[0]}</span>
              </SettingRow>
            )}
            <SettingRow name={c.voiceEngine === 'openai' ? "Gemini's voice (used when Gemini is the main AI)" : "Eya's voice"}>
              <select className="select" value={c.voiceName} onChange={(e) => c.changeVoiceName(e.target.value)} aria-label="Eya's voice">
                <optgroup label="Female">
                  {VOICE_OPTIONS.filter((v) => v.gender === 'female').map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </optgroup>
                <optgroup label="Male">
                  {VOICE_OPTIONS.filter((v) => v.gender === 'male').map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </optgroup>
              </select>
            </SettingRow>
            <SettingRow name="Speech recognition" desc="Your voice is turned into text on this PC when it can be; otherwise Gemini does it.">
              <span className="pill">{c.sttState === 'ready' ? 'On this PC' : c.sttState === 'loading' ? 'Loading…' : 'Cloud'}</span>
            </SettingRow>
          </>
        )}
        {section === 'privacy' && (
          <>
            <h2>Privacy &amp; Chats</h2>
            <div className="set-block">
              {c.comm !== null ? <CommunicationBox comm={c.comm} change={c.changeComm} /> : <div className="empty">Loading…</div>}
            </div>
            <SettingRow name="Keep a list of what Eya does" desc="Short titles only, on this PC, for the Recent screen. Nothing from chat apps is listed and nothing private is saved.">
              <Toggle on={s?.keepHistory ?? true} label="Keep a list of what Eya does" onChange={(on) => c.changeSettings({ keepHistory: on })} />
            </SettingRow>
            <SettingRow name="Clear the list" desc={`${c.activity?.items.length ?? 0} item${(c.activity?.items.length ?? 0) === 1 ? '' : 's'} kept right now.`}>
              {sure ? (
                <>
                  <button type="button" className="btn danger" onClick={() => { c.actOnActivity({ kind: 'clear' }); setSure(false); }}>
                    Yes, clear it
                  </button>
                  <button type="button" className="btn" onClick={() => setSure(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="btn" onClick={() => setSure(true)} disabled={(c.activity?.items.length ?? 0) === 0}>
                  Clear
                </button>
              )}
            </SettingRow>
            <div className="set-note">
              <Icon name="lock" size={15} />
              <span>
                Memory (what you asked Eya to remember and your routines) is a database on this PC: <code>{info?.memoryPath ?? '…'}</code>
              </span>
            </div>
          </>
        )}
        {section === 'gemini' && (
          <>
            <h2>Gemini key</h2>
            <div className="set-note">
              <Icon name="info" size={15} />
              <span>
                Eya works out everyday requests on this PC with no key at all: opening apps, folders, files and sites, searching, downloads, and messaging by name. A Gemini key
                adds conversation, reading documents and your screen, and the live voice. Get your own free key at <b>aistudio.google.com/apikey</b>.
              </span>
            </div>
            <SettingRow
              name={key === null || key.source === 'none' ? 'No key yet' : key.source === 'env' ? `A key is in use (${key.hint})` : `Your saved key is in use (${key.hint})`}
              desc={
                key?.source === 'env'
                  ? 'It comes from a .env file or the environment, which Eya uses first.'
                  : 'It is stored encrypted by Windows for your account only, is never shown again, and is sent only to Google.'
              }
            >
              {key?.source === 'saved' && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void c.removeGeminiKey().then((r) => setKeyNote({ ok: r.ok, text: r.message }));
                  }}
                >
                  Remove
                </button>
              )}
            </SettingRow>
            <SettingRow name="Paste your key" desc={key?.canSave === false ? "Windows can't protect a saved key on this account, so it can't be saved here." : 'Eya checks it with Google, then saves it.'}>
              <div className="key-row">
                <input
                  className="ask-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={keyText}
                  placeholder="AIza…"
                  aria-label="Gemini API key"
                  disabled={keyBusy || key?.canSave === false}
                  onChange={(e) => setKeyText(e.target.value)}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={keyBusy || keyText.trim() === '' || key?.canSave === false}
                  onClick={() => {
                    setKeyBusy(true);
                    void c
                      .saveGeminiKey(keyText)
                      .then((r) => {
                        setKeyNote({ ok: r.ok, text: r.message });
                        if (r.ok) setKeyText('');
                      })
                      .finally(() => setKeyBusy(false));
                  }}
                >
                  {keyBusy ? 'Checking…' : 'Save'}
                </button>
              </div>
            </SettingRow>
            {keyNote !== null && (
              <div className={`set-note ${keyNote.ok ? '' : 'bad'}`}>
                <Icon name={keyNote.ok ? 'info' : 'lock'} size={15} />
                <span>{keyNote.text}</span>
              </div>
            )}
            {key?.pendingRestart === true && (
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>
                  The change takes effect when Eya restarts.
                  {info?.packaged === true ? (
                    <>
                      {' '}
                      <button type="button" className="btn" onClick={c.relaunch}>
                        Restart Eya now
                      </button>
                    </>
                  ) : (
                    ' Quit Eya from the tray icon and open her again.'
                  )}
                </span>
              </div>
            )}
          </>
        )}
        {section === 'openai' && (() => {
          const entry = backups.find((b) => b.id === 'openai');
          const isMain = c.voiceEngine === 'openai';
          return (
            <>
              <h2>ChatGPT (OpenAI)</h2>
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>
                  Add your OpenAI key and Eya uses ChatGPT as her main AI and speaks with ChatGPT's voice, and only that voice. Switch back to Gemini any time with
                  the AI list at the top (Automatic) or below. This needs an OpenAI <b>API key</b> (platform.openai.com/api-keys, with a small prepaid credit): a
                  ChatGPT subscription does not include one. OpenAI charges your account for what is used, a few paise a request.
                </span>
              </div>
              {entry !== undefined && (
                <>
                  <SettingRow name="ChatGPT" desc={`${shortModel(entry.model)} · key ${entry.hint}${isMain ? ' · the main AI' : ' · saved, but Gemini is asked first'}`}>
                    <button
                      type="button"
                      className="btn"
                      disabled={testingId !== null}
                      onClick={() => {
                        setTestingId('openai');
                        setOpenaiNote(null);
                        void c
                          .testBackupAi('openai')
                          .then((r) => setOpenaiNote({ ok: r.ok, text: r.message }))
                          .catch(() => setOpenaiNote({ ok: false, text: "The test couldn't run. Try again in a moment." }))
                          .finally(() => setTestingId(null));
                      }}
                    >
                      {testingId === 'openai' ? 'Testing…' : 'Test'}
                    </button>
                    <button type="button" className="btn" onClick={() => void c.removeBackupAi('openai').then((r) => setOpenaiNote({ ok: r.ok, text: r.message }))}>
                      Remove
                    </button>
                  </SettingRow>
                  <SettingRow name="Which AI answers" desc="Make ChatGPT the main AI, or go back to Gemini first (then ChatGPT and your other backups carry on when Gemini runs out).">
                    {isMain ? (
                      <button type="button" className="btn" onClick={() => void c.chooseAi('auto')}>
                        Use Gemini first
                      </button>
                    ) : (
                      <button type="button" className="btn primary" onClick={() => void c.chooseAi({ id: 'openai', model: entry.model })}>
                        Use ChatGPT first
                      </button>
                    )}
                  </SettingRow>
                  {entry.models.length > 1 && (
                    <SettingRow name="Model" desc="Quicker models answer sooner; bigger ones think more. The list is what your key can use.">
                      <select className="select" value={entry.model} aria-label="ChatGPT model" onChange={(e) => void c.chooseAi({ id: 'openai', model: e.target.value })}>
                        {entry.models.map((m) => (
                          <option key={m} value={m}>
                            {shortModel(m)}
                          </option>
                        ))}
                      </select>
                    </SettingRow>
                  )}
                  <SettingRow
                    name="ChatGPT's voice"
                    desc="Eya speaks with this voice while ChatGPT is the main AI. If it cannot play (no credit, no connection), she uses the voice on this PC, never Gemini's."
                  >
                    <select className="select" value={c.openaiVoice} aria-label="ChatGPT voice" onChange={(e) => c.changeOpenaiVoice(e.target.value)}>
                      {OPENAI_VOICES.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn"
                      disabled={voiceTesting}
                      onClick={() => {
                        setVoiceTesting(true);
                        setOpenaiNote(null);
                        void c
                          .previewOpenaiVoice(c.openaiVoice)
                          .then((ok) => setOpenaiNote(ok ? { ok: true, text: 'That is how I sound with this voice.' } : { ok: false, text: "ChatGPT's voice couldn't play: check the key has credit, or the connection, and try Test." }))
                          .finally(() => setVoiceTesting(false));
                      }}
                    >
                      {voiceTesting ? 'Playing…' : 'Listen'}
                    </button>
                  </SettingRow>
                </>
              )}
              <h3 className="set-sub">{entry === undefined ? 'Add your OpenAI key' : 'Replace the key'}</h3>
              <SettingRow name="Paste the key" desc="Eya tests it with OpenAI, saves it encrypted by Windows, and starts using ChatGPT at once. No restart.">
                <div className="key-row">
                  <input
                    className="ask-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={openaiKey}
                    placeholder="sk-…"
                    aria-label="OpenAI API key"
                    disabled={openaiBusy || c.backupAi?.canSave === false}
                    onChange={(e) => setOpenaiKey(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={openaiBusy || openaiKey.trim() === '' || c.backupAi?.canSave === false}
                    onClick={() => {
                      setOpenaiBusy(true);
                      setOpenaiNote(null);
                      void c
                        .saveBackupAi({ provider: 'openai', key: openaiKey })
                        .then((r) => {
                          setOpenaiNote({ ok: r.ok, text: r.message });
                          if (r.ok) setOpenaiKey('');
                        })
                        .finally(() => setOpenaiBusy(false));
                    }}
                  >
                    {openaiBusy ? 'Checking…' : 'Save'}
                  </button>
                </div>
              </SettingRow>
              {openaiNote !== null && (
                <div className={`set-note ${openaiNote.ok ? '' : 'bad'}`}>
                  <Icon name={openaiNote.ok ? 'info' : 'lock'} size={15} />
                  <span>{openaiNote.text}</span>
                </div>
              )}
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>
                  Talking: when ChatGPT is the main AI, "Hey Eya" (or tapping the bubble) starts a hands-free conversation with ChatGPT: your voice is turned into text on
                  this PC, ChatGPT answers, and Eya speaks in ChatGPT's voice, then listens again. Say "thanks" or "bye" to end it. She cannot be interrupted while she is speaking in
                  this mode (that is a Gemini Live feature).
                </span>
              </div>
            </>
          );
        })()}
        {section === 'backup' && (
          <>
            <h2>Backup AI</h2>
            <div className="set-note">
              <Icon name="info" size={15} />
              <span>
                A free Gemini key allows only a small number of requests a day, and one task from you can take several. Add one or more backup AIs
                (a free key from Mistral, Cerebras, OpenRouter and others) and Eya carries on with them when Gemini has run out or is busy, and goes
                back to Gemini when it returns. Each key has its own allowance, so more keys means more for the day. Eya asks them in the order
                listed below. Opening apps, files, folders and sites, searching, downloads, Word shortcuts and messaging by name never use an AI at all.
              </span>
            </div>
            {c.aiUsage !== null && (
              <SettingRow name="Used today" desc="Requests each AI has answered since the day began (the free allowance resets at 5:30 AM India time).">
                <div className="usage-list">
                  {c.aiUsage.providers
                    .filter((p) => p.name !== 'ollama' && (p.requests > 0 || p.limitedAfter !== undefined || p.restingUntil !== undefined))
                    .map((p) => (
                      <div key={p.name}>
                        <b>{aiName(p.name)}</b>: {p.requests}
                        {p.limitedAfter !== undefined ? ` (allowance ran out after ${p.limitedAfter})` : ''}
                        {p.restingUntil !== undefined && p.limitedAfter === undefined ? ' (resting for a moment)' : ''}
                      </div>
                    ))}
                  {c.aiUsage.providers.every((p) => p.requests === 0 && p.limitedAfter === undefined) && <span>Nothing yet today.</span>}
                </div>
              </SettingRow>
            )}
            <SettingRow
              name="Which AI answers"
              desc="Automatic asks Gemini first and then your backups in order, and goes back to Gemini when it returns. Or pick one model to ask first."
            >
              <AiPicker c={c} className="in-row" />
            </SettingRow>

            <h3 className="set-sub">{`Your backup AIs (${backups.length} of ${c.backupAi?.max ?? 6})`}</h3>
            {backups.length === 0 && (
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>None yet. Add the first below.</span>
              </div>
            )}
            {backups.map((e, i) => {
              // What the last real request found out about it (a refused key is the one to replace).
              const passed = c.aiRoute?.passedOver.find((p) => p.label === e.label);
              const health =
                passed === undefined
                  ? ''
                  : passed.why === 'refused'
                    ? ' · the service refused this key: press Test, or paste a new key below'
                    : passed.why === 'credit'
                      ? ' · no credit left on this account: add credit with them and it works again at once'
                      : passed.why === 'limit'
                      ? ' · its allowance is over for now'
                      : ' · resting for a moment';
              return (
                <SettingRow
                  key={e.id}
                  name={`${i + 1}. ${e.label}`}
                  desc={`${shortModel(e.model)}${e.extraModels > 0 ? ` and ${e.extraModels} more` : ''} · key ${e.hint}${e.source === 'env' ? ' · from your .env file' : ''}${health}`}
                >
                  <button
                    type="button"
                    className="btn"
                    disabled={testingId !== null}
                    onClick={() => {
                      setTestingId(e.id);
                      setBackupNote(null);
                      void c
                        .testBackupAi(e.id)
                        .then((r) => setBackupNote({ ok: r.ok, text: r.message }))
                        .catch(() => setBackupNote({ ok: false, text: "The test couldn't run. Try again in a moment." }))
                        .finally(() => setTestingId(null));
                    }}
                  >
                    {testingId === e.id ? 'Testing…' : 'Test'}
                  </button>
                  {e.source === 'saved' && (
                    <button type="button" className="btn" onClick={() => void c.removeBackupAi(e.id).then((r) => setBackupNote({ ok: r.ok, text: r.message }))}>
                      Remove
                    </button>
                  )}
                </SettingRow>
              );
            })}

            <h3 className="set-sub">Add another AI</h3>
            <SettingRow
              name="Service"
              desc={backupPreset(backupProvider).note + (backupPreset(backupProvider).keyPage !== '' ? ` Get a key at ${backupPreset(backupProvider).keyPage}.` : '')}
            >
              <select className="select" value={backupProvider} onChange={(e) => setBackupProvider(e.target.value as BackupAiProvider)} aria-label="Backup AI service">
                {BACKUP_AI_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.keyStart !== undefined ? `${p.label} (key starts ${p.keyStart})` : p.label}
                  </option>
                ))}
              </select>
            </SettingRow>
            {backupProvider === 'custom' && (
              <SettingRow name="Address" desc="Where the service listens, like https://api.example.com/v1 (or http://localhost:1234/v1 for a program on this PC).">
                <input className="ask-input" value={backupUrl} spellCheck={false} placeholder="https://…/v1" aria-label="Backup AI address" onChange={(e) => setBackupUrl(e.target.value)} />
              </SettingRow>
            )}
            <SettingRow name="Model" desc="Leave empty and Eya picks a good one the service offers.">
              <input className="ask-input" value={backupModel} spellCheck={false} placeholder="automatic" aria-label="Backup AI model" onChange={(e) => setBackupModel(e.target.value)} />
            </SettingRow>
            <SettingRow
              name="Paste the key"
              desc={
                c.backupAi?.canSave === false
                  ? "Windows can't protect a saved key on this account, so it can't be saved here."
                  : backups.length >= (c.backupAi?.max ?? 6)
                    ? 'You have the most backup AIs allowed. Remove one to add another.'
                    : 'Eya checks it with the service, then saves it. A key for a service you already added replaces that one.'
              }
            >
              <div className="key-row">
                <input
                  className="ask-input"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={backupKey}
                  placeholder="key…"
                  aria-label="Backup AI key"
                  disabled={backupBusy || c.backupAi?.canSave === false}
                  onChange={(e) => {
                    setBackupKey(e.target.value);
                    // A key with a telltale start can only be one service's: set Service for them so it cannot be saved under the wrong one.
                    const known = providerFromKey(e.target.value);
                    if (known !== undefined && backupProvider !== 'custom') setBackupProvider(known);
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  disabled={backupBusy || (backupKey.trim() === '' && backupProvider !== 'custom') || c.backupAi?.canSave === false}
                  onClick={() => {
                    setBackupBusy(true);
                    void c
                      .saveBackupAi({
                        provider: backupProvider,
                        key: backupKey,
                        ...(backupModel.trim() !== '' ? { model: backupModel.trim() } : {}),
                        ...(backupProvider === 'custom' ? { baseUrl: backupUrl } : {}),
                      })
                      .then((r) => {
                        setBackupNote({ ok: r.ok, text: r.message });
                        if (r.ok) {
                          setBackupKey('');
                          setBackupModel('');
                        }
                      })
                      .finally(() => setBackupBusy(false));
                  }}
                >
                  {backupBusy ? 'Checking…' : 'Save'}
                </button>
              </div>
            </SettingRow>
            {backupNote !== null && (
              <div className={`set-note ${backupNote.ok ? '' : 'bad'}`}>
                <Icon name={backupNote.ok ? 'info' : 'lock'} size={15} />
                <span>{backupNote.text}</span>
              </div>
            )}
          </>
        )}
        {section === 'writing' && (
          <>
            <h2>Writing Watch</h2>
            <div className="set-note">
              <Icon name="info" size={15} />
              <span>
                While this is on, Eya reads the document you are writing — Word, or Notepad and a few plain editors — on this PC, and shows a small card when she sees a
                slip: a word written twice, a date that does not exist, an amount whose figures and words disagree, a name spelled two ways, paragraph numbers that jump. She
                never changes anything unless you click <b>Fix</b>. It is off every time Eya starts, and nothing she reads is saved or sent anywhere.
              </span>
            </div>
            <SettingRow
              name="Watch my writing"
              desc={w === null ? 'Loading…' : !w.watching ? 'Off.' : w.source === null ? 'On. Open your document in Word or Notepad.' : `Watching ${w.source}${w.title !== '' ? ` — ${w.title}` : ''}.`}
            >
              <Toggle on={w?.watching === true} label="Watch my writing" disabled={w === null} onChange={(on) => void c.setWriting({ watching: on })} />
            </SettingRow>
            <SettingRow
              name="Also ask Gemini (this session only)"
              desc={
                w?.cloudAvailable === false
                  ? 'Needs your Gemini key: add it under Gemini key first.'
                  : 'Sends only the paragraph you are writing to Gemini, for a deeper check of grammar and wording. Off until you switch it on, and off again whenever Eya restarts.'
              }
            >
              <Toggle on={w?.cloudAllowed === true} label="Also ask Gemini" disabled={w === null || !w.cloudAvailable} onChange={(on) => void c.setWriting({ cloud: on })} />
            </SettingRow>
            <SettingRow name="Check my whole document now" desc="Reads the open document once and lists everything it finds, including what was there before you started. You can also say “check this document”.">
              <button
                type="button"
                className="btn"
                disabled={checking}
                onClick={() => {
                  setChecking(true);
                  setCheckNote('');
                  void c
                    .checkWriting()
                    .then((n) => setCheckNote(n === 0 ? 'Nothing to correct.' : `${n} thing${n === 1 ? '' : 's'} to look at — see the card near the bubble.`))
                    .catch(() => setCheckNote('I could not read a document just now.'))
                    .finally(() => setChecking(false));
                }}
              >
                {checking ? 'Reading…' : 'Check now'}
              </button>
            </SettingRow>
            {(checkNote !== '' || (w?.note ?? '') !== '') && (
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>{checkNote !== '' ? checkNote : w?.note}</span>
              </div>
            )}
            <div className="set-note">
              <Icon name="lock" size={15} />
              <span>
                Say “watch my writing”, “stop watching”, “check this document”, “fix it”, “ignore it” or “allow cloud check”. Eya reads Word through its own interface and the
                text box in Notepad, WordPad and a few similar editors; she does not read browsers, chats or password boxes.
              </span>
            </div>
          </>
        )}
        {section === 'performance' && info !== undefined && (
          <>
            <h2>Performance</h2>
            <SettingRow
              name="How hard Eya works"
              desc={`This PC has ${info.performance.memoryGB} GB of memory and ${info.performance.cores} processor threads, so Automatic picks ${TIER_LABEL[info.performance.detected]}. ${TIER_SUMMARY[info.performance.wanted]}`}
            >
              <select
                className="select"
                value={info.performance.setting}
                onChange={(e) => c.changeSettings({ performance: e.target.value as PerformanceSetting })}
                aria-label="How hard Eya works"
              >
                <option value="auto">Automatic ({TIER_LABEL[info.performance.detected]})</option>
                <option value="light">Light</option>
                <option value="balanced">Balanced</option>
                <option value="full">Full</option>
              </select>
            </SettingRow>
            {info.performance.wanted !== info.performance.running && (
              <div className="set-note">
                <Icon name="info" size={15} />
                <span>
                  Eya is running at <b>{TIER_LABEL[info.performance.running]}</b> for now; <b>{TIER_LABEL[info.performance.wanted]}</b> starts the next time she does.
                  {info.packaged ? (
                    <>
                      {' '}
                      <button type="button" className="btn" onClick={c.relaunch}>
                        Restart Eya now
                      </button>
                    </>
                  ) : (
                    ' Quit Eya from the tray icon and open her again.'
                  )}
                </span>
              </div>
            )}
            <div className="set-note">
              <Icon name="bolt" size={15} />
              <span>
                Right now: {TIER_LABEL[info.performance.running]} · graphics acceleration {info.performance.hardwareAcceleration ? 'on' : 'off (voice recognition runs on the processor)'} · animations step {info.performance.motionPerSecond} times a second while Eya is busy, and not at all when she is idle.
              </span>
            </div>
          </>
        )}
        {section === 'about' && (
          <>
            <h2>About</h2>
            <SettingRow name="Eya" desc="Your advanced laptop assistant.">
              <span className="pill">v{info?.version ?? '…'}</span>
            </SettingRow>
            <SettingRow name="Quit Eya" desc="Closing the window only puts Eya away as a bubble. Quit ends her completely (the wake word stops listening too).">
              <button type="button" className="btn danger" onClick={c.quit}>
                Quit Eya
              </button>
            </SettingRow>
          </>
        )}
      </div>
    </div>
  );
}
