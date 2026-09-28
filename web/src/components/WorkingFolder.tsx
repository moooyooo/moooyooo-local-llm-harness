import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TextError, type Text } from '../../../shared/i18n';
import type { DirectoryListing, FolderSummary } from '../../../shared/protocol';
import { t, tx } from '../i18n';
import { baseName } from '../util';
import { useDirectorySuggestions, type RequestDirectory } from '../useDirectorySuggestions';

export function WorkingFolder({ value, defaultCwd, disabled, connected, recent, request, onChange }: {
  value: string;
  defaultCwd: string;
  disabled: boolean;
  connected: boolean;
  recent: FolderSummary[];
  request: RequestDirectory;
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const id = useId();
  const suggestions = useDirectorySuggestions(value, connected && !disabled && focused, request);
  const options = [...new Set([...suggestions, ...recent.filter((f) => f.exists).map((f) => f.path)])];
  return (
    <div className="working-folder">
      <label htmlFor={id}>{t('app.cwd')}</label>
      <div className="folder-input-row">
        <input id={id} list={`${id}-options`} value={value} placeholder={defaultCwd} disabled={disabled}
          title={disabled ? t('app.cwdLocked') : t('folder.pathHint')}
          onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={(e) => onChange(e.target.value)} />
        <button type="button" disabled={disabled || !connected} onClick={() => setOpen(true)}>{t('folder.browse')}</button>
      </div>
      <datalist id={`${id}-options`}>{options.map((p) => <option key={p} value={p} />)}</datalist>
      {open && !disabled && <FolderBrowser initialPath={value || defaultCwd} recent={recent} connected={connected}
        request={request} onClose={() => setOpen(false)} onSelect={(p) => { onChange(p); setOpen(false); }} />}
    </div>
  );
}

function FolderBrowser({ initialPath, recent, connected, request, onClose, onSelect }: {
  initialPath: string;
  recent: FolderSummary[];
  connected: boolean;
  request: RequestDirectory;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sequence = useRef(0);
  const id = useId();
  const [location, setLocation] = useState(initialPath);
  const [focused, setFocused] = useState(false);
  const [listing, setListing] = useState<DirectoryListing>();
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<Text>();
  const [showHidden, setShowHidden] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [name, setName] = useState('');
  const suggestions = useDirectorySuggestions(location, connected && focused && !busy, request);
  const locked = busy || !connected;
  const entries = listing?.entries.filter((e) => showHidden || !e.name.startsWith('.')) ?? [];

  const browse = useCallback(async (path: string) => {
    const token = ++sequence.current;
    setBusy(true);
    setError(undefined);
    try {
      const result = await request({ type: 'listDirectories', path });
      if (token !== sequence.current) return;
      setListing(result);
      setLocation(result.path);
      setNewFolder(false);
      setName('');
    } catch (err) {
      if (token === sequence.current) setError(err instanceof TextError ? err.text : String(err));
    } finally {
      if (token === sequence.current) setBusy(false);
    }
  }, [request]);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    browse(initialPath);
    return () => { sequence.current++; element.close(); };
  }, [browse, initialPath]);

  const create = async () => {
    if (!listing || locked) return;
    setBusy(true);
    setCreating(true);
    setError(undefined);
    const token = ++sequence.current;
    try {
      const result = await request({ type: 'createDirectory', parent: listing.path, name });
      if (token === sequence.current) onSelect(result.path);
    } catch (err) {
      if (token === sequence.current) setError(err instanceof TextError ? err.text : String(err));
    } finally {
      if (token === sequence.current) { setBusy(false); setCreating(false); }
    }
  };

  return (
    <dialog ref={dialog} className={`folder-dialog${newFolder ? ' has-create-form' : ''}`} aria-labelledby={`${id}-title`}
      onCancel={(e) => { e.preventDefault(); if (!creating) onClose(); }}>
      <div className="folder-dialog-body">
        <div className="folder-heading">
          <h2 id={`${id}-title`}>{t('folder.title')}</h2>
          <button type="button" disabled={creating} onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <div className="folder-shortcuts">
          <button type="button" disabled={locked} onClick={() => browse(listing?.home ?? '~')}>{t('folder.home')}</button>
          {listing?.projects && <button type="button" disabled={locked} onClick={() => browse(listing.projects!)}>{t('folder.projects')}</button>}
          <select aria-label={t('welcome.recentFolders')} value="" disabled={locked} onChange={(e) => browse(e.target.value)}>
            <option value="" disabled>{t('welcome.recentFolders')}</option>
            {recent.filter((f) => f.exists).map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (!locked) browse(location); }}>
          <label htmlFor={`${id}-path`}>{t('folder.path')}</label>
          <div className="folder-input-row">
            <input id={`${id}-path`} value={location} list={`${id}-suggestions`} disabled={!connected || creating} readOnly={busy} autoFocus
              onChange={(e) => setLocation(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
            <button type="submit" disabled={locked}>{t('folder.go')}</button>
          </div>
          <datalist id={`${id}-suggestions`}>{suggestions.map((p) => <option key={p} value={p} />)}</datalist>
          <div className="hint-muted">{t('folder.pathHint')}</div>
        </form>
        {!connected && <div className="folder-error" role="alert">{t('app.disconnected')}</div>}
        {error && <div className="folder-error" role="alert">{tx(error)}</div>}
        <div className="folder-toolbar">
          <button type="button" disabled={locked || !listing?.parent} onClick={() => browse(listing!.parent!)}>↑ {t('folder.up')}</button>
          <label className="folder-check"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />{t('folder.hidden')}</label>
        </div>
        <div className="folder-current" title={listing?.path}><span>{t('folder.current')}</span><code>{listing?.path ?? '—'}</code></div>
        <div className="directory-list" aria-busy={busy} aria-label={t('folder.children')}>
          {busy && <div className="folder-empty" role="status">{t(creating ? 'folder.creating' : 'folder.loading')}</div>}
          {!busy && listing && entries.length === 0 && <div className="folder-empty">{t('folder.empty')}</div>}
          {!busy && entries.map((entry) => (
            <button type="button" className="directory-entry" key={entry.path} disabled={!connected} onClick={() => browse(entry.path)} title={entry.path}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /></svg>
              <span>{entry.name}</span><span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
        {listing?.truncated && <div className="hint-muted">{t('folder.truncated')}</div>}
        {newFolder ? (
          <form className="folder-create" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label htmlFor={`${id}-name`}>{t('folder.newName')}</label>
            <input id={`${id}-name`} autoFocus value={name} disabled={locked} maxLength={255} placeholder={t('folder.namePlaceholder')}
              onChange={(e) => setName(e.target.value)} />
            <div className="hint-muted">{t('folder.createIn', { path: listing?.path ?? '' })}</div>
            <div className="row">
              <button type="submit" className="primary" disabled={locked || !name.trim()}>{t('folder.createSelect')}</button>
              <button type="button" disabled={creating} onClick={() => { setNewFolder(false); setError(undefined); }}>{t('common.cancel')}</button>
            </div>
          </form>
        ) : (
          <button type="button" className="folder-new" disabled={locked || !listing} onClick={() => { setNewFolder(true); setError(undefined); }}>{t('folder.new')}</button>
        )}
        <div className="folder-footer">
          <button type="button" disabled={creating} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="primary" disabled={locked || !listing || newFolder}
            title={listing?.path} onClick={() => listing && onSelect(listing.path)}>{t('folder.select', { name: baseName(listing?.path ?? '') || listing?.path || '—' })}</button>
        </div>
      </div>
    </dialog>
  );
}
