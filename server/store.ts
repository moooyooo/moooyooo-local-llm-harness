import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, FolderSummary, SessionSummary, ToolCall } from '../shared/protocol.js';
import type { OllamaMessage } from './ollama.js';

/**
 * Sessions are saved as `<data dir>/sessions/<sessionId>.jsonl`, one record per line, appended as the
 * conversation goes. `message` records are exactly what is sent to Ollama, so a session resumes as-is.
 */

export const DATA_DIR = process.env.HARNESS_DATA_DIR ?? path.join(os.homedir(), '.custom-harnes-local');
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_PREVIEW = 200;
const HISTORY_LIMIT = 600;

type ResultEvent = Extract<AgentEvent, { type: 'result' }>;

export type SessionRecord =
  /** Written when a session is first used and whenever it is resumed (the model may differ). */
  | { type: 'meta'; sessionId: string; cwd: string; model: string; timestamp: string }
  /** `notice`: the harness wrote this message itself; the GUI shows the notice instead of the message. */
  | { type: 'message'; message: OllamaMessage; isError?: boolean; notice?: string; timestamp: string }
  | { type: 'result'; result: ResultEvent; timestamp: string };

export class SessionStore {
  readonly dir: string;
  /** Appends to one file are chained so records keep their order. */
  private writes = new Map<string, Promise<void>>();
  private cache = new Map<string, { key: string; summary: SessionSummary | null }>();

  constructor(dataDir = DATA_DIR) {
    this.dir = path.join(dataDir, 'sessions');
  }

  append(sessionId: string, record: SessionRecord): Promise<void> {
    const file = path.join(this.dir, `${sessionId}.jsonl`);
    const next = (this.writes.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        await appendFile(file, JSON.stringify(record) + '\n', 'utf8');
      })
      .catch((err) => console.error(`セッションの保存に失敗: ${file}: ${err}`));
    this.writes.set(sessionId, next);
    return next;
  }

  async load(sessionId: string): Promise<SessionRecord[] | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    await this.writes.get(sessionId);
    try {
      return [...parseLines(await readFile(path.join(this.dir, `${sessionId}.jsonl`), 'utf8'))];
    } catch {
      return null;
    }
  }

  async list(): Promise<SessionSummary[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const files = names.filter((n) => n.endsWith('.jsonl') && SESSION_ID_RE.test(path.basename(n, '.jsonl')));
    const summaries = await Promise.all(files.map((n) => this.summarizeCached(path.join(this.dir, n))));
    return summaries.filter((s): s is SessionSummary => s !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  // Re-parse a file only when its size or mtime changes.
  private async summarizeCached(file: string): Promise<SessionSummary | null> {
    try {
      const st = await stat(file);
      const key = `${st.size}:${st.mtimeMs}`;
      const hit = this.cache.get(file);
      if (hit?.key === key) return hit.summary;
      const summary = summarize(path.basename(file, '.jsonl'), await readFile(file, 'utf8'), st.mtime);
      this.cache.set(file, { key, summary });
      return summary;
    } catch {
      return null;
    }
  }
}

/** Working folders aggregated from sessions (already sorted newest first). */
export async function listFolders(sessions: SessionSummary[]): Promise<FolderSummary[]> {
  const byKey = new Map<string, FolderSummary>();
  for (const s of sessions) {
    if (!s.cwd) continue;
    const key = pathKey(s.cwd);
    const f = byKey.get(key);
    if (f) f.sessionCount++;
    else byKey.set(key, { path: s.cwd, lastUsed: s.updatedAt, sessionCount: 1, exists: false });
  }
  const folders = [...byKey.values()];
  await Promise.all(
    folders.map(async (f) => {
      f.exists = await stat(f.path).then((st) => st.isDirectory(), () => false);
    }),
  );
  return folders;
}

function pathKey(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function summarize(sessionId: string, text: string, mtime: Date): SessionSummary | null {
  const s: SessionSummary = { sessionId, cwd: '', updatedAt: mtime.toISOString(), promptCount: 0 };
  for (const r of parseLines(text)) {
    s.createdAt ??= r.timestamp;
    if (r.type === 'meta') {
      s.cwd ||= r.cwd;
      s.model = r.model;
    } else if (r.type === 'message' && r.message.role === 'user' && !r.notice) {
      const p = preview(r.message.content);
      s.promptCount++;
      s.firstPrompt ??= p;
      s.lastPrompt = p;
    }
  }
  return s.promptCount > 0 ? s : null;
}

/** The conversation to send to Ollama when resuming. */
export function toMessages(records: SessionRecord[]): OllamaMessage[] {
  return records.flatMap((r) => (r.type === 'message' ? [r.message] : []));
}

/** Past turns as GUI events, newest `HISTORY_LIMIT`. */
export function toEvents(records: SessionRecord[]): { events: AgentEvent[]; omitted: number } {
  const events: AgentEvent[] = [];
  for (const r of records) {
    if (r.type === 'result') events.push(r.result);
    if (r.type !== 'message') continue;
    const m = r.message;
    if (r.notice) events.push({ type: 'notice', text: r.notice });
    else if (m.role === 'user') events.push({ type: 'user', text: m.content });
    else if (m.role === 'assistant') events.push({ type: 'assistant', text: m.content, thinking: m.thinking, toolCalls: toToolCalls(m.tool_calls) });
    else if (m.role === 'tool') events.push({ type: 'toolResult', id: m.tool_call_id ?? '', output: m.content, isError: !!r.isError });
  }
  const omitted = Math.max(0, events.length - HISTORY_LIMIT);
  return { events: events.slice(omitted), omitted };
}

export function toToolCalls(calls: Extract<OllamaMessage, { role: 'assistant' }>['tool_calls']): ToolCall[] {
  return (calls ?? []).map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.function.name, input: parseArguments(c.function.arguments) }));
}

/** Tool arguments are an object from Ollama, but some models emit a JSON string. */
export function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function* parseLines(text: string): Generator<SessionRecord> {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // partial line (crash while writing)
    }
  }
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > PROMPT_PREVIEW ? `${one.slice(0, PROMPT_PREVIEW)}…` : one;
}
