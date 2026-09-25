import express from 'express';
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEV_SERVER_PORT, DEV_WEB_PORT, PROD_PORT } from '../shared/ports.js';
import { MAX_IMAGE_BASE64, MAX_IMAGES } from '../shared/protocol.js';
import type { ClientMessage, PermissionMode, ServerMessage, SessionSettings, ThinkSetting } from '../shared/protocol.js';
import { AgentSession, type AgentConfig } from './agent.js';
import { chat, describeError, getStatus, listLoaded, listModels, modelCapabilities, OLLAMA_URL, unloadModel } from './ollama.js';
import { DATA_DIR, listFolders, SessionStore, toEvents, toMessages } from './store.js';
import { SEARXNG_URL, searxngReachable } from './web.js';

const HOST = '127.0.0.1';
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT ?? (DEV ? DEV_SERVER_PORT : PROD_PORT));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const DEFAULT_CWD = process.env.HARNESS_CWD ?? process.cwd();
/** Per connection. Sessions share the machine's memory, so keep this modest. */
const MAX_SESSIONS = 10;
const PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
const THINK_SETTINGS = new Set<ThinkSetting>(['', 'on', 'off', 'low', 'medium', 'high']);

// Any web page can open a WebSocket to localhost, so only accept our own origins.
// Otherwise a malicious site could run commands on this machine through the agent.
const ALLOWED_ORIGINS = new Set(
  (DEV ? [DEV_WEB_PORT] : [PORT]).flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]),
);

const store = new SessionStore();

/** Validated session settings plus the model's capabilities. Throws a message for the user. */
async function resolveSettings(o: SessionSettings) {
  if (!o.model) throw new Error('モデルを選んでください');
  let capabilities: string[];
  try {
    capabilities = await modelCapabilities(o.model);
  } catch (err) {
    throw new Error(`モデル ${o.model} を使えません: ${describeError(err)}`);
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
function checkImages(images: unknown): string | undefined {
  if (images === undefined) return;
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return `画像は 1 回に ${MAX_IMAGES} 枚までです`;
  for (const img of images) {
    if (typeof img !== 'string' || !img || img.length > MAX_IMAGE_BASE64 || !/^[A-Za-z0-9+/]+=*$/.test(img)) {
      return '画像の形式が正しくないか、大きすぎます';
    }
  }
}

const app = express();
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
  // One agent per GUI tab, keyed by the client's tab key.
  const sessions = new Map<string, AgentSession>();
  /** Latest `start` per key, so a slow start that was superseded doesn't register. */
  const starting = new Map<string, symbol>();
  let autoApprove = false;
  const send = (m: ServerMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));

  const stopSession = (key: string) => {
    starting.delete(key);
    const s = sessions.get(key);
    if (!s) return;
    sessions.delete(key);
    s.stop();
    send({ type: 'status', key, running: false });
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
    const cwd = path.resolve(o.cwd || DEFAULT_CWD);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return send({ type: 'error', key, message: `作業フォルダが存在しません: ${cwd}` });
    }
    let settings: Awaited<ReturnType<typeof resolveSettings>>;
    try {
      settings = await resolveSettings(o);
    } catch (err) {
      return send({ type: 'error', key, message: (err as Error).message });
    }
    const records = o.resume ? await store.load(o.resume) : undefined;
    if (o.resume && !records) return send({ type: 'error', key, message: `セッション履歴が見つかりません: ${o.resume}` });
    // Superseded by another start/stop for this tab, or the socket closed, while loading.
    if (starting.get(key) !== token) return;
    starting.delete(key);
    if (sessions.size >= MAX_SESSIONS) {
      return send({ type: 'error', key, message: `同時に開けるセッションは ${MAX_SESSIONS} 個までです` });
    }

    const s = new AgentSession(
      {
        sessionId: o.resume ?? randomUUID(),
        cwd,
        ...settings,
        history: records ? toMessages(records) : undefined,
      },
      {
        chat,
        store,
        autoApprove: () => autoApprove,
        contextLength: async (model) => (await listLoaded()).find((m) => m.name === model)?.contextLength,
        unload: (model, signal) => unloadModel(model, signal),
      },
    );
    s.on('event', (ev) => send({ type: 'event', key, ev }));
    sessions.set(key, s);
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
      case 'setAutoApprove':
        autoApprove = !!msg.enabled;
        return;
      case 'listModels':
        sendModels();
        return;
      case 'listSessions':
        store
          .list()
          .then(async (list) => send({ type: 'sessions', sessions: list, folders: await listFolders(list) }))
          .catch((err) => send({ type: 'error', message: `履歴の読み込みに失敗: ${err}` }));
        return;
    }
    if (!isValidKey(msg.key)) return send({ type: 'error', message: 'Invalid session key' });

    switch (msg.type) {
      case 'start':
        start(msg.key, msg).catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      case 'user': {
        const s = sessions.get(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: 'セッションが開始されていません' });
        if (s.busy) return send({ type: 'error', key: msg.key, message: '応答中です。中断してから送信してください' });
        const badImages = checkImages(msg.images);
        if (badImages) return send({ type: 'error', key: msg.key, message: badImages });
        const images = msg.images?.length ? msg.images : undefined;
        if (images && !s.config.capabilities.includes('vision')) {
          return send({ type: 'error', key: msg.key, message: `${s.config.model} は画像入力に対応していません` });
        }
        if (typeof msg.text !== 'string' || (!msg.text.trim() && !images)) return;
        s.sendUser(msg.text, images).catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      }
      case 'configure': {
        const s = sessions.get(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: 'セッションが開始されていません' });
        resolveSettings(msg.options ?? {})
          .then((settings) => {
            if (!s.configure(settings)) send({ type: 'error', key: msg.key, message: '応答中は設定を変更できません。終わってから変更してください' });
          })
          .catch((err) => send({ type: 'error', key: msg.key, message: (err as Error).message }));
        break;
      }
      case 'permission':
        sessions.get(msg.key)?.respondPermission(msg.requestId, !!msg.allow, msg.message);
        break;
      case 'compact': {
        const s = sessions.get(msg.key);
        if (!s) return send({ type: 'error', key: msg.key, message: 'セッションが開始されていません' });
        if (s.busy) return send({ type: 'error', key: msg.key, message: '応答中です。終わってから要約してください' });
        s.compactNow().catch((err) => send({ type: 'error', key: msg.key, message: String(err) }));
        break;
      }
      case 'interrupt':
        sessions.get(msg.key)?.interrupt();
        break;
      case 'stop':
        stopSession(msg.key);
        break;
    }
  });

  ws.on('close', () => {
    starting.clear();
    for (const key of [...sessions.keys()]) stopSession(key);
  });
});

function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\w-]{1,64}$/.test(key);
}

server.listen(PORT, HOST, () => {
  console.log(`custom-harnes-local-llm ${DEV ? 'dev API' : 'server'}: http://localhost:${PORT}`);
  if (DEV) console.log(`GUI (Vite): http://localhost:${DEV_WEB_PORT}`);
  console.log(`Ollama: ${OLLAMA_URL}`);
  console.log(`セッションの保存先: ${store.dir}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`ポート ${PORT} は使用中です（すでに起動済みの可能性があります）。`);
  else console.error(err);
  process.exit(1);
});
