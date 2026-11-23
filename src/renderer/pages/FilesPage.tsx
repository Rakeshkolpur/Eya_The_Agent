import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntryView, FilesListing, FilesView } from '../../shared/ipcContract';
import type { EyaControl } from '../control';
import { formatSize, timeAgo } from '../ui/format';
import { Icon } from '../ui/icons';
import { Spinner } from '../ui/widgets';

const TABS: ReadonlyArray<{ id: FilesView; label: string }> = [
  { id: 'recent', label: 'Recent' },
  { id: 'documents', label: 'Documents' },
  { id: 'images', label: 'Images' },
  { id: 'folders', label: 'Folders' },
];

const EMPTY: Record<FilesView, string> = {
  recent: 'Nothing recent in your Desktop, Documents, Downloads or Pictures.',
  documents: 'No documents found in Documents, Desktop or Downloads.',
  images: 'No pictures found in Pictures, Desktop or Downloads.',
  folders: 'No folders to show.',
};

/** Which colour a row's icon wears. */
function iconClass(e: FileEntryView): string {
  if (e.kind === 'folder') return 't-folder';
  if (e.kind === 'image') return 't-image';
  if (e.ext === 'pdf') return 't-pdf';
  if (e.ext === 'doc' || e.ext === 'docx' || e.ext === 'odt') return 't-word';
  if (e.ext === 'xls' || e.ext === 'xlsx' || e.ext === 'csv') return 't-excel';
  if (e.ext === 'ppt' || e.ext === 'pptx') return 't-ppt';
  return 't-text';
}

function FileIcon({ entry, thumb }: { entry: FileEntryView; thumb: string | undefined }): React.ReactElement {
  if (thumb !== undefined) return <img className="file-thumb" src={thumb} alt="" />;
  return (
    <span className={`file-icon ${iconClass(entry)}`}>
      <Icon name={entry.kind === 'folder' ? 'folder' : entry.kind === 'image' ? 'image' : 'file'} size={18} />
    </span>
  );
}

interface Asked {
  readonly path: string;
  readonly phase: 'working' | 'done' | 'error';
  readonly text: string;
}

/** Files: your own folders as lists — Recent, Documents, Images, Folders — with search, and Open / Show in folder / Ask Eya about it. */
export function FilesPage({ c }: { c: EyaControl }): React.ReactElement {
  const [tab, setTab] = useState<FilesView>('recent');
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [note, setNote] = useState('');
  const latest = useRef(0);

  const run = useCallback(async (load: () => Promise<FilesListing>) => {
    const mine = (latest.current += 1);
    setLoading(true);
    setMenu(null);
    setAsking(null);
    setAsked(null);
    setNote('');
    try {
      const next = await load();
      if (mine !== latest.current) return; // a newer request has taken over
      setListing(next);
      const images = next.items.filter((i) => i.kind === 'image').slice(0, 24).map((i) => i.path);
      if (images.length > 0) {
        void window.eya
          .fileThumbnails(images)
          .then((got) => setThumbs((prev) => ({ ...prev, ...got })))
          .catch(() => undefined);
      }
    } catch {
      if (mine === latest.current) setListing({ title: 'Files', folder: null, parent: null, items: [], truncated: false, error: 'I could not read your files just now.' });
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void run(() => window.eya.listFiles(tab));
  }, [tab, run]);

  const backToTabs = (): void => {
    setQuery('');
    void run(() => window.eya.listFiles(tab));
  };
  const search = (): void => {
    const q = query.trim();
    if (q === '') return backToTabs();
    void run(() => window.eya.searchFiles(q));
  };
  const act = async (label: string, work: () => Promise<{ ok: boolean; message: string }>): Promise<void> => {
    setMenu(null);
    setNote(`${label}…`);
    try {
      const r = await work();
      setNote(r.ok ? '' : r.message);
    } catch {
      setNote('That did not work.');
    }
  };
  const ask = async (entry: FileEntryView): Promise<void> => {
    setAsked({ path: entry.path, phase: 'working', text: '' });
    try {
      const r = await window.eya.askAboutFile(entry.path, question);
      setAsked({ path: entry.path, phase: r.ok && r.answer !== undefined ? 'done' : 'error', text: r.ok && r.answer !== undefined ? r.answer : r.message });
    } catch {
      setAsked({ path: entry.path, phase: 'error', text: 'I could not read that file just now.' });
    }
  };

  const browsing = listing?.folder != null;
  const items = listing?.items ?? [];
  const noun = listing?.title.startsWith('Results') === true ? 'No file has that name.' : browsing ? 'This folder is empty.' : EMPTY[tab];

  return (
    <div className="files" onClick={() => setMenu(null)}>
      <div className="page-head">
        <h1>Files</h1>
        <span className="mem-spacer" />
        <div className="files-search">
          <Icon name="search" size={15} />
          <input
            value={query}
            placeholder="Search your files by name…"
            spellCheck={false}
            aria-label="Search your files"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') search();
              if (e.key === 'Escape') backToTabs();
            }}
          />
          {query !== '' && (
            <button type="button" className="icon-btn" onClick={backToTabs} aria-label="Clear the search">
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="chips" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id && !browsing && listing?.title.startsWith('Results') !== true}
            className={`chip ${tab === t.id && !browsing && listing?.title.startsWith('Results') !== true ? 'on' : ''}`}
            onClick={() => {
              setQuery('');
              if (tab === t.id) void run(() => window.eya.listFiles(t.id));
              else setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {(browsing || listing?.title.startsWith('Results') === true) && listing !== null && (
        <div className="files-crumbs">
          <button
            type="button"
            className="btn small"
            disabled={browsing && listing.parent === null}
            onClick={() => (browsing && listing.parent !== null ? void run(() => window.eya.browseFolder(listing.parent as string)) : backToTabs())}
            title={browsing ? 'Up one folder' : 'Back to the lists'}
          >
            <Icon name="back" size={14} /> {browsing ? 'Up' : 'Back'}
          </button>
          <span className="files-crumb-title">{listing.title}</span>
          {browsing && <span className="files-crumb-path">{listing.folder}</span>}
          <span className="mem-spacer" />
          {browsing && (
            <button type="button" className="link" onClick={backToTabs}>
              All {TABS.find((t) => t.id === tab)?.label.toLowerCase() ?? 'files'}
            </button>
          )}
        </div>
      )}

      <div className="card scroll files-card">
        {loading && items.length === 0 ? (
          <div className="empty">
            <Spinner className="inline" /> Looking through your folders…
          </div>
        ) : listing?.error !== undefined ? (
          <div className="empty">{listing.error}</div>
        ) : items.length === 0 ? (
          <div className="empty">{noun}</div>
        ) : (
          <ul className="file-list">
            {items.map((e) => (
              <li key={e.path} className={`file-item ${asking === e.path ? 'asking' : ''}`}>
                <div className="file-row" onDoubleClick={() => e.kind !== 'folder' && void act('Opening', () => window.eya.openFileItem(e.path))}>
                  <FileIcon entry={e} thumb={thumbs[e.path]} />
                  {e.kind === 'folder' ? (
                    <button type="button" className="file-main as-link" onClick={() => void run(() => window.eya.browseFolder(e.path))} title="Open this folder here">
                      <span className="file-name">{e.name}</span>
                      <span className="file-sub">Folder · {e.where}</span>
                    </button>
                  ) : (
                    <div className="file-main" title={e.path}>
                      <span className="file-name">{e.name}</span>
                      <span className="file-sub">
                        {e.where} · {formatSize(e.size)}
                      </span>
                    </div>
                  )}
                  <span className="file-time">{timeAgo(e.modified)}</span>
                  <button type="button" className="btn small" onClick={() => void act('Opening', () => window.eya.openFileItem(e.path))} title={e.kind === 'folder' ? 'Open in File Explorer' : 'Open'}>
                    <Icon name="external" size={13} /> Open
                  </button>
                  <div className="file-menu-wrap">
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`More for ${e.name}`}
                      aria-expanded={menu === e.path}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setMenu(menu === e.path ? null : e.path);
                      }}
                    >
                      <Icon name="more" size={17} />
                    </button>
                    {menu === e.path && (
                      <div className="file-menu" role="menu" onClick={(ev) => ev.stopPropagation()}>
                        <button type="button" role="menuitem" onClick={() => void act('Opening', () => window.eya.openFileItem(e.path))}>
                          Open
                        </button>
                        <button type="button" role="menuitem" onClick={() => void act('Showing', () => window.eya.revealFileItem(e.path))}>
                          Show in folder
                        </button>
                        {e.kind !== 'folder' && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setMenu(null);
                              setAsking(e.path);
                              setQuestion('');
                              setAsked(null);
                            }}
                          >
                            Ask Eya about this file
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {asking === e.path && (
                  <div className="ask-file">
                    <div className="ask-file-bar">
                      <input
                        autoFocus
                        value={question}
                        placeholder="Ask a question about it, or leave this empty to summarize"
                        spellCheck={false}
                        onChange={(ev) => setQuestion(ev.target.value)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter') void ask(e);
                          if (ev.key === 'Escape') setAsking(null);
                        }}
                      />
                      <button type="button" className="btn primary small" disabled={asked?.phase === 'working'} onClick={() => void ask(e)}>
                        Ask Eya
                      </button>
                      <button type="button" className="btn small" onClick={() => setAsking(null)}>
                        Close
                      </button>
                    </div>
                    <div className="ask-file-note">This file is sent to Gemini to be read. Nothing is saved.</div>
                    {asked?.path === e.path && asked.phase === 'working' && (
                      <div className="ask-file-answer">
                        <Spinner className="inline" /> Reading it…
                      </div>
                    )}
                    {asked?.path === e.path && asked.phase === 'done' && (
                      <div className="ask-file-answer">
                        {asked.text}
                        <button type="button" className="btn small" onClick={() => c.speakText(asked.text)}>
                          Read it aloud
                        </button>
                      </div>
                    )}
                    {asked?.path === e.path && asked.phase === 'error' && <div className="screen-error">{asked.text}</div>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {(note !== '' || listing?.truncated === true) && (
        <div className="foot-note">{note !== '' ? note : 'There are more than this. Use the search box to find a particular file.'}</div>
      )}
    </div>
  );
}
