import { useEffect, useState } from 'react';
import type { PermissionMode, ServerMessage, SessionSummary, ThinkSetting } from '../../shared/protocol';
import { SessionHistory, Welcome } from './components/Sessions';
import { ModelCaps, OllamaPanel, SessionPanel } from './components/SidebarParts';
import { TabBar } from './components/TabBar';
import { Composer, Transcript } from './components/Transcript';
import {
  notificationPermission,
  notificationsSupported,
  pageInBackground,
  requestNotificationPermission,
  showNotification,
} from './notifications';
import { base64Of, imageFiles, MAX_IMAGES, readImage, type Attachment } from './images';
import { activeTab, newTabKey, pendingPermissions, tabCwd, tabLabel } from './state';
import { useHarness } from './useHarness';
import { formatBytes, formatTokens, summarizeInput } from './util';

const THINK_OPTIONS: { value: ThinkSetting; label: string }[] = [
  { value: '', label: '(既定)' },
  { value: 'on', label: 'オン' },
  { value: 'off', label: 'オフ（速い）' },
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
];
const NUM_CTX_OPTIONS = [0, 8192, 16384, 32768, 65536, 131072, 262144];
const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'default（編集・コマンドは確認）' },
  { value: 'acceptEdits', label: 'acceptEdits（フォルダ内の編集は確認なし）' },
  { value: 'plan', label: 'plan（読み取りのみ・計画を立てる）' },
  { value: 'bypassPermissions', label: 'bypassPermissions（確認なし）' },
];
const SETTINGS_KEY = 'custom-harnes-local.settings';
const APP_TITLE = 'Local LLM Harness';
const LOCKED_TITLE = '応答中は変更できません。終わってから変更すると、次のメッセージから適用されます';

interface Settings {
  model?: string;
  think?: ThinkSetting;
  /** 0 / undefined = Ollama's default. */
  numCtx?: number;
  permissionMode?: PermissionMode;
  /** Browser notifications for finished turns and permission prompts. */
  notify?: boolean;
  /** Offer WebSearch / WebFetch through the local SearXNG. */
  web?: boolean;
  /** Auto-approve permission prompts that can't affect the host (decided by server/autoApprove.ts). */
  autoApprove?: boolean;
  /** Working folder for new tabs. */
  lastCwd?: string;
}

function loadSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Images attached to each tab's unsent message. */
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [imageNote, setImageNote] = useState('');
  const [dragging, setDragging] = useState(false);
  const [resumeInput, setResumeInput] = useState('');
  const [notifyPermission, setNotifyPermission] = useState(notificationPermission);

  const { state, dispatch, send } = useHarness(settings.lastCwd ?? '', (msg) => notify(msg));
  const tab = activeTab(state);
  const cwd = tabCwd(state, tab);

  // The saved model if it's still installed, else the first one that can use tools.
  const model =
    state.models.find((m) => m.name === settings.model) ??
    state.models.find((m) => m.capabilities.includes('tools')) ??
    state.models[0];
  const canStart = state.connected && !!model;
  // A running tab shows and changes its own settings (from the next message); otherwise these are for the next start.
  const live = tab.running ? tab.session : undefined;
  const shown = {
    model: live?.model ?? model?.name ?? '',
    think: live ? live.think : (settings.think ?? ''),
    numCtx: live ? (live.numCtx ?? 0) : (settings.numCtx ?? 0),
    permissionMode: live?.permissionMode ?? settings.permissionMode ?? 'default',
    web: live ? live.web : !!settings.web,
  };
  const shownModel = state.models.find((m) => m.name === shown.model);
  const canThink = !!shownModel?.capabilities.includes('thinking');
  const canAttach = !!live && !!shownModel?.capabilities.includes('vision');
  const settingsLocked = !!live && tab.busy;

  // A file dropped outside the drop area would make the browser open it and leave the app.
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage unavailable
    }
  }, [settings]);

  // The server decides auto-approval, so tell it the setting on every (re)connect and change.
  useEffect(() => {
    if (state.connected) send({ type: 'setAutoApprove', enabled: !!settings.autoApprove });
  }, [state.connected, settings.autoApprove, send]);

  // Tab title: counts of pending permissions (⚠) and finished-but-unseen tabs (✓).
  useEffect(() => {
    const pending = state.tabs.reduce((n, t) => n + pendingPermissions(t).length, 0);
    const unread = state.tabs.filter((t) => t.unread).length;
    const badges = [pending && `⚠${pending}`, unread && `✓${unread}`].filter(Boolean).join(' ');
    document.title = `${badges ? `(${badges}) ` : ''}${tabLabel(state, tab)} - ${APP_TITLE}`;
  }, [state, tab]);

  // Coming back to the page counts as having seen the active tab.
  useEffect(() => {
    const onFocus = () => dispatch({ type: 'activate', key: state.activeKey });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [dispatch, state.activeKey]);

  function notify(msg: ServerMessage) {
    if (msg.type !== 'event') return;
    const t = state.tabs.find((x) => x.key === msg.key);
    if (!t) return;
    const ev = msg.ev;
    const isPermission = ev.type === 'permission' && !ev.approval.applied;
    // Interrupts are user-initiated, so they need no notification.
    const isDone = ev.type === 'result' && ev.subtype !== 'interrupted';
    if (!isPermission && !isDone) return;

    const background = pageInBackground();
    if (msg.key === state.activeKey && !background) return;
    if (isDone && background) dispatch({ type: 'markUnread', key: msg.key });
    if (!settings.notify) return;

    const name = tabLabel(state, t);
    const open = () => dispatch({ type: 'activate', key: msg.key });
    if (ev.type === 'permission') {
      showNotification(`許可待ち: ${name}`, `${ev.toolName}: ${ev.description ?? summarizeInput(ev.input)}`, `${msg.key}:perm`, open);
    } else if (ev.type === 'result') {
      const last = [...t.items].reverse().find((it) => it.kind === 'text');
      const body = ev.message ?? (last?.kind === 'text' ? last.text : '');
      showNotification(`${ev.isError ? 'エラー' : '完了'}: ${name}`, body.slice(0, 140), `${msg.key}:done`, open);
    }
  }

  const toggleNotify = async (on: boolean) => {
    if (on) {
      const granted = await requestNotificationPermission();
      setNotifyPermission(notificationPermission());
      if (!granted) return;
    }
    setSettings((s) => ({ ...s, notify: on }));
  };

  const toggleAutoApprove = (on: boolean) => {
    setSettings((s) => ({ ...s, autoApprove: on }));
    if (!on) return;
    // Prompts already waiting would otherwise stay stuck until answered by hand.
    for (const t of state.tabs) {
      for (const item of pendingPermissions(t)) {
        if (item.autoEligible) answerPermission(t.key, item.id, true);
      }
    }
  };

  const startIn = (key: string, folder: string, resume?: string) => {
    if (!model) return;
    const target = folder || state.defaultCwd;
    dispatch({ type: 'resetTab', key, cwd: target, resumeId: resume });
    send({
      type: 'start',
      key,
      options: {
        cwd: target,
        model: model.name,
        think: settings.think ?? '',
        numCtx: settings.numCtx || undefined,
        permissionMode: settings.permissionMode ?? 'default',
        web: !!settings.web,
        resume,
      },
    });
    setSettings((s) => ({ ...s, lastCwd: target }));
  };

  /** Resume a saved session: jump to its tab if already open, else reuse an unstarted tab or open a new one. */
  const openSession = (s: SessionSummary) => {
    const open = state.tabs.find((t) => (t.session?.sessionId ?? t.resumeId) === s.sessionId);
    if (open) return dispatch({ type: 'activate', key: open.key });
    let key = tab.key;
    if (tab.running || tab.items.length > 0) {
      key = newTabKey();
      dispatch({ type: 'newTab', key, cwd: s.cwd });
    }
    startIn(key, s.cwd, s.sessionId);
  };

  const closeTab = (key: string) => {
    const t = state.tabs.find((x) => x.key === key);
    if (t?.running && !window.confirm(`「${tabLabel(state, t)}」のセッションを終了してタブを閉じますか？`)) return;
    send({ type: 'stop', key });
    dispatch({ type: 'closeTab', key });
    setDrafts(({ [key]: _, ...rest }) => rest);
    setAttachments(({ [key]: _, ...rest }) => rest);
  };

  const sendUser = (key: string, text: string, images: Attachment[] = []) => {
    const dataUrls = images.map((a) => a.dataUrl);
    dispatch({ type: 'userSent', key, text, images: dataUrls.length ? dataUrls : undefined, at: Date.now() });
    send({ type: 'user', key, text, ...(images.length && { images: dataUrls.map(base64Of) }) });
  };

  const addImages = async (key: string, files: File[]) => {
    if (!files.length) return;
    if (!canAttach) {
      setImageNote(tab.running ? `${shown.model} は画像入力に対応していません。vision 対応のモデルに切り替えてください` : 'セッションを開始してから添付してください');
      return;
    }
    const room = MAX_IMAGES - (attachments[key]?.length ?? 0);
    try {
      const added = await Promise.all(files.slice(0, Math.max(0, room)).map(readImage));
      setAttachments((a) => ({ ...a, [key]: [...(a[key] ?? []), ...added] }));
      setImageNote(files.length > room ? `画像は 1 回に ${MAX_IMAGES} 枚までです` : '');
    } catch {
      setImageNote('画像を読み込めませんでした（PNG・JPEG などの画像を使ってください）');
    }
  };

  /** Settings changed in the sidebar: the default for new sessions, and for a running tab also its own. */
  const changeSettings = (patch: Partial<Pick<Settings, 'model' | 'think' | 'numCtx' | 'permissionMode' | 'web'>>) => {
    setSettings((s) => ({ ...s, ...patch }));
    if (!live) return;
    const next = { model: live.model, think: live.think, numCtx: live.numCtx, permissionMode: live.permissionMode, web: live.web, ...patch };
    send({ type: 'configure', key: tab.key, options: { ...next, numCtx: next.numCtx || undefined } });
  };

  const answerPermission = (key: string, id: string, allow: boolean) => {
    dispatch({ type: 'permissionAnswered', key, id, allow });
    send({ type: 'permission', key, requestId: id, allow });
  };

  const openSessionIds = new Set(state.tabs.map((t) => t.session?.sessionId ?? t.resumeId).filter((x): x is string => !!x));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>{APP_TITLE} <span className="sub">for Ollama</span></h1>
        <div className={`conn ${state.connected ? 'ok' : 'ng'}`}>{state.connected ? 'サーバー接続中' : 'サーバー未接続'}</div>

        <label>
          作業フォルダ（このタブ）
          <input
            list="recent-folders"
            value={tab.cwd}
            placeholder={state.defaultCwd}
            disabled={tab.running}
            title={tab.running ? '実行中は変更できません。新しいタブを使ってください' : undefined}
            onChange={(e) => dispatch({ type: 'setCwd', key: tab.key, cwd: e.target.value })}
          />
          <datalist id="recent-folders">
            {state.folders.filter((f) => f.exists).map((f) => <option key={f.path} value={f.path} />)}
          </datalist>
        </label>
        <label>
          モデル
          <select
            value={shown.model}
            disabled={!state.models.length || settingsLocked}
            title={settingsLocked ? LOCKED_TITLE : undefined}
            onChange={(e) => changeSettings({ model: e.target.value })}
          >
            {!state.models.length && <option value="">(モデルなし)</option>}
            {live && !shownModel && <option value={live.model}>{live.model}</option>}
            {state.models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}（{[m.parameterSize, formatBytes(m.size)].filter(Boolean).join(', ')}）{m.capabilities.includes('tools') ? '' : ' ※ツールなし'}
              </option>
            ))}
          </select>
          <ModelCaps model={shownModel} />
        </label>
        <div className="row2">
          <label title={canThink ? '思考（reasoning）の有無。オフにすると速くなりますが、難しい作業の質は下がります' : 'このモデルは思考に対応していません'}>
            思考
            <select
              value={shown.think}
              disabled={!canThink || settingsLocked}
              onChange={(e) => changeSettings({ think: e.target.value as ThinkSetting })}
            >
              {THINK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label title="コンテキスト長（num_ctx）。大きいほど長い作業を扱えますが、メモリを多く使います。モデルがこれより小さい窓で読み込まれていたら、次のメッセージの前に読み込み直します">
            コンテキスト長
            <select value={shown.numCtx} disabled={settingsLocked} onChange={(e) => changeSettings({ numCtx: Number(e.target.value) })}>
              {NUM_CTX_OPTIONS.map((n) => (
                <option key={n} value={n} disabled={!!n && !!shownModel?.contextLength && n > shownModel.contextLength}>
                  {n ? formatTokens(n) : '(既定)'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          権限モード
          <select
            value={shown.permissionMode}
            disabled={settingsLocked}
            title={settingsLocked ? LOCKED_TITLE : undefined}
            onChange={(e) => changeSettings({ permissionMode: e.target.value as PermissionMode })}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <label
          className="check"
          title="検索（ローカルの SearXNG 経由）と Web ページの取得をモデルに許します。検索語や URL は外部に送られます（秘密情報らしいものは送りません）"
        >
          <input
            type="checkbox"
            checked={shown.web}
            disabled={settingsLocked}
            onChange={(e) => changeSettings({ web: e.target.checked })}
          />
          Web 検索（SearXNG）
        </label>
        {shown.web && state.searxng && !state.searxng.ok && (
          <div className="hint">SearXNG が起動していません。ターミナルで npm run searxng を実行してください（{state.searxng.url}）</div>
        )}
        <label>
          再開するセッションID（任意）
          <input value={resumeInput} onChange={(e) => setResumeInput(e.target.value)} />
        </label>

        <div className="row">
          <button
            className="primary"
            disabled={!canStart}
            onClick={() => {
              startIn(tab.key, cwd, resumeInput.trim() || undefined);
              setResumeInput('');
            }}
          >
            {tab.running ? '新しく開始' : '開始'}
          </button>
          <button disabled={!tab.running} onClick={() => send({ type: 'stop', key: tab.key })}>停止</button>
        </div>
        <div className="hint-muted">
          {live
            ? 'このタブでは、変更は次のメッセージから適用されます（新しく開始するときの既定にもなります）。'
            : 'モデル・思考・コンテキスト長・権限モードは「開始」時に適用されます。'}
        </div>

        <label className={`check ${settings.autoApprove ? 'auto-on' : ''}`}>
          <input type="checkbox" checked={!!settings.autoApprove} onChange={(e) => toggleAutoApprove(e.target.checked)} />
          自動承認（ホストに影響する操作は除く）
        </label>
        <details className="auto-rules">
          <summary>自動承認の対象</summary>
          <ul>
            <li>作業フォルダ内のファイル編集（.git・.env などは除く）</li>
            <li>読み取り系のツール・コマンド</li>
            <li>作業フォルダ内で完結するコマンド：git init/status/add/commit、npm install/run/test（-g なし）、tsc・pytest など</li>
          </ul>
          <div>
            <b>git init/add/commit/push の直前</b>に、API キー・パスワード・秘密鍵・.env・.gitignore すべきファイルを自動でチェックします
            （自動承認が OFF でも、権限モードが bypassPermissions でも実行）。1 件でも見つかれば自動承認せず、内容を表示して確認を求めます。
          </div>
          <div>
            <b>手動確認のまま：</b>削除、作業フォルダ外への書き込み、git push/reset、グローバルインストール、
            管理者権限、プロセス操作、任意コードの実行、判定できないもの
          </div>
        </details>

        <label className="check" title="ブラウザが裏にあるとき、または別のタブで完了・許可待ちが起きたときに通知します">
          <input
            type="checkbox"
            checked={!!settings.notify && notifyPermission === 'granted'}
            disabled={!notificationsSupported()}
            onChange={(e) => toggleNotify(e.target.checked)}
          />
          通知（完了・許可待ち）
        </label>
        {notifyPermission === 'denied' && (
          <div className="hint">ブラウザで通知がブロックされています。アドレスバーのサイト設定から許可してください。</div>
        )}

        <SessionPanel tab={tab} onCompact={() => send({ type: 'compact', key: tab.key })} />
        <SessionHistory
          state={state}
          cwd={cwd}
          activeSessionId={tab.session?.sessionId ?? tab.resumeId}
          openSessionIds={openSessionIds}
          onRefresh={() => send({ type: 'listSessions' })}
          onResume={openSession}
        />
        <OllamaPanel ollama={state.ollama} loaded={state.loaded} onRefresh={() => send({ type: 'listModels' })} />
        <div className="data-dir" title={`セッションの保存先: ${state.dataDir}`}>{state.dataDir}</div>
      </aside>

      <main
        className={`main ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addImages(tab.key, imageFiles(e.dataTransfer.files));
        }}
      >
        <TabBar
          state={state}
          onActivate={(key) => dispatch({ type: 'activate', key })}
          onClose={closeTab}
          onNew={() => dispatch({ type: 'newTab', key: newTabKey(), cwd })}
          onPermission={answerPermission}
        />
        {!tab.running && tab.items.length === 0 ? (
          <Welcome
            state={state}
            cwd={cwd}
            canStart={canStart}
            openSessionIds={openSessionIds}
            onSelectFolder={(folder) => dispatch({ type: 'setCwd', key: tab.key, cwd: folder })}
            onStartNew={(folder) => startIn(tab.key, folder)}
            onResume={openSession}
          />
        ) : (
          <Transcript
            tab={tab}
            onPermission={(id, allow) => answerPermission(tab.key, id, allow)}
            onSend={(text) => sendUser(tab.key, text)}
          />
        )}
        <Composer
          text={drafts[tab.key] ?? ''}
          setText={(text) => setDrafts((d) => ({ ...d, [tab.key]: text }))}
          attachments={attachments[tab.key] ?? []}
          canAttach={canAttach}
          note={imageNote}
          disabled={!tab.running}
          busy={tab.busy}
          onSend={(text) => {
            sendUser(tab.key, text, attachments[tab.key]);
            setAttachments(({ [tab.key]: _, ...rest }) => rest);
            setImageNote('');
          }}
          onAddImages={(files) => addImages(tab.key, files)}
          onRemoveImage={(id) => setAttachments((a) => ({ ...a, [tab.key]: (a[tab.key] ?? []).filter((x) => x.id !== id) }))}
          onInterrupt={() => send({ type: 'interrupt', key: tab.key })}
        />
      </main>
    </div>
  );
}
