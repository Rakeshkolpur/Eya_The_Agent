import React from 'react';
import type { AppPage, EyaControl } from '../control';
import { MemoryPanel } from '../MemoryPanel';
import { Icon } from '../ui/icons';

/** Memory: the things she was asked to remember, the routines she has learned, and the sites she opens most. */
export function MemoryPage({ c, go }: { c: EyaControl; go: (page: AppPage) => void }): React.ReactElement {
  const sites = c.activity?.sites ?? [];
  const routines = c.memory?.routines.length ?? 0;
  return (
    <div className="memory-page">
      <div className="quick-memory">
        <span className="quick-memory-icon">
          <Icon name="bolt" size={22} />
        </span>
        <div>
          <div className="quick-memory-title">Quick Memory</div>
          <div className="quick-memory-sub">Eya remembers your preferences and repeated tasks to help you work faster.</div>
        </div>
      </div>
      <div className="memory-cols">
        <section className="card memory-main">
          <MemoryPanel snapshot={c.memory} act={c.actOnMemory} />
        </section>
        <section className="memory-side">
          <div className="card">
            <div className="card-head">
              <h2>Frequently used websites</h2>
            </div>
            {sites.length === 0 ? (
              <div className="empty">None yet. Sites Eya opens for you will be counted here.</div>
            ) : (
              <ul className="site-list">
                {sites.map((s) => (
                  <li key={s.site}>
                    <Icon name="globe" size={16} />
                    <span className="site-name">{s.site}</span>
                    <span className="site-count">{s.count}×</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Repeated tasks</h2>
            </div>
            <div className="side-text">
              {routines === 0
                ? 'When you ask for the same thing a few times, Eya will offer to save it as a routine you can run with one phrase.'
                : `You have ${routines} saved routine${routines === 1 ? '' : 's'}. Say one of its phrases and Eya just does it.`}
            </div>
            <button
              type="button"
              className="btn primary full"
              onClick={() => {
                void c.submit('save this as a routine');
                go('chat');
              }}
              title="Save the task Eya just did as a routine"
            >
              <Icon name="bookmark" size={15} /> Remember this command
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
