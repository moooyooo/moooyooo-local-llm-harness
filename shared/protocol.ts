// Messages exchanged between the browser and the harness server over WebSocket.
// User-facing text from the server is a `Text` (see shared/i18n): the GUI shows it in the viewer's language.
import type { Text } from './i18n/index.js';
// The server runs the agent loop against Ollama and reports progress as `AgentEvent`s.

/**
 * - `default`: reads inside the working folder run silently; edits and shell commands ask.
 * - `acceptEdits`: edits inside the working folder also run silently.
 * - `plan`: read-only tools only; the model investigates and proposes a plan.
 * - `bypassPermissions`: nothing asks, except git init/add/commit/push (always security-scanned first).
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
/** Ollama's `think`: '' = model default, on/off = true/false, levels for models that support them (e.g. gpt-oss). */
export type ThinkSetting = '' | 'on' | 'off' | 'low' | 'medium' | 'high';

/** Settings chosen when a session starts, and changeable between turns. */
export interface SessionSettings {
  model: string;
  think?: ThinkSetting;
  /** Ollama `num_ctx`. Omitted = Ollama's default for the model. */
  numCtx?: number;
  permissionMode?: PermissionMode;
  /** Offer WebSearch / WebFetch (through the local SearXNG). */
  web?: boolean;
}

export interface StartOptions extends SessionSettings {
  cwd: string;
  /** Session ID to resume. */
  resume?: string;
}

/** Images per message, and the largest accepted image (base64 characters). */
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BASE64 = 16 * 1024 * 1024;

/**
 * One connection can run several sessions (GUI tabs). Session-scoped messages carry `key`,
 * a client-chosen tab ID (not the session ID).
 */
export type ClientMessage =
  | { type: 'start'; key: string; options: StartOptions }
  /** `images`: PNG / JPEG as plain base64 (Ollama rejects a `data:` prefix), for models with the `vision` capability. */
  | { type: 'user'; key: string; text: string; images?: string[] }
  /** New settings for a started session, used from the next message. */
  | { type: 'configure'; key: string; options: SessionSettings }
  | { type: 'permission'; key: string; requestId: string; allow: boolean; message?: string }
  | { type: 'interrupt'; key: string }
  | { type: 'stop'; key: string }
  /** Summarize the conversation now (the 「会話を要約」 button). */
  | { type: 'compact'; key: string }
  | { type: 'listSessions' }
  /** Installed and loaded models, and the Ollama connection state. */
  | { type: 'listModels' }
  /** Connection-wide: auto-approve permission prompts that can't affect the host (see server/autoApprove.ts). */
  | { type: 'setAutoApprove'; enabled: boolean };

/** Attached to permission prompts: whether they qualify for auto-approval, and whether it was applied. */
export interface ApprovalInfo {
  /** Qualifies for auto-approval (no host impact, and the security scan found nothing). */
  auto: boolean;
  reason: Text;
  /** The server already answered "allow" because auto-approval was on. */
  applied: boolean;
  /** Present for git init/add/commit/push: what would be recorded or published was scanned first. */
  security?: SecurityScan;
}

export interface SecurityFinding {
  /** Repository-relative path (or directory for "should be ignored" findings). */
  path: string;
  /** `high`: secrets/keys. `warn`: things that usually belong in .gitignore, big files, password-like values. */
  severity: 'high' | 'warn';
  rule: Text;
  /** Redacted excerpt or count, e.g. "AKIA…(20 characters)". Never the full secret. */
  detail?: Text;
  line?: number;
}

export interface SecurityScan {
  ops: ('init' | 'add' | 'commit' | 'push')[];
  /** Human-readable description of what was scanned. */
  scope: Text;
  checkedFiles: number;
  findings: SecurityFinding[];
  /** File or finding limits were hit, so the scan is incomplete. */
  truncated: boolean;
  error?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Token counts and speed of the last model call in a turn. */
export interface TurnStats {
  promptTokens: number;
  evalTokens: number;
  /** Generation speed (eval_count / eval_duration). */
  tokensPerSec?: number;
  /** Tokens the last request occupied in the context window (prompt + output). */
  contextUsed: number;
  /** Context window size, when known. */
  contextMax?: number;
}

/**
 * Progress of one session. Live events come in `event` messages; a resumed session's past turns are
 * replayed with the same shapes in a `history` message.
 */
export type AgentEvent =
  | { type: 'init'; sessionId: string; model: string; cwd: string; permissionMode: PermissionMode; think: ThinkSetting; numCtx?: number; web: boolean; tools: boolean }
  /** Streamed text / thinking of the assistant message being generated. */
  | { type: 'delta'; channel: 'text' | 'thinking'; text: string }
  /** The user's prompt (only replayed from history; the GUI shows live prompts itself). `images` as in `ClientMessage`. */
  | { type: 'user'; text: string; images?: string[] }
  /** The harness sent the model a message on its own (e.g. asking to retry a cut-off reply in smaller steps). */
  | { type: 'notice'; text: Text }
  /**
   * Older messages being replaced by a summary, automatically near the context limit or on request.
   * Token counts are estimates of the prompt size.
   */
  | { type: 'compact'; phase: 'start' | 'done' | 'failed'; auto: boolean; summary?: string; tokensBefore?: number; tokensAfter?: number; message?: Text }
  /** A finished assistant message. Replaces the streamed deltas. */
  | { type: 'assistant'; text: string; thinking?: string; toolCalls: ToolCall[] }
  | { type: 'toolResult'; id: string; output: string; isError: boolean }
  | { type: 'permission'; id: string; toolName: string; input: Record<string, unknown>; description?: string; approval: ApprovalInfo }
  /** A pending permission prompt was closed without the user's answer (interrupt / stop). */
  | { type: 'permissionCancelled'; id: string }
  | { type: 'result'; isError: boolean; subtype: 'success' | 'interrupted' | 'error' | 'max_turns'; message?: Text; durationMs: number; numTurns: number; stats?: TurnStats };

export interface ModelInfo {
  name: string;
  /** Bytes on disk. */
  size: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
  /** From `/api/show`: completion, tools, thinking, vision, ... */
  capabilities: string[];
  /** The model's maximum context length. */
  contextLength?: number;
  modifiedAt?: string;
}

/** A model currently in memory (`/api/ps`). */
export interface LoadedModel {
  name: string;
  size: number;
  sizeVram: number;
  contextLength?: number;
  expiresAt?: string;
}

export interface OllamaStatus {
  url: string;
  /** Present when Ollama answered. */
  version?: string;
  error?: Text;
}

/** A saved session (`<data dir>/sessions/<sessionId>.jsonl`). */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  /** Model used most recently. */
  model?: string;
  title?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  createdAt?: string;
  updatedAt: string;
  promptCount: number;
}

/** A working folder that has saved sessions, newest first. */
export interface FolderSummary {
  path: string;
  lastUsed: string;
  sessionCount: number;
  /** false when the folder was deleted or moved since. */
  exists: boolean;
}

export type ServerMessage =
  | { type: 'hello'; defaultCwd: string; dataDir: string }
  /** `searxng`: whether the local SearXNG behind WebSearch answers. */
  | { type: 'models'; ollama: OllamaStatus; models: ModelInfo[]; loaded: LoadedModel[]; searxng?: { url: string; ok: boolean } }
  | { type: 'event'; key: string; ev: AgentEvent }
  | { type: 'status'; key: string; running: boolean }
  | { type: 'sessions'; sessions: SessionSummary[]; folders: FolderSummary[] }
  /** Past transcript of a resumed session. */
  | { type: 'history'; key: string; sessionId: string; events: AgentEvent[]; omitted: number }
  /** `key` is absent for connection-level errors. */
  | { type: 'error'; key?: string; message: Text };
