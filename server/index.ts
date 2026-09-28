import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEV_SERVER_PORT, DEV_WEB_PORT, PROD_PORT } from '../shared/ports.js';
import { msg as text, TextError, type Text } from '../shared/i18n/index.js';
import { MAX_IMAGE_BASE64, MAX_IMAGES } from '../shared/protocol.js';
import type { ClientMessage, PermissionMode, ServerMessage, SessionSettings, ThinkSetting } from '../shared/protocol.js';
import { AgentSession, type AgentConfig } from './agent.js';
import { CheckpointStore } from './checkpoints.js';
import { directoryRequest, resolveDirectory } from './directories.js';
import { describeFeatures, parseFeatures } from './features.js';
import { chat, describeError, getStatus, listLoaded, listModels, modelCapabilities, OLLAMA_URL, unloadModel } from './ollama.js';
import { checkpointsOf, DATA_DIR, listFolders, SessionStore, toEvents, toMessages } from './store.js';
import { SEARXNG_URL, searxngReachable } from './web.js';

const HOST = '127.0.0.1';
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? (DEV ? DEV_SERVER_PORT : PROD_PORT));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Built GUI to serve. scripts/harness.mjs uses dist-prod/, so a development `npm run build` never swaps production's GUI. */
const DIST = path.resolve(ROOT, process.env.HARNESS_DIST ?? 'dist');
const DEFAULT_CWD = resolveDirectory(process.env.HARNESS_CWD ?? process.cwd());
/** Sessions at once. They share the machine's memory, so keep this modest. */
const MAX_SESSIONS = 10;
/** A session no GUI shows any more is stopped after this long without a turn running (see `live`). */
const DETACHED_IDLE_MS = 30 * 60_000;
const PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const THINK_SETTINGS = new Set<ThinkSetting>(['', 'on', 'off', 'low', 'medium', 'high']);

// Any web page can open a WebSocket to localhost, so only accept our own origins.
// Otherwise a malicious site could run commands on this machine through the agent.
const ALLOWED_ORIGINS = new Set(
  (DEV ? [DEV_WEB_PORT] : [PORT]).flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
);

/** Experimental changes to turn on for every session, e.g. HARNESS_FEATURES=fuzzyEdit,trimOutputs (server/features.ts). */
const FEATURES = parseFeatures(process.env.HARNESS_FEATURES);

const store = new SessionStore();
const checkpoints = new CheckpointStore();
checkpoints.prune().catch((err) => console.error(`古いチェックポイントの削除に失敗: ${err}`));

const errorText = (err: unknown): Text => (err instanceof TextError ? err.text : String(err));

/** One browser connection. */
interface Connection {
  send: (m: ServerMessage) => void;
  autoApprove: boolean;
}

/**
 * Running sessions by GUI tab key. A session outlives the connection that started it: closing or reloading the page
 * detaches it, the turn goes on, and the tab attaches again when it comes back (`attach`).
 */
interface Live {
  session: AgentSession;
  /** The connection showing this tab; none while detached. */
  owner?: Connection;
  /** Auto-approval as last set by a connection showing it, kept while detached. */
  autoApprove: boolean;
  lastActive: number;
}
const live = new Map<string, Live>();

setInterval(() => {
  for (const [key, l] of live) {
    if (!l.owner && !l.session.busy && Date.now() - l.lastActive > DETACHED_IDLE_MS) {
      live.delete(key);
      l.session.stop();
    }
  }
}, 60_000).unref();

/** Validated session settings plus the model's capabilities. Throws a message for the user. */
async function resolveSettings(o: SessionSettings) {
  if (!o.model) throw new TextError(text('error.chooseModel'));
  let capabilities: string[];
  try {
    capabilities = await modelCapabilities(o.model);
  } catch (err) {
    throw new TextError(text('error.modelUnavailable', { model: o.model, reason: describeError(err) }));
  }
  return {
    model: o.model,
    think: THINK_SETTINGS.has(o.think ?? '') ? (o.think ?? '') : '',
    numCtx: o.numCtx && o.numCtx > 0 ? Math.floor(o.numCtx) : undefined,
    permissionMode: PERMISSION_MODES.has(o.permissionMode!) ? o.permissionMode! : 'default',
    web: o.web === true,
    capabilities,
  } satisfies Omit<AgentConfig, 'sessionId' | 'cwd'>;
}

/** Images from the client: plain base64, within the limits. Returns an error message, or undefined when valid. */
function checkImages(images: unknown): Text | undefined {
  if (images === undefined) return;
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return text('error.tooManyImages', { max: MAX_IMAGES });
  for (const img of images) {
    if (typeof img !== 'string' || !img || img.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(img)) {
      return text('error.badImage');
    }
  }
}

const app = express();
// Lets scripts/harness.mjs tell this server apart from another program on the port.
app.get('/api/health', (_req, res) => res.json({ app: 'moooyooo-local-llm-harness', pid: process.pid, port: PORT, dev: DEV }));
if (!DEV && existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  const hint = DEV ? `Dev mode: open http://localhost:${DEV_WEB_PORT}` : 'dist/ がありません。先に npm run build を実行してください。';
  app.get('/', (_req, res) => res.type('text').send(hint));
}

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin }: { origin?: string }) => !!origin && ALLOWED_ORIGINS.has(origin),
});

wss.on('connection', (ws: WebSocket) => {
  const conn: Connection = { send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), autoApprove: false };
  const { send } = conn;
  /** Latest `start` per key, so a slow start that was superseded doesn't register. */
  const starting = new Map<string, symbol>();
  /** The session of a tab this connection shows. */
  const sessionOf = (key: string) => {
    const l = live.get(key);
    return l?.owner === conn ? l.session : undefined;
  };

  const stopSession = (key: string) => {
    starting.delete(key);
    const l = live.get(key);
    if (!l) return;
    live.delete(key);
    l.session.stop();
    send({ type: 'status', key, running: false });
    if (l.owner && l.owner !== conn) l.owner.send({ type: 'status', key, running: false });
  };

  /** Shows a running session in this connection's tab `key` again: its history, state and pending prompts. */
  const attach = async (key: string) => {
    const l = live.get(key);
    if (!l) return send({ type: 'status', key, running: false });
    // Another window showing the same tab loses it.
    if (l.owner && l.owner !== conn) l.owner.send({ type: 'status', key, running: false });
    l.owner = conn;
    l.autoApprove = conn.autoApprove;
    const s = l.session;
    const records = (await store.load(s.config.sessionId)) ?? [];
    if (live.get(key) !== l || l.owner !== conn) return;
    send({ type: 'status', key, running: true });
    send({ type: 'attached', key, sessionId: s.config.sessionId, ...toEvents(records), busy: s.busy });
    s.init();
    for (const ev of s.pendingPrompts()) send({ type: 'event', key, ev });
  };

  const sendModels = async () => {
    const [ollama, searxOk] = await Promise.all([getStatus(), searxngReachable()]);
    const searxng = { url: SEARXNG_URL, ok: searxOk };
    if (ollama.error) return send({ type: 'models', ollama, models: [], loaded: [], searxng });
    try {
      const [models, loaded] = await Promise.all([listModels(), listLoaded()]);
      send({ type: 'models', ollama, models, loaded, searxng });
    } catch (err) {
      send({ type: 'models', ollama: { ...ollama, error: describeError(err) }, models: [], loaded: [], searxng });
    }
  };

  const start = async (key: string, msg: Extract<ClientMessage, { type: 'start' }>) => {
    stopSession(key);
    const token = Symbol(key);
    starting.set(key, token);
    const o = msg.options;
    const cwd = resolveDirectory(o.cwd || DEFAULT_CWD, DEFAULT_CWD);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return send({ type: 'error', key, message: text('error.noFolder', { path: cwd }) });
    }
    let settings: Awaited<ReturnType<typeof resolveSettings>>;
    try {
      settings = await resolveSettings(o);
    } catch (err) {
      return send({ type: 'error', key, message: errorText(err) });
    }
    const records = o.resume ? await store.load(o.resume) : undefined;
    if (o.resume && !records) return send({ type: 'error', key, message: text('error.noHistory', { id: o.resume }) });
    // Superseded by another start/stop for this tab, or the socket closed, while loading.
    if (starting.get(key) !== token) return;
    starting.delete(key);
    if (live.size >= MAX_SESSIONS) {
      return send({ type: 'error', key, message: text('error.tooManySessions', { max: MAX_SESSIONS }) });
    }

    const s = new AgentSession(
      {
        sessionId: o.resume ?? randomUUID(),
        cwd,
        ...settings,
        history: records ? toMessages(records) : undefined,
        checkpoints: records ? checkpointsOf(records) : undefined,
        features: FEATURES,
      },
      {
        chat,
        store,
        autoApprove: () => live.get(key)?.autoApprove ?? false,
        contextLength: async (model) => (await listLoaded()).find((m) => m.name === model)?.contextLength,
        unload: (model, signal) => unloadModel(model, signal),
        checkpoints,
      },
    );
    const entry: Live = { session: s, owner: conn, autoApprove: conn.autoApprove, lastActive: Date.now() };
    s.on('event', (ev) => {
      entry.lastActive = Date.now();
      entry.owner?.send({ type: 'event', key, ev });
    });
    live.set(key, entry);
    send({ type: 'status', key, running: true });
    s.init();
    if (records && o.resume) send({ type: 'history', key, sessionId: o.resume, ...toEvents(records) });
  };

  send({ type: 'hello', defaultCwd: DEFAULT_CWD, dataDir: DATA_DIR });

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return send({ type: 'error', message: 'Invalid JSON from client' });
    }
    switch (msg.type) {
      case 'listDirectories':
      case 'createDirectory':
        if (!isValidKey(msg.requestId)) return;
        directoryRequest(msg, DEFAULT_CWD)
          .then((data) => send({ type: 'directory', requestId: msg.requestId, data }))
          .catch((err) => send({ type: 'directory', requestId: msg.requestId, error: errorText(err) }));
        return;
      case 'setAutoApprove':
        conn.autoApprove = !!msg.enabled;
        for (const l of live.values()) if (l.owner === conn) l.autoApprove = conn.autoApprove;
        return;
      case 'attach':
        for (const key of Array.isArray(msg.keys) ? msg.keys.slice(0, MAX_SESSIONS * 2) : []) {
          if (isValidKey(key)) attach(key).catch((err) => send({ type: 'error', key, message: String(err) }));
        }
        return;
      case 'listModels':
        sendModels();
        return;
      case 'listSessions':
        store
          .list()
          .then(async (list) => send({ type: 'sessions', sessions: list, folders: await listFolders(list) }))
          .catch((err) => send({ type: 'error', message: text('error.historyLoad', { reason: String(err) }) }));
        return;
    }
    if (!isValidKey(msg.key)) return send({ type: 'error', message: 'Invalid session key' });

    switch (msg.type) {
      case 'start':
        start(msg.key, msg).catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      case 'user': {
        const s = sessionOf(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: text('error.notStarted') });
        if (s.busy) return send({ type: 'error', key: msg.key, message: text('error.busySend') });
        const badImages = checkImages(msg.images);
        if (badImages) return send({ type: 'error', key: msg.key, message: badImages });
        const images = msg.images?.length ? msg.images : undefined;
        if (images && !s.config.capabilities.includes('vision')) {
          return send({ type: 'error', key: msg.key, message: text('error.noVision', { model: s.config.model }) });
        }
        if (typeof msg.text !== 'string' || (!msg.text.trim() && !images)) return;
        s.sendUser(msg.text, images).catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      }
      case 'configure': {
        const s = sessionOf(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: text('error.notStarted') });
        resolveSettings(msg.options ?? {})
          .then((settings) => {
            if (!s.configure(settings)) send({ type: 'error', key: msg.key, message: text('error.busyConfigure') });
          })
          .catch((err) => send({ type: 'error', key: msg.key, message: errorText(err) }));
        break;
      }
      case 'permission':
        sessionOf(msg.key)?.respondPermission(msg.requestId, !!msg.allow, msg.message);
        break;
      case 'compact': {
        const s = sessionOf(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: text('error.notStarted') });
        if (s.busy) return send({ type: 'error', key: msg.key, message: text('error.busyCompact') });
        s.compactNow().catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      }
      case 'checkpointChanges':
      case 'checkpointPatch':
      case 'restoreCheckpoint': {
        const s = sessionOf(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: text('error.notStarted') });
        // Only this session's own checkpoints (which also keeps the commit a plain hash).
        if (typeof msg.commit !== 'string' || !s.hasCheckpoint(msg.commit)) {
          return send({ type: 'error', key: msg.key, message: text('checkpoint.unknown') });
        }
        const { key, commit } = msg;
        const cwd = s.config.cwd;
        if (msg.type === 'restoreCheckpoint') {
          if (s.busy) return send({ type: 'error', key, message: text('error.busyRestore') });
          s.restoreCheckpoint(commit).catch((err) => send({ type: 'error', key, message: String(err) }));
        } else if (msg.type === 'checkpointChanges') {
          checkpoints
            .changes(cwd, commit)
            .then((r) => send({ type: 'checkpointChanges', key, commit, ...r }))
            .catch((err) => send({ type: 'checkpointChanges', key, commit, files: [], truncated: false, error: errorText(err) }));
        } else {
          const file = msg.path;
          if (typeof file !== 'string' || !file || file.length > 4096) return;
          checkpoints
            .patch(cwd, commit, file)
            .then((r) => send({ type: 'checkpointPatch', key, commit, path: file, ...r }))
            .catch((err) => send({ type: 'checkpointPatch', key, commit, path: file, patch: '', truncated: false, error: errorText(err) }));
        }
        break;
      }
      case 'interrupt':
        sessionOf(msg.key)?.interrupt();
        break;
      case 'stop':
        stopSession(msg.key);
        break;
    }
  });

  // Sessions go on without a GUI; the tab attaches again when the page comes back.
  ws.on('close', () => {
    starting.clear();
    for (const l of live.values()) {
      if (l.owner !== conn) continue;
      l.owner = undefined;
      l.lastActive = Date.now();
    }
  });
});

function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\w-]{1,64}$/.test(key);
}

server.listen(PORT, HOST, () => {
  console.log(`moooyooo-local-llm-harness ${DEV ? 'dev API' : 'server'}: http://localhost:${PORT}`);
  if (DEV) console.log(`GUI (Vite): http://localhost:${DEV_WEB_PORT}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`実験的な機能: ${describeFeatures(FEATURES)}`);
  console.log(`セッションの保存先: ${store.dir}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`ポート ${PORT} は使用中です（すでに起動済みの可能性があります）。`);
  else console.error(err);
  process.exit(1);
});
