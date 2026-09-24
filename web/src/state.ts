import type {
  AgentEvent,
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
import { baseName } from './util';

export type Item =
  | { kind: 'user'; id: string; text: string }
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
      reason?: string;
      /** Pre-commit/push security scan (git init/add/commit/push only). */
      security?: SecurityScan;
    }
  | {
      kind: 'result';
      id: string;
      isError: boolean;
      subtype: string;
      message?: string;
      durationMs: number;
      numTurns: number;
      stats?: TurnStats;
      /** The turn stopped before the model finished (error, interrupt, limit, cut-off), so continuing is offered. */
      unfinished: boolean;
    }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }
  /** Older messages were replaced by this summary (estimated prompt tokens before → after). */
  | { kind: 'compact'; id: string; auto: boolean; summary: string; tokensBefore?: number; tokensAfter?: number };

export type PermissionItem = Extract<Item, { kind: 'permission' }>;

export interface SessionInfo {
  sessionId: string;
  model: string;
  cwd: string;
  permissionMode: PermissionMode;
  think: ThinkSetting;
  numCtx?: number;
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
  return { key, cwd, running: false, busy: false, items: [], streamText: '', streamThinking: '', unread: false };
}

export function createInitialState(cwd: string): State {
  const tab = newTab(cwd);
  return { connected: false, defaultCwd: '', dataDir: '', models: [], loaded: [], sessions: [], folders: [], tabs: [tab], activeKey: tab.key };
}

export function activeTab(state: State): Tab {
  return state.tabs.find((t) => t.key === state.activeKey) ?? state.tabs[0];
}

export function tabCwd(state: State, tab: Tab): string {
  return tab.cwd || state.defaultCwd;
}

export function tabLabel(state: State, tab: Tab): string {
  return baseName(tabCwd(state, tab)) || '新しいタブ';
}

export function pendingPermissions(tab: Tab): PermissionItem[] {
  return tab.items.filter((it): it is PermissionItem => it.kind === 'permission' && it.status === 'pending');
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
  | { type: 'userSent'; key: string; text: string; at: number }
  | { type: 'permissionAnswered'; key: string; id: string; allow: boolean };

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
          : state.tabs.map((t) => ({ ...t, running: false, busy: false, compacting: false, streamText: '', streamThinking: '' })),
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
        ...pushItems(t, { kind: 'user', id: nextId(), text: action.text }),
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
    case 'server':
      return onServer(state, action.msg, action.at);
  }
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
    case 'hello':
      return { ...state, defaultCwd: msg.defaultCwd, dataDir: msg.dataDir };
    case 'models':
      return { ...state, ollama: msg.ollama, models: msg.models, loaded: msg.loaded };
    case 'sessions':
      return { ...state, sessions: msg.sessions, folders: msg.folders };
    case 'status':
      return updateTab(state, msg.key, (t) =>
        msg.running ? { ...t, running: true } : { ...t, running: false, busy: false, compacting: false, streamText: '', streamThinking: '' },
      );
    case 'error':
      return updateTab(state, msg.key ?? state.activeKey, (t) =>
        pushItems(t, { kind: 'notice', id: nextId(), level: 'error', text: msg.message }),
      );
    case 'history':
      return updateTab(state, msg.key, (t) => {
        let next = t;
        if (msg.omitted > 0) next = pushItems(next, notice(`（古い ${msg.omitted} 件は省略）`));
        for (const ev of msg.events) next = onEvent(next, ev);
        return pushItems({ ...next, busy: false }, notice(`— ここまで過去の会話（${msg.sessionId.slice(0, 8)}…）—`));
      });
    case 'event': {
      const unread = msg.ev.type === 'result' && msg.key !== state.activeKey;
      return updateTab(state, msg.key, (t) => ({ ...onEvent(t, msg.ev), lastActivity: at, ...(unread && { unread: true }) }));
    }
  }
}

function notice(text: string): Item {
  return { kind: 'notice', id: nextId(), level: 'info', text };
}

function onEvent(tab: Tab, ev: AgentEvent): Tab {
  switch (ev.type) {
    case 'init': {
      const { type: _, ...session } = ev;
      return { ...tab, session };
    }
    case 'delta':
      return ev.channel === 'text'
        ? { ...tab, streamText: tab.streamText + ev.text }
        : { ...tab, streamThinking: tab.streamThinking + ev.text };
    case 'user':
      return pushItems(tab, { kind: 'user', id: nextId(), text: ev.text });
    case 'notice':
      return pushItems(tab, notice(ev.text));
    case 'compact': {
      // A manual compaction runs between turns, so only then does it decide whether the tab is busy.
      const busy = ev.auto ? tab.busy : ev.phase === 'start';
      if (ev.phase === 'start') return { ...tab, busy, compacting: true };
      const next = { ...tab, busy, compacting: false };
      if (ev.phase === 'failed') {
        return pushItems(next, { kind: 'notice', id: nextId(), level: 'error', text: `会話の要約に失敗しました: ${ev.message ?? '不明なエラー'}` });
      }
      const { auto, tokensBefore, tokensAfter } = ev;
      return {
        ...pushItems(next, { kind: 'compact', id: nextId(), auto, summary: ev.summary ?? '', tokensBefore, tokensAfter }),
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
          subtype: RESULT_LABEL[ev.subtype] ?? ev.subtype,
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

const RESULT_LABEL: Record<string, string> = {
  success: '完了',
  interrupted: '中断しました',
  error: 'エラー',
  max_turns: '上限で停止',
};

function pushItems(tab: Tab, ...items: Item[]): Tab {
  return items.length ? { ...tab, items: [...tab.items, ...items] } : tab;
}
