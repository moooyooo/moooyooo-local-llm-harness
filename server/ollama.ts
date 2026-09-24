import http from 'node:http';
import https from 'node:https';
import type { LoadedModel, ModelInfo, OllamaStatus } from '../shared/protocol.js';

/**
 * Minimal client for the Ollama REST API (https://github.com/ollama/ollama/blob/main/docs/api.md).
 * Shapes below were checked against Ollama 0.32: tool calls arrive whole (with an `id`) in one streamed
 * chunk, and nothing at all is streamed while one is generated (minutes for a large Write).
 * `think: true` on a model without the `thinking` capability is an error. Hitting `num_predict` ends with
 * done_reason "length" and drops a tool call cut off midway; overflowing `num_ctx` does not stop generation
 * (Ollama silently shifts the context and ends with "stop").
 */

export const OLLAMA_URL = normalizeHost(process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434');

/** `OLLAMA_HOST` may be `0.0.0.0`, `host:port` or a full URL. */
function normalizeHost(host: string): string {
  let h = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  const u = new URL(h);
  if (u.hostname === '0.0.0.0') u.hostname = '127.0.0.1';
  if (!u.port && u.protocol === 'http:') u.port = '11434';
  return u.origin;
}

export interface OllamaToolCall {
  id?: string;
  function: { index?: number; name: string; arguments: Record<string, unknown> | string };
}

export type OllamaMessage =
  | { role: 'system' | 'user'; content: string; images?: string[] }
  | { role: 'assistant'; content: string; thinking?: string; tool_calls?: OllamaToolCall[] }
  | { role: 'tool'; content: string; tool_call_id?: string; tool_name?: string };

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  think?: boolean | 'low' | 'medium' | 'high';
  options?: Record<string, unknown>;
  keep_alive?: string | number;
}

export interface ChatResult {
  content: string;
  thinking: string;
  toolCalls: OllamaToolCall[];
  doneReason?: string;
  promptEvalCount: number;
  evalCount: number;
  /** Nanoseconds. */
  evalDuration: number;
}

export interface ChatCallbacks {
  onContent?: (text: string) => void;
  onThinking?: (text: string) => void;
}

export type ChatFn = (req: ChatRequest, signal: AbortSignal, cb: ChatCallbacks) => Promise<ChatResult>;

async function request(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const signal = init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? 10_000);
  const res = await fetch(`${OLLAMA_URL}${path}`, { ...init, signal });
  if (!res.ok) throw new Error(await errorText(res));
  return res;
}

async function errorText(res: Response): Promise<string> {
  return errorMessage(await res.text().catch(() => ''), res.status);
}

function errorMessage(body: string, status: number | undefined): string {
  try {
    return JSON.parse(body).error ?? body;
  } catch {
    return body || `HTTP ${status}`;
  }
}

/**
 * POSTs JSON and resolves once the response headers arrive. Used instead of fetch for streaming, because fetch
 * gives up with "terminated" after 5 minutes without data, and Ollama sends nothing while it writes a tool call.
 * There is no timeout: the user interrupts through `signal`.
 */
function post(path: string, body: unknown, signal: AbortSignal): Promise<http.IncomingMessage> {
  const url = new URL(path, OLLAMA_URL);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json' }, signal },
      resolve,
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

async function readText(stream: AsyncIterable<Buffer>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts).toString('utf8');
}

/** Streams `/api/chat`, reporting text and thinking as they arrive, and returns the whole message. */
export const chat: ChatFn = async (req, signal, cb) => {
  const res = await post('/api/chat', { ...req, stream: true }, signal);
  if (res.statusCode !== 200) throw new Error(errorMessage(await readText(res).catch(() => ''), res.statusCode));

  const out: ChatResult = { content: '', thinking: '', toolCalls: [], promptEvalCount: 0, evalCount: 0, evalDuration: 0 };
  const decoder = new TextDecoder();
  let buf = '';
  const handle = (line: string) => {
    if (!line.trim()) return;
    const chunk = JSON.parse(line);
    if (chunk.error) throw new Error(String(chunk.error));
    const m = chunk.message ?? {};
    if (m.thinking) {
      out.thinking += m.thinking;
      cb.onThinking?.(m.thinking);
    }
    if (m.content) {
      out.content += m.content;
      cb.onContent?.(m.content);
    }
    if (Array.isArray(m.tool_calls)) out.toolCalls.push(...m.tool_calls);
    if (chunk.done) {
      out.doneReason = chunk.done_reason;
      out.promptEvalCount = chunk.prompt_eval_count ?? 0;
      out.evalCount = chunk.eval_count ?? 0;
      out.evalDuration = chunk.eval_duration ?? 0;
    }
  };
  for await (const part of res) {
    buf += decoder.decode(part as Buffer, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf + decoder.decode());
  return out;
};

export async function getStatus(): Promise<OllamaStatus> {
  try {
    const res = await request('/api/version', { timeoutMs: 3000 });
    return { url: OLLAMA_URL, version: (await res.json()).version };
  } catch (err) {
    return { url: OLLAMA_URL, error: describeError(err) };
  }
}

// `/api/show` is slow-ish and immutable per digest.
const showCache = new Map<string, Pick<ModelInfo, 'capabilities' | 'contextLength'>>();

export async function listModels(): Promise<ModelInfo[]> {
  const res = await request('/api/tags');
  const { models = [] } = (await res.json()) as { models?: any[] };
  const infos = await Promise.all(
    models.map(async (m): Promise<ModelInfo> => {
      const key = `${m.name}@${m.digest}`;
      let extra = showCache.get(key);
      if (!extra) {
        try {
          const show = await (await request('/api/show', { method: 'POST', body: JSON.stringify({ model: m.name }) })).json();
          const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith('.context_length'));
          extra = { capabilities: show.capabilities ?? [], contextLength: ctxKey ? show.model_info[ctxKey] : undefined };
          showCache.set(key, extra);
        } catch {
          extra = { capabilities: [] };
        }
      }
      return {
        name: m.name,
        size: m.size,
        parameterSize: m.details?.parameter_size,
        quantization: m.details?.quantization_level,
        family: m.details?.family,
        modifiedAt: m.modified_at,
        ...extra,
      };
    }),
  );
  return infos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listLoaded(): Promise<LoadedModel[]> {
  const res = await request('/api/ps');
  const { models = [] } = (await res.json()) as { models?: any[] };
  return models.map((m) => ({
    name: m.name,
    size: m.size,
    sizeVram: m.size_vram,
    contextLength: m.context_length,
    expiresAt: m.expires_at,
  }));
}

export async function modelCapabilities(model: string): Promise<string[]> {
  for (const [key, v] of showCache) if (key.startsWith(`${model}@`)) return v.capabilities;
  const show = await (await request('/api/show', { method: 'POST', body: JSON.stringify({ model }) })).json();
  return show.capabilities ?? [];
}

export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: string; cause?: { code?: string } };
  // node:http puts the code on the error itself, fetch on its cause.
  const code = e?.code ?? e?.cause?.code;
  if (code === 'ECONNREFUSED') return `Ollama に接続できません（${OLLAMA_URL}）。ollama serve を起動してください`;
  if (code === 'ECONNRESET') return `Ollama との接続が切れました（${OLLAMA_URL}）。Ollama が終了・再起動した可能性があります`;
  if ((err as Error)?.name === 'TimeoutError') return `Ollama が応答しません（${OLLAMA_URL}）`;
  return e?.message ?? String(err);
}
