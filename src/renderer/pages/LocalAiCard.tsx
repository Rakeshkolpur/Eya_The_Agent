import React, { useEffect, useState } from 'react';
import { DEFAULT_LOCAL_MODEL } from '../../shared/localAi';
import type { EyaControl } from '../control';
import { Icon } from '../ui/icons';
import { SettingRow } from '../ui/widgets';

type Mode = 'auto' | 'local' | 'local-only';

const MODE_TEXT: Record<Mode, string> = {
  auto: 'Automatic: Gemini first; the local AI only when the others cannot answer',
  local: 'Local AI first; a cloud AI helps with hard requests',
  'local-only': 'Local AI only: no cloud AI is asked to answer',
};

/**
 * Settings → Local AI: the model Eya runs on this PC through Ollama (no key). Says whether Ollama is running and has the model, what to do
 * if it does not, which model to use, and whether it is asked first, helped by the cloud, or alone.
 */
export function LocalAiCard({ c }: { c: EyaControl }): React.ReactElement {
  const status = c.localAi;
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);
  const first = c.settings?.settings.aiFirst ?? 'auto';
  const mode: Mode | 'backup' = first;
  const model = status?.model ?? c.settings?.settings.localModel ?? DEFAULT_LOCAL_MODEL;
  const installed = status?.models ?? [];
  const choices = installed.includes(model) ? installed : [model, ...installed];

  useEffect(() => {
    void c.refreshLocalAi().catch(() => undefined);
    // (looked at once when the page opens; the button looks again)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = (): void => {
    setChecking(true);
    void c
      .refreshLocalAi()
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };
  const copy = (text: string): void => {
    const done = (): void => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    try {
      void navigator.clipboard.writeText(text).then(done, () => undefined);
    } catch {
      // no clipboard here: the command is on screen to type
    }
  };
  const command = status?.fix?.startsWith('Run: ') === true ? status.fix.slice(5) : null;

  return (
    <>
      <h2>Local AI (Ollama)</h2>
      <div className="set-note">
        <Icon name="info" size={15} />
        <span>
          A small AI that runs on this PC through Ollama: no key, no account, and what you ask it is not sent to any cloud AI. It is a small model ({DEFAULT_LOCAL_MODEL} is
          1.3 GB), so it is good for quick, simple chat and everyday requests; long writing, research and tasks on websites go to a cloud AI unless you choose "only".
          Opening apps, files, folders and sites never needs an AI at all.
        </span>
      </div>

      <SettingRow name="Ollama" desc={status === null ? 'Looking…' : status.message}>
        <span className={`local-dot ${status?.state ?? 'checking'}`} aria-hidden="true" />
        <span className="local-state">{status === null ? 'Checking' : status.state === 'connected' ? 'Connected' : status.state === 'not-running' ? 'Not running' : 'Model missing'}</span>
        <button type="button" className="btn small" disabled={checking} onClick={check}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </SettingRow>

      {status !== null && status.fix !== null && (
        <div className="set-note bad">
          <Icon name="info" size={15} />
          <span>
            {status.fix.startsWith('Run: ') ? 'To fix it, run this in a terminal:' : status.fix}{' '}
            {command !== null && (
              <>
                <code>{command}</code>{' '}
                <button type="button" className="btn small" onClick={() => copy(command)}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <SettingRow name="Model" desc="Which of the models installed in Ollama Eya asks. A bigger one answers better and slower; on this kind of laptop, keep to small ones.">
        <select className="select" aria-label="Local model" value={model} disabled={status?.modelFromEnv === true} onChange={(e) => void c.setLocalModel(e.target.value)}>
          {choices.map((m) => (
            <option key={m} value={m}>
              {installed.includes(m) ? m : `${m} (not installed)`}
            </option>
          ))}
        </select>
      </SettingRow>

      {status?.modelFromEnv === true && (
        <div className="set-note">
          <Icon name="info" size={15} />
          <span>
            The model is fixed by <code>EYA_OLLAMA_MODEL</code> in Eya's <code>.env</code> file (or the environment), which wins over this list. Change it there, or delete that line to choose here.
          </span>
        </div>
      )}
      <SettingRow name="How Eya uses it" desc="Automatic keeps things as they are. Local AI first answers everyday chat on this PC and sends only hard requests to a cloud AI. Local AI only never uses a cloud AI for chat.">
        <select
          className="select"
          aria-label="How Eya uses the local AI"
          value={mode === 'backup' ? 'auto' : mode}
          onChange={(e) => void c.chooseAi(e.target.value as Mode)}
        >
          {(Object.keys(MODE_TEXT) as Mode[]).map((m) => (
            <option key={m} value={m}>
              {MODE_TEXT[m]}
            </option>
          ))}
        </select>
      </SettingRow>
      {mode === 'backup' && (
        <div className="set-note">
          <Icon name="info" size={15} />
          <span>A backup AI is asked first at the moment (chosen on the Backup AI page). Picking one of the options above replaces that.</span>
        </div>
      )}

      <div className="set-note">
        <Icon name="info" size={15} />
        <span>
          Speed: the first question after a long rest takes a few seconds longer while the model loads into memory; Eya keeps it loaded for half an hour afterwards. Answers
          appear word by word. It is only loaded ahead of time when you have chosen the local AI, so it uses no memory while you do not. (If Eya speaks with a cloud voice, the words she says
          aloud are still sent to that voice service; the offline voice keeps them on this PC.)
        </span>
      </div>
    </>
  );
}
