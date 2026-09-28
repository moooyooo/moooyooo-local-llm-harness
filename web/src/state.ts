import type {
  AgentEvent,
  CheckpointReason,
  FileChange,
  FolderSummary,
  LoadedModel,
  ModelInfo,
  OllamaStatus,
  PermissionMode,
  SecurityScan,
  ServerMessage,
  SessionSummary,
  ThinkSetting,
  TurnStats,
} from '../../shared/protocol';
import { msg as text, type Text } from '../../shared/i18n';
import { parseTodos, type Todo } from '../../shared/todos';
import { t } from './i18n';
import { imageDataUrl } from './images';
import { baseName } from './util';

export type Item =
  /** `images`: data URLs. */
  | { kind: 'user'; id: string; text: string; images?: string[] }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  /** `callId` comes from the model and may repeat across turns, so it isn't used as the item id. */
  | { kind: 'tool'; id: string; callId: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }
  | {
      kind: 'permission';
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      description?: string;
      /** `auto` = approved by the server because auto-approval was on. `cancelled` = interrupted before an answer. */
      status: 'pending' | 'allowed' | 'denied' | 'auto' | 'cancelled';
      /** Qualifies for auto-approval (no host impact), with the classifier's reason. */
      autoEligible: boolean;
      reason?: Text;
      /** Pre-commit/push security scan (git init/add/commit/push only). */
      security?: SecurityScan;
    }
  | {
      kind: 'result';
      id: string;
      isError: boolean;
      subtype: Extract<AgentEvent, { type: 'result' }>['subtype'];
      message?: Text;
      durationMs: number;
      numTurns: number;
      stats?: TurnStats;
      /** The turn stopped before the model finished (error, interrupt, limit, cut-off), so continuing is offered. */
      unfinished: boolean;
    }
  /** Kept as `Text`, so it follows the language when that changes. */
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: Text }
  /** Older messages were replaced by this summary (estimated prompt tokens before → after). */
  | { kind: 'compact'; id: string; auto: boolean; summary: string; tokensBefore?: number; tokensAfter?: number; trimmed?: number }
  /** The working folder's files were recorded; they can be put back to this point. `at`: ISO time. */
  | { kind: 'checkpoint'; id: string; commit: string; n: number; reason: CheckpointReason; changed: number; at: string; excluded?: string[] };

export type PermissionItem = Extract<Item, { kind: 'permission' }>;
export type CheckpointItem = Extract<Item, { kind: 'checkpoint' }>;

/** What changed since a checkpoint, as last fetched (`files` undefined = loading), and diffs of single files. */
export interface CheckpointData {
  files?: FileChange[];
  truncated?: boolean;
  error?: Text;
  patches: Record<string, { patch?: string; truncated?: boolean; error?: Text }>;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  think: ThinkSetting;
  numCtx?: number;
  /** WebSearch / WebFetch are offered. */
  web: boolean;
  /** false when the model has no tool support (chat only). */
  tools: boolean;
}

/** One GUI tab = one agent session (or a not-yet-started welcome screen). */
export interface Tab {
  key: string;
  /** Working folder; '' means the server's default. */
  cwd: string;
  running: boolean;
  busy: boolean;
  session?: SessionInfo;
  /** Session being resumed, until `init` arrives (to avoid opening the same session twice). */
  resumeId?: string;
  items: Item[];
  /** Assistant text / thinking being streamed (not yet committed as items). */
  streamText: string;
  streamThinking: string;
  /** Token counts of the latest turn. */
  stats?: TurnStats;
  /** When the latest prompt or event of this tab arrived (ms), to show how long the model has been quiet. */
  lastActivity?: number;
  /** The model is summarizing the conversation. */
  compacting?: boolean;
  /** Changes since each checkpoint, by commit, fetched when the user opens them. */
  checkpointData: Record<string, CheckpointData>;
  /** Commit of the checkpoint being restored. */
  restoring?: string;
  /** A turn finished while another tab was active. Cleared when the tab is shown. */
  unread: boolean;
}

export type TabStatus = 'permission' | 'busy' | 'idle' | 'stopped';

export interface State {
  connected: boolean;
  defaultCwd: string;
  dataDir: string;
  /** undefined = not received yet. */
  ollama?: OllamaStatus;
  models: ModelInfo[];
  /** Models currently in memory. */
  loaded: LoadedModel[];
  /** The local SearXNG behind WebSearch; undefined = not checked yet. */
  searxng?: { url: string; ok: boolean };
  /** Saved sessions, newest first. */
  sessions: SessionSummary[];
  /** Working folders that have sessions, newest first. */
  folders: FolderSummary[];
  tabs: Tab[];
  activeKey: string;
}

export function newTabKey(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newTab(cwd: string, key = newTabKey()): Tab {
  return { key, cwd, running: false, busy: false, items: [], streamText: '', streamThinking: '', unread: false, checkpointData: {} };
}

/** Tabs kept across page loads, so running sessions can be shown again (see `attached`). */
export interface SavedTabs {
  tabs: { key: string; cwd: string }[];
  activeKey?: string;
}

export function createInitialState({ cwd, saved }: { cwd: string; saved?: SavedTabs }): State {
  const tabs = saved?.tabs.length ? saved.tabs.map((tb) => newTab(tb.cwd, tb.key)) : [newTab(cwd)];
  const activeKey = tabs.some((tb) => tb.key === saved?.activeKey) ? saved!.activeKey! : tabs[0].key;
  return { connected: false, defaultCwd: '', dataDir: '', models: [], loaded: [], sessions: [], folders: [], tabs, activeKey };
}

export function activeTab(state: State): Tab {
  return state.tabs.find((t) => t.key === state.activeKey) ?? state.tabs[0];
}

export function tabCwd(state: State, tab: Tab): string {
  return tab.cwd || state.defaultCwd;
}

export function tabLabel(state: State, tab: Tab): string {
  return baseName(tabCwd(state, tab)) || t('tabs.untitled');
}

export function pendingPermissions(tab: Tab): PermissionItem[] {
  return tab.items.filter((it): it is PermissionItem => it.kind === 'permission' && it.status === 'pending');
}

/** The model's checklist from its latest successful TodoWrite call. */
export function latestTodos(tab: Tab): Todo[] | undefined {
  const call = tab.items.findLast((it) => it.kind === 'tool' && it.name === 'TodoWrite' && it.result != null && !it.isError);
  if (call?.kind !== 'tool') return undefined;
  const parsed = parseTodos(call.input.todos);
  return 'todos' in parsed ? parsed.todos : undefined;
}

export function tabStatus(tab: Tab): TabStatus {
  if (pendingPermissions(tab).length > 0) return 'permission';
  if (tab.busy) return 'busy';
  return tab.running ? 'idle' : 'stopped';
}

export type Action =
  | { type: 'connected'; value: boolean }
  /** `at`: when the message arrived (ms). */
  | { type: 'server'; msg: ServerMessage; at: number }
  | { type: 'newTab'; key: string; cwd: string }
  | { type: 'closeTab'; key: string }
  | { type: 'activate'; key: string }
  | { type: 'setCwd'; key: string; cwd: string }
  | { type: 'resetTab'; key: string; cwd: string; resumeId?: string }
  | { type: 'markUnread'; key: string }
  /** `images`: data URLs of the attached images. */
  | { type: 'userSent'; key: string; text: string; images?: string[]; at: number }
  | { type: 'permissionAnswered'; key: string; id: string; allow: boolean }
  | { type: 'checkpointRequested'; key: string; commit: string }
  | { type: 'patchRequested'; key: string; commit: string; path: string }
  | { type: 'restoreRequested'; key: string; commit: string };

let seq = 0;
const nextId = () => `i${++seq}`;

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'connected':
      // The server stops every session when the socket drops.
      return {
        ...state,
        connected: action.value,
        tabs: action.value
          ? state.tabs
          : state.tabs.map((t) => ({ ...t, running: false, busy: false, compacting: false, restoring: undefined, streamText: '', streamThinking: '' })),
      };
    case 'newTab':
      return { ...state, tabs: [...state.tabs, newTab(action.cwd, action.key)], activeKey: action.key };
    case 'closeTab': {
      const idx = state.tabs.findIndex((t) => t.key === action.key);
      if (idx < 0) return state;
      const rest = state.tabs.filter((t) => t.key !== action.key);
      if (rest.length === 0) {
        const tab = newTab(state.tabs[idx].cwd);
        return { ...state, tabs: [tab], activeKey: tab.key };
      }
      const activeKey = state.activeKey === action.key ? rest[Math.min(idx, rest.length - 1)].key : state.activeKey;
      return { ...state, tabs: rest, activeKey };
    }
    case 'activate':
      return updateTab({ ...state, activeKey: action.key }, action.key, (t) => ({ ...t, unread: false }));
    case 'setCwd':
      return updateTab(state, action.key, (t) => ({ ...t, cwd: action.cwd }));
    case 'resetTab':
      return updateTab(state, action.key, (t) => ({ ...newTab(action.cwd, t.key), resumeId: action.resumeId }));
    case 'markUnread':
      return updateTab(state, action.key, (t) => ({ ...t, unread: true }));
    case 'userSent':
      return updateTab(state, action.key, (t) => ({
        ...pushItems(t, { kind: 'user', id: nextId(), text: action.text, images: action.images }),
        busy: true,
        lastActivity: action.at,
      }));
    case 'permissionAnswered':
      return updateTab(state, action.key, (t) => ({
        ...t,
        items: t.items.map((it) =>
          it.kind === 'permission' && it.id === action.id ? { ...it, status: action.allow ? 'allowed' : 'denied' } : it,
        ),
      }));
    case 'checkpointRequested':
      return updateTab(state, action.key, (t) => ({ ...t, checkpointData: { ...t.checkpointData, [action.commit]: { patches: {} } } }));
    case 'patchRequested':
      return updateCheckpoint(state, action.key, action.commit, (d) => ({ ...d, patches: { ...d.patches, [action.path]: {} } }));
    case 'restoreRequested':
      return updateTab(state, action.key, (t) => ({ ...t, busy: true, restoring: action.commit }));
    case 'server':
      return onServer(state, action.msg, action.at);
  }
}

function updateCheckpoint(state: State, key: string, commit: string, fn: (d: CheckpointData) => CheckpointData): State {
  return updateTab(state, key, (t) => {
    const d = t.checkpointData[commit];
    return d ? { ...t, checkpointData: { ...t.checkpointData, [commit]: fn(d) } } : t;
  });
}

function updateTab(state: State, key: string, fn: (t: Tab) => Tab): State {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    if (t.key !== key) return t;
    const next = fn(t);
    changed ||= next !== t;
    return next;
  });
  return changed ? { ...state, tabs } : state;
}

function onServer(state: State, msg: ServerMessage, at: number): State {
  switch (msg.type) {
    case 'directory':
      // Request/reply data belongs to the folder picker, not to a session transcript.
      return state;
    case 'hello':
      return { ...state, defaultCwd: msg.defaultCwd, dataDir: msg.dataDir };
    case 'models':
      return { ...state, ollama: msg.ollama, models: msg.models, loaded: msg.loaded, searxng: msg.searxng };
    case 'sessions':
      return { ...state, sessions: msg.sessions, folders: msg.folders };
    case 'status':
      return updateTab(state, msg.key, (t) =>
        msg.running
          ? { ...t, running: true }
          : { ...t, running: false, busy: false, compacting: false, restoring: undefined, streamText: '', streamThinking: '' },
      );
    case 'error':
      return updateTab(state, msg.key ?? state.activeKey, (t) =>
        // A refused restore (e.g. busy) never gets its own answer.
        pushItems(t.restoring ? { ...t, busy: false, restoring: undefined } : t, { kind: 'notice', id: nextId(), level: 'error', text: msg.message }),
      );
    case 'history':
      return updateTab(state, msg.key, (t) => {
        let next = t;
        if (msg.omitted > 0) next = pushItems(next, notice(text('history.omitted', { count: msg.omitted })));
        for (const ev of msg.events) next = onEvent(next, ev);
        return pushItems({ ...next, busy: false }, notice(text('history.end', { id: msg.sessionId.slice(0, 8) })));
      });
    case 'attached':
      // The page reconnected to a session that kept running: rebuild the tab from what the session saved.
      return updateTab(state, msg.key, (t) => {
        let next: Tab = { ...newTab(t.cwd, t.key), running: true, session: t.session };
        if (msg.omitted > 0) next = pushItems(next, notice(text('history.omitted', { count: msg.omitted })));
        for (const ev of msg.events) next = onEvent(next, ev);
        return { ...next, busy: msg.busy, lastActivity: at };
      });
    case 'event': {
      const unread = msg.ev.type === 'result' && msg.key !== state.activeKey;
      return updateTab(state, msg.key, (t) => ({ ...onEvent(t, msg.ev), lastActivity: at, ...(unread && { unread: true }) }));
    }
    case 'checkpointChanges': {
      const { files, truncated, error } = msg;
      return updateCheckpoint(state, msg.key, msg.commit, (d) => ({ ...d, files, truncated, error }));
    }
    case 'checkpointPatch': {
      const { patch, truncated, error } = msg;
      return updateCheckpoint(state, msg.key, msg.commit, (d) => ({ ...d, patches: { ...d.patches, [msg.path]: { patch, truncated, error } } }));
    }
  }
}

function notice(value: Text): Item {
  return { kind: 'notice', id: nextId(), level: 'info', text: value };
}

function onEvent(tab: Tab, ev: AgentEvent): Tab {
  switch (ev.type) {
    case 'init': {
      const { type: _, ...session } = ev;
      return { ...tab, session, cwd: session.cwd };
    }
    case 'delta':
      return ev.channel === 'text'
        ? { ...tab, streamText: tab.streamText + ev.text }
        : { ...tab, streamThinking: tab.streamThinking + ev.text };
    case 'user':
      return pushItems(tab, { kind: 'user', id: nextId(), text: ev.text, images: ev.images?.map(imageDataUrl) });
    case 'notice':
      return pushItems(tab, notice(ev.text));
    case 'compact': {
      // A manual compaction runs between turns, so only then does it decide whether the tab is busy.
      const busy = ev.auto ? tab.busy : ev.phase === 'start';
      if (ev.phase === 'start') return { ...tab, busy, compacting: true };
      const next = { ...tab, busy, compacting: false };
      if (ev.phase === 'failed') {
        const reason = ev.message ?? text('common.unknownError');
        return pushItems(next, { kind: 'notice', id: nextId(), level: 'error', text: text('transcript.compactFailed', { reason }) });
      }
      const { auto, tokensBefore, tokensAfter, trimmed } = ev;
      return {
        ...pushItems(next, { kind: 'compact', id: nextId(), auto, summary: ev.summary ?? '', tokensBefore, tokensAfter, trimmed }),
        stats: next.stats && tokensAfter != null ? { ...next.stats, contextUsed: tokensAfter } : next.stats,
      };
    }
    case 'assistant': {
      const items: Item[] = [];
      if (ev.thinking) items.push({ kind: 'thinking', id: nextId(), text: ev.thinking });
      if (ev.text.trim()) items.push({ kind: 'text', id: nextId(), text: ev.text });
      for (const c of ev.toolCalls) items.push({ kind: 'tool', id: nextId(), callId: c.id, name: c.name, input: c.input });
      return { ...pushItems(tab, ...items), streamText: '', streamThinking: '' };
    }
    case 'toolResult': {
      // Update the latest unanswered call with this id.
      let idx = -1;
      for (let i = tab.items.length - 1; i >= 0; i--) {
        const it = tab.items[i];
        if (it.kind === 'tool' && it.callId === ev.id && it.result == null) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return tab;
      const items = [...tab.items];
      items[idx] = { ...(items[idx] as Extract<Item, { kind: 'tool' }>), result: ev.output, isError: ev.isError };
      return { ...tab, items };
    }
    case 'permission':
      return pushItems(tab, {
        kind: 'permission',
        id: ev.id,
        toolName: ev.toolName,
        input: ev.input,
        description: ev.description,
        status: ev.approval.applied ? 'auto' : 'pending',
        autoEligible: ev.approval.auto,
        reason: ev.approval.reason,
        security: ev.approval.security,
      });
    case 'checkpoint': {
      const { commit, n, reason, changed, at, excluded } = ev;
      return pushItems(tab, { kind: 'checkpoint', id: nextId(), commit, n, reason, changed, at, excluded });
    }
    case 'restore': {
      const next = { ...tab, busy: false, restoring: undefined };
      if (ev.phase === 'done') return next;
      const reason = ev.message ?? text('common.unknownError');
      return pushItems(next, { kind: 'notice', id: nextId(), level: 'error', text: text('checkpoint.restoreFailed', { reason }) });
    }
    case 'permissionCancelled':
      return {
        ...tab,
        items: tab.items.map((it) => (it.kind === 'permission' && it.id === ev.id && it.status === 'pending' ? { ...it, status: 'cancelled' } : it)),
      };
    case 'result':
      return {
        ...pushItems(tab, {
          kind: 'result',
          id: nextId(),
          isError: ev.isError,
          subtype: ev.subtype,
          message: ev.message,
          durationMs: ev.durationMs,
          numTurns: ev.numTurns,
          stats: ev.stats,
          // A successful turn only has a message when the reply was cut off.
          unfinished: ev.subtype !== 'success' || !!ev.message,
        }),
        busy: false,
        compacting: false,
        streamText: '',
        streamThinking: '',
        stats: ev.stats ?? tab.stats,
      };
  }
}

function pushItems(tab: Tab, ...items: Item[]): Tab {
  return items.length ? { ...tab, items: [...tab.items, ...items] } : tab;
}
