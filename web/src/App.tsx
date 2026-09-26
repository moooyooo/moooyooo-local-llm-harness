import { useEffect, useState } from 'react';
import type { PermissionMode, ServerMessage, SessionSummary, ThinkSetting } from '../../shared/protocol';
import { SessionHistory, Welcome } from './components/Sessions';
import { ModelCaps, OllamaPanel, SessionPanel } from './components/SidebarParts';
import { TabBar } from './components/TabBar';
import type { CheckpointHandlers } from './components/Checkpoint';
import { Composer, Transcript } from './components/Transcript';
import {
  notificationPermission,
  notificationsSupported,
  pageInBackground,
  requestNotificationPermission,
  showNotification,
} from './notifications';
import { base64Of, imageFiles, MAX_IMAGES, readImage, type Attachment } from './images';
import type { MessageKey } from '../../shared/i18n';
import { LANGUAGES, preferredLocale, setLocale, t, tNodes, tx } from './i18n';
import { activeTab, newTabKey, pendingPermissions, tabCwd, tabLabel, type SavedTabs } from './state';
import { useHarness } from './useHarness';
import { formatBytes, formatTokens, summarizeInput } from './util';

/** Levels (low, medium, high) are shown as they are. */
const THINK_OPTIONS: { value: ThinkSetting; label?: MessageKey }[] = [
  { value: '', label: 'app.think.default' },
  { value: 'on', label: 'app.think.on' },
  { value: 'off', label: 'app.think.off' },
  { value: 'low' },
  { value: 'medium' },
  { value: 'high' },
];
const NUM_CTX_OPTIONS = [0, 8192, 16384, 32768, 65536, 131072, 262144];
const PERMISSION_MODES: { value: PermissionMode; label: MessageKey }[] = [
  { value: 'default', label: 'app.mode.default' },
  { value: 'acceptEdits', label: 'app.mode.acceptEdits' },
  { value: 'plan', label: 'app.mode.plan' },
  { value: 'bypassPermissions', label: 'app.mode.bypassPermissions' },
];
const SETTINGS_KEY = 'custom-harnes-local.settings';
/** Open tabs, so a reloaded page shows the sessions that kept running on the server. */
const TABS_KEY = 'custom-harnes-local.tabs';
const APP_TITLE = 'Local LLM Harness';

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
  /** GUI language; unset = the browser's. */
  locale?: string;
}

function loadSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function loadTabs(): SavedTabs | undefined {
  try {
    const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null') as SavedTabs | null;
    return Array.isArray(saved?.tabs) ? { ...saved, tabs: saved.tabs.filter((tb) => typeof tb?.key === 'string' && typeof tb.cwd === 'string') } : undefined;
  } catch {
    return undefined;
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

  const locale = preferredLocale(settings.locale);
  setLocale(locale);
  const [initialTabs] = useState(loadTabs);
  const { state, dispatch, send } = useHarness({ cwd: settings.lastCwd ?? '', saved: initialTabs }, (msg) => notify(msg));
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

  const savedTabs = JSON.stringify({ tabs: state.tabs.map(({ key, cwd: dir }) => ({ key, cwd: dir })), activeKey: state.activeKey } satisfies SavedTabs);
  useEffect(() => {
    try {
      localStorage.setItem(TABS_KEY, savedTabs);
    } catch {
      // storage unavailable
    }
  }, [savedTabs]);

  // The server decides auto-approval, so tell it the setting on every (re)connect and change.
  useEffect(() => {
    if (state.connected) send({ type: 'setAutoApprove', enabled: !!settings.autoApprove });
  }, [state.connected, settings.autoApprove, send]);

  // Tab title: counts of pending permissions (⚠) and finished-but-unseen tabs (✓).
  useEffect(() => {
    const pending = state.tabs.reduce((n, tb) => n + pendingPermissions(tb).length, 0);
    const unread = state.tabs.filter((tb) => tb.unread).length;
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
    const target = state.tabs.find((x) => x.key === msg.key);
    if (!target) return;
    const ev = msg.ev;
    const isPermission = ev.type === 'permission' && !ev.approval.applied;
    // Interrupts are user-initiated, so they need no notification.
    const isDone = ev.type === 'result' && ev.subtype !== 'interrupted';
    if (!isPermission && !isDone) return;

    const background = pageInBackground();
    if (msg.key === state.activeKey && !background) return;
    if (isDone && background) dispatch({ type: 'markUnread', key: msg.key });
    if (!settings.notify) return;

    const name = tabLabel(state, target);
    const open = () => dispatch({ type: 'activate', key: msg.key });
    if (ev.type === 'permission') {
      showNotification(t('app.notify.permission', { name }), `${ev.toolName}: ${ev.description ?? summarizeInput(ev.input)}`, `${msg.key}:perm`, open);
    } else if (ev.type === 'result') {
      const last = [...target.items].reverse().find((it) => it.kind === 'text');
      const body = ev.message ? tx(ev.message) : last?.kind === 'text' ? last.text : '';
      showNotification(t(ev.isError ? 'app.notify.error' : 'app.notify.done', { name }), body.slice(0, 140), `${msg.key}:done`, open);
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
    for (const tb of state.tabs) {
      for (const item of pendingPermissions(tb)) {
        if (item.autoEligible) answerPermission(tb.key, item.id, true);
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
    const open = state.tabs.find((tb) => (tb.session?.sessionId ?? tb.resumeId) === s.sessionId);
    if (open) return dispatch({ type: 'activate', key: open.key });
    let key = tab.key;
    if (tab.running || tab.items.length > 0) {
      key = newTabKey();
      dispatch({ type: 'newTab', key, cwd: s.cwd });
    }
    startIn(key, s.cwd, s.sessionId);
  };

  const closeTab = (key: string) => {
    const target = state.tabs.find((x) => x.key === key);
    if (target?.running && !window.confirm(t('app.closeTabConfirm', { name: tabLabel(state, target) }))) return;
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
      setImageNote(tab.running ? t('app.image.unsupported', { model: shown.model }) : t('app.image.startFirst'));
      return;
    }
    const room = MAX_IMAGES - (attachments[key]?.length ?? 0);
    try {
      const added = await Promise.all(files.slice(0, Math.max(0, room)).map(readImage));
      setAttachments((a) => ({ ...a, [key]: [...(a[key] ?? []), ...added] }));
      setImageNote(files.length > room ? t('app.image.tooMany', { max: MAX_IMAGES }) : '');
    } catch {
      setImageNote(t('app.image.unreadable'));
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

  const checkpointHandlers = (key: string): CheckpointHandlers => ({
    onChanges: (commit) => {
      dispatch({ type: 'checkpointRequested', key, commit });
      send({ type: 'checkpointChanges', key, commit });
    },
    onPatch: (commit, path) => {
      dispatch({ type: 'patchRequested', key, commit, path });
      send({ type: 'checkpointPatch', key, commit, path });
    },
    onRestore: (commit) => {
      dispatch({ type: 'restoreRequested', key, commit });
      send({ type: 'restoreCheckpoint', key, commit });
    },
  });

  const openSessionIds = new Set(state.tabs.map((tb) => tb.session?.sessionId ?? tb.resumeId).filter((x): x is string => !!x));

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>{APP_TITLE} <span className="sub">for Ollama</span></h1>
        <div className={`conn ${state.connected ? 'ok' : 'ng'}`}>{t(state.connected ? 'app.connected' : 'app.disconnected')}</div>

        <label>
          {t('app.cwd')}
          <input
            list="recent-folders"
            value={tab.cwd}
            placeholder={state.defaultCwd}
            disabled={tab.running}
            title={tab.running ? t('app.cwdLocked') : undefined}
            onChange={(e) => dispatch({ type: 'setCwd', key: tab.key, cwd: e.target.value })}
          />
          <datalist id="recent-folders">
            {state.folders.filter((f) => f.exists).map((f) => <option key={f.path} value={f.path} />)}
          </datalist>
        </label>
        <label>
          {t('app.model')}
          <select
            value={shown.model}
            disabled={!state.models.length || settingsLocked}
            title={settingsLocked ? t('app.settingsLocked') : undefined}
            onChange={(e) => changeSettings({ model: e.target.value })}
          >
            {!state.models.length && <option value="">{t('app.noModels')}</option>}
            {live && !shownModel && <option value={live.model}>{live.model}</option>}
            {state.models.map((m) => (
              <option key={m.name} value={m.name}>
                {t('app.modelOption', { name: m.name, details: [m.parameterSize, formatBytes(m.size)].filter(Boolean).join(', ') })}
                {m.capabilities.includes('tools') ? '' : t('app.modelNoTools')}
              </option>
            ))}
          </select>
          <ModelCaps model={shownModel} />
        </label>
        <div className="row2">
          <label title={t(canThink ? 'app.thinkHint' : 'app.thinkUnsupported')}>
            {t('app.think')}
            <select
              value={shown.think}
              disabled={!canThink || settingsLocked}
              onChange={(e) => changeSettings({ think: e.target.value as ThinkSetting })}
            >
              {THINK_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label ? t(o.label) : o.value}</option>)}
            </select>
          </label>
          <label title={t('app.numCtxHint')}>
            {t('app.numCtx')}
            <select value={shown.numCtx} disabled={settingsLocked} onChange={(e) => changeSettings({ numCtx: Number(e.target.value) })}>
              {NUM_CTX_OPTIONS.map((n) => (
                <option key={n} value={n} disabled={!!n && !!shownModel?.contextLength && n > shownModel.contextLength}>
                  {n ? formatTokens(n) : t('app.numCtxDefault')}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t('app.permissionMode')}
          <select
            value={shown.permissionMode}
            disabled={settingsLocked}
            title={settingsLocked ? t('app.settingsLocked') : undefined}
            onChange={(e) => changeSettings({ permissionMode: e.target.value as PermissionMode })}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m.value} value={m.value}>{t(m.label)}</option>
            ))}
          </select>
        </label>
        <label
          className="check"
          title={t('app.webHint')}
        >
          <input
            type="checkbox"
            checked={shown.web}
            disabled={settingsLocked}
            onChange={(e) => changeSettings({ web: e.target.checked })}
          />
          {t('app.web')}
        </label>
        {shown.web && state.searxng && !state.searxng.ok && (
          <div className="hint">{t('app.searxngDown', { url: state.searxng.url })}</div>
        )}
        <label>
          {t('app.resumeId')}
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
            {t(tab.running ? 'app.startNew' : 'app.start')}
          </button>
          <button disabled={!tab.running} onClick={() => send({ type: 'stop', key: tab.key })}>{t('app.stop')}</button>
        </div>
        <div className="hint-muted">
          {live
            ? t('app.settingsLive')
            : t('app.settingsAtStart')}
        </div>

        <label className={`check ${settings.autoApprove ? 'auto-on' : ''}`}>
          <input type="checkbox" checked={!!settings.autoApprove} onChange={(e) => toggleAutoApprove(e.target.checked)} />
          {t('app.autoApprove')}
        </label>
        <details className="auto-rules">
          <summary>{t('app.autoRules')}</summary>
          <ul>
            <li>{t('app.autoRules.edits')}</li>
            <li>{t('app.autoRules.reads')}</li>
            <li>{t('app.autoRules.commands')}</li>
          </ul>
          <div>
            {tNodes('app.autoRules.scan', { when: <b>{t('app.autoRules.scanWhen')}</b> })}
          </div>
          <div>
            {tNodes('app.autoRules.manual', { label: <b>{t('app.autoRules.manualLabel')}</b> })}
          </div>
        </details>

        <label className="check" title={t('app.notifyHint')}>
          <input
            type="checkbox"
            checked={!!settings.notify && notifyPermission === 'granted'}
            disabled={!notificationsSupported()}
            onChange={(e) => toggleNotify(e.target.checked)}
          />
          {t('app.notify')}
        </label>
        {notifyPermission === 'denied' && (
          <div className="hint">{t('app.notifyBlocked')}</div>
        )}

        {LANGUAGES.length > 1 && (
          <label>
            {t('app.language')}
            <select value={locale} onChange={(e) => setSettings({ ...settings, locale: e.target.value })}>
              {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
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
        <div className="data-dir" title={t('app.dataDir', { dir: state.dataDir })}>{state.dataDir}</div>
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
            checkpoint={checkpointHandlers(tab.key)}
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
