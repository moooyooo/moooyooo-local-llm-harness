import { useState } from 'react';
import type { SessionSummary } from '../../../shared/protocol';
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
        <h2>最近の作業フォルダ</h2>
        {state.folders.length === 0 && <div className="muted">まだ履歴がありません。左の「作業フォルダ」にパスを入力して開始してください。</div>}
        <ul className="folders">
          {!known && cwd && (
            <li className="selected" title={cwd}>
              <div className="f-name">{baseName(cwd)}</div>
              <div className="f-path">{cwd}</div>
              <div className="f-meta">履歴なし</div>
            </li>
          )}
          {state.folders.map((f) => (
            <li
              key={f.path}
              className={`${samePath(f.path, cwd) ? 'selected' : ''} ${f.exists ? '' : 'missing'}`}
              title={f.exists ? f.path : `${f.path}\n（フォルダが見つかりません）`}
              onClick={() => f.exists && onSelectFolder(f.path)}
            >
              <div className="f-name">{baseName(f.path)}</div>
              <div className="f-path">{f.path}</div>
              <div className="f-meta">
                {f.exists ? `${formatDate(f.lastUsed)} · ${f.sessionCount} セッション` : 'フォルダが見つかりません'}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>
          <span className="w-folder" title={cwd}>{baseName(cwd) || '(未選択)'}</span> のセッション
        </h2>
        <button className="primary" disabled={!canStart || !cwd} onClick={() => onStartNew(cwd)}>
          このフォルダで新しく開始
        </button>
        <ul className="w-sessions">
          {sessions.length === 0 && <li className="muted">このフォルダの履歴はありません</li>}
          {sessions.map((s) => (
            <li key={s.sessionId} title={`ID: ${s.sessionId}\nクリックで再開`} onClick={() => onResume(s)}>
              <div className="h-title">{s.title ?? s.firstPrompt ?? '(無題)'}</div>
              <SessionMeta s={s} open={openSessionIds.has(s.sessionId)} />
              {s.lastPrompt && s.lastPrompt !== s.firstPrompt && <div className="h-meta h-last">最後: {s.lastPrompt}</div>}
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
        <b>Ollama に接続できません</b>
        <div>{state.ollama.error}</div>
        <div className="muted">Ollama アプリを起動するか、ターミナルで <code>ollama serve</code> を実行してください。</div>
      </div>
    );
  }
  if (state.models.length === 0) {
    return (
      <div className="banner warn">
        <b>モデルがありません</b>
        <div className="muted">
          ターミナルで <code>ollama pull qwen3-coder:30b</code> などを実行してから、左の「更新」を押してください。
        </div>
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
        <b>セッション履歴</b>
        <button className="small" onClick={onRefresh}>更新</button>
      </div>
      <label className="check">
        <input type="checkbox" checked={onlyCwd} onChange={(e) => setOnlyCwd(e.target.checked)} />
        この作業フォルダのみ
      </label>
      <ul>
        {list.length === 0 && <li className="muted">履歴なし</li>}
        {list.map((s) => (
          <li
            key={s.sessionId}
            className={s.sessionId === activeSessionId ? 'current' : ''}
            title={[
              `ID: ${s.sessionId}`,
              `フォルダ: ${s.cwd}`,
              s.model && `モデル: ${s.model}`,
              s.createdAt && `開始: ${formatDate(s.createdAt)}`,
              `更新: ${formatDate(s.updatedAt)}`,
              s.firstPrompt && `最初: ${s.firstPrompt}`,
              s.lastPrompt && `最後: ${s.lastPrompt}`,
              openSessionIds.has(s.sessionId) ? 'クリックでそのタブへ移動' : 'クリックで再開（モデル等は左の設定で再開します）',
            ].filter(Boolean).join('\n')}
            onClick={() => onResume(s)}
          >
            <div className="h-title">{s.title ?? s.firstPrompt ?? '(無題)'}</div>
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
      <span>{s.promptCount}件</span>
      {open && <span className="badge open">タブで開いています</span>}
      {folder && <span className="h-cwd">{folder}</span>}
    </div>
  );
}
