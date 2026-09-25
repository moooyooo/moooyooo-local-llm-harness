import { useState } from 'react';
import { msg as text } from '../../../shared/i18n';
import type { FileChange } from '../../../shared/protocol';
import { t, tx } from '../i18n';
import type { CheckpointData, CheckpointItem, Tab } from '../state';

export interface CheckpointHandlers {
  /** Fetch what changed since the checkpoint (again, each time it is opened). */
  onChanges: (commit: string) => void;
  onPatch: (commit: string, path: string) => void;
  onRestore: (commit: string) => void;
}

const STATUS_KEY = { added: 'checkpoint.statusAdded', modified: 'checkpoint.statusModified', deleted: 'checkpoint.statusDeleted' } as const;

/** A checkpoint in the transcript: what changed since, and putting the working folder's files back to it. */
export function CheckpointRow({ item, tab, handlers }: { item: CheckpointItem; tab: Tab; handlers: CheckpointHandlers }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [file, setFile] = useState<string>();
  const data = tab.checkpointData[item.commit];
  const restoring = tab.restoring === item.commit;
  const at = new Date(item.at);

  const load = (confirm: boolean) => {
    setOpen(true);
    setConfirming(confirm);
    setFile(undefined);
    handlers.onChanges(item.commit);
  };
  const toggleFile = (path: string) => {
    if (file === path) return setFile(undefined);
    setFile(path);
    handlers.onPatch(item.commit, path);
  };
  const restore = () => {
    handlers.onRestore(item.commit);
    setOpen(false);
    setConfirming(false);
  };

  return (
    <div className={`checkpoint ${open ? 'open' : ''}`}>
      <div className="checkpoint-head" title={t('checkpoint.hint')}>
        <span className="checkpoint-title">
          📍 {t('checkpoint.title', { n: item.n })}
          <span className="muted" title={at.toLocaleString()}>
            {' · '}
            {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {reasonText(item)}
          </span>
        </span>
        {restoring ? (
          <span className="muted">{t('checkpoint.restoring')}</span>
        ) : (
          <>
            <button className="small" onClick={() => (open && !confirming ? setOpen(false) : load(false))}>
              {open && !confirming ? t('common.close') : t('checkpoint.showChanges')}
            </button>
            <button className="small" disabled={!tab.running || tab.busy} onClick={() => load(true)}>
              {t('checkpoint.restore')}
            </button>
          </>
        )}
      </div>
      {item.excluded && <div className="hint-muted">{t('checkpoint.excluded', { paths: item.excluded.join(', ') })}</div>}
      {open && (
        <div className="checkpoint-body">
          <Changes data={data} file={file} onFile={toggleFile} />
          {confirming && data?.files && data.files.length > 0 && (
            <Confirm n={item.n} files={data.files} disabled={!tab.running || tab.busy} onRestore={restore} onCancel={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

function reasonText(item: CheckpointItem): string {
  if (item.reason === 'progress') return t('checkpoint.progress', { changed: item.changed });
  return t(item.reason === 'backup' ? 'checkpoint.backup' : 'checkpoint.prompt');
}

function Changes({ data, file, onFile }: { data?: CheckpointData; file?: string; onFile: (path: string) => void }) {
  if (!data || (!data.files && !data.error)) return <div className="muted">{t('checkpoint.loading')}</div>;
  if (data.error) return <div className="notice error">{tx(data.error)}</div>;
  const files = data.files ?? [];
  if (!files.length) return <div className="muted">{t('checkpoint.noChanges')}</div>;
  const count = (s: FileChange['status']) => files.filter((f) => f.status === s).length;
  const patch = file ? data.patches[file] : undefined;
  return (
    <>
      <div>
        {t('checkpoint.changes', { count: files.length, added: count('added'), modified: count('modified'), deleted: count('deleted') })}
        {data.truncated && <span className="muted">{t('checkpoint.truncated')}</span>}
      </div>
      <ul className="checkpoint-files">
        {files.map((f) => (
          <li key={f.path}>
            <button className={`file-row ${file === f.path ? 'selected' : ''}`} onClick={() => onFile(f.path)}>
              <span className={`badge ${f.status}`}>{t(STATUS_KEY[f.status])}</span>
              <code>{f.path}</code>
              <span className="muted">{f.added == null ? t('checkpoint.binary') : `+${f.added} −${f.deleted}`}</span>
            </button>
            {file === f.path && <Patch patch={patch} />}
          </li>
        ))}
      </ul>
    </>
  );
}

function Patch({ patch }: { patch?: CheckpointData['patches'][string] }) {
  if (!patch || (patch.patch == null && !patch.error)) return <div className="muted">{t('checkpoint.loading')}</div>;
  if (patch.error) return <div className="notice error">{tx(patch.error)}</div>;
  // Skip git's header lines; keep hunks.
  const lines = (patch.patch ?? '').split('\n').filter((l) => l && !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity|old mode|new mode)/.test(l));
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'}>{l}</div>
      ))}
      {patch.truncated && <div className="ctx">{t('checkpoint.patchTruncated')}</div>}
    </pre>
  );
}

function Confirm({ n, files, disabled, onRestore, onCancel }: {
  n: number;
  files: FileChange[];
  disabled: boolean;
  onRestore: () => void;
  onCancel: () => void;
}) {
  const remove = files.filter((f) => f.status === 'added').length;
  const back = files.length - remove;
  const what = [
    ...(back ? [text('checkpoint.whatBack', { count: back })] : []),
    ...(remove ? [text('checkpoint.whatDelete', { count: remove })] : []),
  ];
  return (
    <div className="checkpoint-confirm">
      <div>{tx(text('checkpoint.confirm', { n, what }))}</div>
      <div className="muted">{t('checkpoint.confirmNote')}</div>
      <div className="row">
        <button className="primary" disabled={disabled} onClick={onRestore}>{t('checkpoint.confirmRestore')}</button>
        <button onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </div>
  );
}
