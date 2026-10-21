import React, { useState } from 'react';
import type { ActivityKind } from '../../shared/ipcContract';
import type { AppPage, EyaControl } from '../control';
import { Icon } from '../ui/icons';
import { timeAgo } from '../ui/format';
import { KIND_LABEL, KindIcon } from '../ui/widgets';

type Filter = 'all' | ActivityKind;
const FILTERS: readonly Filter[] = ['all', 'action', 'file', 'web', 'chat'];

/** Recent: what Eya has done, newest first, with a button to do any of it again. */
export function RecentPage({ c, go }: { c: EyaControl; go: (page: AppPage) => void }): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  const [sure, setSure] = useState(false);
  const all = c.activity?.items ?? [];
  const shown = filter === 'all' ? all : all.filter((a) => a.kind === filter);

  return (
    <div className="recent">
      <div className="page-head">
        <h1>Recent</h1>
        <span className="mem-spacer" />
        {all.length > 0 &&
          (sure ? (
            <>
              <button type="button" className="btn danger" onClick={() => { c.actOnActivity({ kind: 'clear' }); setSure(false); }}>
                Yes, clear it
              </button>
              <button type="button" className="btn" onClick={() => setSure(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={() => setSure(true)}>
              Clear history
            </button>
          ))}
      </div>
      <div className="chips" role="tablist">
        {FILTERS.map((f) => (
          <button key={f} type="button" role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : KIND_LABEL[f]}
          </button>
        ))}
      </div>
      <div className="card scroll">
        {c.activity !== null && !c.activity.enabled && all.length === 0 ? (
          <div className="empty">
            History is turned off, so Eya is not keeping a list of what she does.{' '}
            <button type="button" className="link" onClick={() => go('settings')}>
              Turn it on in Settings
            </button>
          </div>
        ) : shown.length === 0 ? (
          <div className="empty">{all.length === 0 ? 'Nothing yet. Ask Eya to do something and it shows up here.' : 'Nothing of this kind yet.'}</div>
        ) : (
          <ul className="recent-list">
            {shown.map((a) => (
              <li key={a.id}>
                <KindIcon kind={a.kind} ok={a.ok} />
                <div className="recent-text">
                  <div className="recent-title">{a.title}</div>
                  <div className={`recent-detail ${a.ok ? '' : 'failed'}`}>{a.detail}</div>
                </div>
                <span className="recent-meta">{timeAgo(a.at)}</span>
                {a.canRepeat && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      void c.submit(a.request);
                      go('chat');
                    }}
                    title="Do this again"
                  >
                    <Icon name="repeat" size={14} /> Repeat
                  </button>
                )}
                <button type="button" className="icon-btn" onClick={() => c.actOnActivity({ kind: 'delete', id: a.id })} title="Remove from history" aria-label="Remove from history">
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="foot-note">Only short titles are kept, on this PC. Nothing from chat apps is listed, and nothing private is saved.</div>
    </div>
  );
}
