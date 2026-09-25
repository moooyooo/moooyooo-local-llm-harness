import { useState } from 'react';
import type { SessionSummary } from '../../../shared/protocol';
import { t, tNodes, tx } from '../i18n';
import type { State } from '../state';
import { baseName, formatDate, samePath } from '../util';

const WELCOME_SESSIONS = 8;

/** First screen of a tab: pick a recent working folder, then start fresh or resume one of its sessions. */
export function Welcome({ state, cwd, canStart, openSessionIds, onSelectFolder, onStartNew, onResume }: {
  state: State;
  cwd: string;
  /** Connected and a model is selected. */
  canStart: boolean;
  /** Session IDs currently open in some tab. */
  openSessionIds: Set<string>;
  onSelectFolder: (cwd: string) => void;
  onStartNew: (cwd: string) => void;
  onResume: (s: SessionSummary) => void;
}) {
  const sessions = state.sessions.filter((s) => samePath(s.cwd, cwd)).slice(0, WELCOME_SESSIONS);
  const known = state.folders.some((f) => samePath(f.path, cwd));
  return (
    <div className="welcome">
      <OllamaBanner state={state} />
      <section>
        <h2>{t('welcome.recentFolders')}</h2>
        {state.folders.length === 0 && <div className="muted">{t('welcome.noFolders')}</div>}
        <ul className="folders">
          {!known && cwd && (
            <li className="selected" title={cwd}>
              <div className="f-name">{baseName(cwd)}</div>
              <div className="f-path">{cwd}</div>
              <div className="f-meta">{t('welcome.noHistory')}</div>
            </li>
          )}
          {state.folders.map((f) => (
            <li
              key={f.path}
              className={`${samePath(f.path, cwd) ? 'selected' : ''} ${f.exists ? '' : 'missing'}`}
              title={f.exists ? f.path : t('welcome.folderMissingTitle', { path: f.path })}
              onClick={() => f.exists && onSelectFolder(f.path)}
            >
              <div className="f-name">{baseName(f.path)}</div>
              <div className="f-path">{f.path}</div>
              <div className="f-meta">
                {f.exists ? t('welcome.folderMeta', { date: formatDate(f.lastUsed), count: f.sessionCount }) : t('welcome.folderMissing')}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>
          {tNodes('welcome.sessionsOf', {
            folder: <span className="w-folder" title={cwd}>{baseName(cwd) || t('welcome.unselected')}</span>,
          })}
        </h2>
        <button className="primary" disabled={!canStart || !cwd} onClick={() => onStartNew(cwd)}>
          {t('welcome.startHere')}
        </button>
        <ul className="w-sessions">
          {sessions.length === 0 && <li className="muted">{t('welcome.noSessions')}</li>}
          {sessions.map((s) => (
            <li key={s.sessionId} title={t('welcome.sessionTitle', { id: s.sessionId })} onClick={() => onResume(s)}>
              <div className="h-title">{s.title ?? s.firstPrompt ?? t('common.untitled')}</div>
              <SessionMeta s={s} open={openSessionIds.has(s.sessionId)} />
              {s.lastPrompt && s.lastPrompt !== s.firstPrompt && <div className="h-meta h-last">{t('welcome.last', { prompt: s.lastPrompt })}</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Why nothing can start: Ollama unreachable, or no models installed. */
function OllamaBanner({ state }: { state: State }) {
  if (!state.ollama) return null;
  if (state.ollama.error) {
    return (
      <div className="banner ng">
        <b>{t('welcome.ollamaDown')}</b>
        <div>{tx(state.ollama.error)}</div>
        <div className="muted">{tNodes('welcome.ollamaDownHint', { command: <code>ollama serve</code> })}</div>
      </div>
    );
  }
  if (state.models.length === 0) {
    return (
      <div className="banner warn">
        <b>{t('welcome.noModels')}</b>
        <div className="muted">{tNodes('welcome.noModelsHint', { command: <code>ollama pull qwen3-coder:30b</code> })}</div>
      </div>
    );
  }
  return null;
}

export function SessionHistory({ state, cwd, activeSessionId, openSessionIds, onRefresh, onResume }: {
  state: State;
  cwd: string;
  activeSessionId?: string;
  openSessionIds: Set<string>;
  onRefresh: () => void;
  onResume: (s: SessionSummary) => void;
}) {
  const [onlyCwd, setOnlyCwd] = useState(true);
  const list = onlyCwd ? state.sessions.filter((s) => samePath(s.cwd, cwd)) : state.sessions;
  return (
    <div className="history">
      <div className="history-head">
        <b>{t('history.title')}</b>
        <button className="small" onClick={onRefresh}>{t('common.refresh')}</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={onlyCwd} onChange={(e) => setOnlyCwd(e.target.checked)} />
        {t('history.thisFolder')}
      </label>
      <ul>
        {list.length === 0 && <li className="muted">{t('history.empty')}</li>}
        {list.map((s) => (
          <li
            key={s.sessionId}
            className={s.sessionId === activeSessionId ? 'current' : ''}
            title={[
              `ID: ${s.sessionId}`,
              t('history.folder', { value: s.cwd }),
              s.model && t('history.model', { value: s.model }),
              s.createdAt && t('history.started', { value: formatDate(s.createdAt) }),
              t('history.updated', { value: formatDate(s.updatedAt) }),
              s.firstPrompt && t('history.first', { value: s.firstPrompt }),
              s.lastPrompt && t('history.last', { value: s.lastPrompt }),
              t(openSessionIds.has(s.sessionId) ? 'history.goToTab' : 'history.clickToResume'),
            ].filter(Boolean).join('\n')}
            onClick={() => onResume(s)}
          >
            <div className="h-title">{s.title ?? s.firstPrompt ?? t('common.untitled')}</div>
            <SessionMeta s={s} open={openSessionIds.has(s.sessionId)} folder={onlyCwd ? undefined : baseName(s.cwd)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionMeta({ s, open, folder }: { s: SessionSummary; open: boolean; folder?: string }) {
  return (
    <div className="h-meta">
      <span>{formatDate(s.updatedAt)}</span>
      {s.model && <span className="badge model" title={s.model}>{s.model}</span>}
      <span>{t('history.prompts', { count: s.promptCount })}</span>
      {open && <span className="badge open">{t('history.openInTab')}</span>}
      {folder && <span className="h-cwd">{folder}</span>}
    </div>
  );
}
