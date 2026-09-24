import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentEvent, PermissionMode, ThinkSetting, ToolCall, TurnStats } from '../shared/protocol.js';
import {
  cleanSummary,
  COMPACT_AT,
  keepBudget,
  messagesTokens,
  PIECE_OVERHEAD,
  piecePrompt,
  requestTokens,
  splitPoint,
  SUMMARY_HEADER,
  SUMMARY_PROMPT,
  summaryMessages,
  transcriptPieces,
} from './compact.js';
import type { ChatFn, ChatRequest, ChatResult, OllamaMessage, OllamaTool } from './ollama.js';
import { describeError } from './ollama.js';
import { assess, gate } from './permissions.js';
import type { SessionRecord, SessionStore } from './store.js';
import { describeSettingsChange, parseArguments, toToolCalls } from './store.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { runTool, toolSchemas, validateTool } from './tools.js';

/** Model calls per user message before the turn is stopped. */
export const MAX_TURNS = 100;
/** The same tool call (name + arguments) this many times in a row is refused, to break local-model loops. */
const MAX_REPEATS = 3;
/**
 * Ollama `num_predict` per model call. Generous for thinking plus a normal reply; it stops a runaway output
 * (e.g. a whole app in one Write), which Ollama would otherwise stream nothing of for many minutes.
 */
export const MAX_OUTPUT_TOKENS = 16_384;

const DENIED =
  "The user doesn't want to proceed with this tool call, so it was not run. " +
  'Stop what you are doing and wait for the user to tell you how to proceed.';
const CUT_OFF =
  `Your last reply was cut off at the output limit (${MAX_OUTPUT_TOKENS} tokens), so no tool call from it was run. ` +
  'Continue the task in smaller steps: keep each Write or Edit to about 200 lines, and split large files into several files or several Edits.';

export interface AgentConfig {
  sessionId: string;
  cwd: string;
  model: string;
  think: ThinkSetting;
  numCtx?: number;
  permissionMode: PermissionMode;
  /** From `/api/show`; decides whether tools and `think` are sent. */
  capabilities: string[];
  /** Conversation to continue when resuming. */
  history?: OllamaMessage[];
}

export interface AgentDeps {
  chat: ChatFn;
  store?: SessionStore;
  /** Connection-wide auto-approval setting, read at each prompt. */
  autoApprove: () => boolean;
  /** Context window of the loaded model, used when `numCtx` isn't set. */
  contextLength?: (model: string) => Promise<number | undefined>;
  /** Overrides the classifier + security scan (tests). */
  assess?: typeof assess;
}

class Interrupted extends Error {}

/**
 * One conversation with a local model: sends the user's message, runs the tools the model calls
 * (asking the user where the permission mode requires it) and feeds the results back until the model answers.
 * Progress is reported as `event`s; everything sent to the model is saved to the session file.
 */
export class AgentSession extends EventEmitter<{ event: [AgentEvent] }> {
  readonly config: AgentConfig;
  private readonly deps: AgentDeps;
  private readonly messages: OllamaMessage[];
  /** Rebuilt only when the settings change, so Ollama can keep reusing its KV cache. */
  private systemPrompt: string;
  private tools: boolean;
  private readonly readFiles = new Set<string>();
  private readonly pending = new Map<string, (answer: { allow: boolean; message?: string }) => void>();
  private abort?: AbortController;
  private metaWritten = false;
  private lastCall = { sig: '', count: 0 };
  /** Prompt tokens Ollama reported for the last call, and how many messages that prompt had. */
  private baseline?: { tokens: number; messages: number };
  /** The user's latest prompt, repeated word for word in a summary that replaces it. */
  private lastPrompt?: string;

  constructor(config: AgentConfig, deps: AgentDeps) {
    super();
    this.config = config;
    this.deps = deps;
    this.messages = closeDanglingToolCalls(config.history ?? []);
    this.lastPrompt = this.messages.findLast((m) => m.role === 'user' && !isHarnessMessage(m.content))?.content;
    this.tools = config.capabilities.includes('tools');
    // Built once: a stable prompt prefix lets Ollama reuse its KV cache between calls.
    this.systemPrompt = buildSystemPrompt({ cwd: config.cwd, permissionMode: config.permissionMode, tools: this.tools });
  }

  get busy(): boolean {
    return !!this.abort;
  }

  /** Reports the session settings. Call after attaching listeners. */
  init() {
    const { sessionId, model, cwd, permissionMode, think, numCtx } = this.config;
    this.send({ type: 'init', sessionId, model, cwd, permissionMode, think, numCtx, tools: this.tools });
  }

  /** `images`: base64 PNG / JPEG, for models with the `vision` capability. */
  async sendUser(text: string, images?: string[]): Promise<void> {
    if (this.abort) return;
    const ctrl = new AbortController();
    this.abort = ctrl;
    const started = Date.now();
    let turns = 0;
    let stats: TurnStats | undefined;
    let result: Extract<AgentEvent, { type: 'result' }>;
    let cutOffRetried = false;
    this.lastCall = { sig: '', count: 0 };
    this.lastPrompt = text;
    this.push({ role: 'user', content: text, ...(images?.length && { images }) });

    try {
      for (;;) {
        if (turns >= MAX_TURNS) {
          result = this.result('max_turns', started, turns, stats, `ツール呼び出しが ${MAX_TURNS} 回に達したため停止しました`);
          break;
        }
        turns++;
        await this.compactIfFull(ctrl.signal);
        const sent = this.messages.length;
        const res = await this.callModel(ctrl.signal);
        // Ollama counts the whole prompt, cached part included. The reply is estimated from what is kept of it:
        // a cut-off tool call is dropped, and templates may leave out thinking.
        if (res.promptEvalCount > 0) this.baseline = { tokens: res.promptEvalCount, messages: sent };
        stats = {
          promptTokens: res.promptEvalCount,
          evalTokens: res.evalCount,
          tokensPerSec: res.evalDuration > 0 ? res.evalCount / (res.evalDuration / 1e9) : undefined,
          contextUsed: res.promptEvalCount + res.evalCount,
          contextMax: this.config.numCtx,
        };
        const calls: ToolCall[] = res.toolCalls.map((c) => ({
          id: c.id || `call_${randomUUID().slice(0, 8)}`,
          name: c.function.name,
          input: parseArguments(c.function.arguments),
        }));
        this.push({
          role: 'assistant',
          content: res.content,
          ...(res.thinking && { thinking: res.thinking }),
          ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: c.input } })) }),
        });
        this.send({ type: 'assistant', text: res.content, thinking: res.thinking || undefined, toolCalls: calls });

        if (!calls.length) {
          const cutOff = res.doneReason === 'length';
          // Ollama drops a tool call cut off midway, so ask once for smaller steps instead of stopping.
          if (cutOff && !cutOffRetried) {
            cutOffRetried = true;
            this.push({ role: 'user', content: CUT_OFF }, { notice: '出力が長すぎて途中で切れたため、小さく分けて続けるよう自動で依頼しました' });
            continue;
          }
          result = this.result('success', started, turns, stats, cutOff ? '出力が長すぎて、もう一度途中で切れたため停止しました' : undefined);
          break;
        }
        cutOffRetried = false;
        await this.runCalls(calls, ctrl.signal);
      }
    } catch (err) {
      result = ctrl.signal.aborted
        ? this.result('interrupted', started, turns, stats)
        : this.result('error', started, turns, stats, describeError(err));
    } finally {
      this.abort = undefined;
    }
    if (result.stats && !result.stats.contextMax) {
      result.stats.contextMax = await this.deps.contextLength?.(this.config.model).catch(() => undefined);
    }
    this.persist({ type: 'result', result, timestamp: new Date().toISOString() });
    this.send(result);
  }

  respondPermission(id: string, allow: boolean, message?: string) {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve({ allow, message });
  }

  interrupt() {
    this.abort?.abort();
  }

  /** Ends the session: interrupts the running turn and stops reporting events. */
  stop() {
    this.removeAllListeners();
    this.abort?.abort();
  }

  /** Summarizes the conversation on the user's request, between turns. */
  async compactNow(): Promise<void> {
    if (this.abort) return;
    const ctrl = new AbortController();
    this.abort = ctrl;
    try {
      await this.compact(false, ctrl.signal, await this.contextLimit());
    } catch (err) {
      this.send({ type: 'compact', phase: 'failed', auto: false, message: ctrl.signal.aborted ? '中断しました' : describeError(err) });
    } finally {
      this.abort = undefined;
    }
  }

  /**
   * Applies new settings from the next model call (not during a turn). A model or context change makes Ollama
   * reload the model; any change rebuilds the system prompt.
   */
  configure(next: Pick<AgentConfig, 'model' | 'think' | 'numCtx' | 'permissionMode' | 'capabilities'>): boolean {
    if (this.abort) return false;
    const change = describeSettingsChange({ ...this.config, numCtx: this.config.numCtx ?? 0 }, { ...next, numCtx: next.numCtx ?? 0 });
    if (!change) return true;
    Object.assign(this.config, next);
    this.tools = next.capabilities.includes('tools');
    this.systemPrompt = buildSystemPrompt({ cwd: this.config.cwd, permissionMode: next.permissionMode, tools: this.tools });
    this.baseline = undefined;
    if (this.metaWritten) this.writeMeta();
    this.init();
    this.send({ type: 'notice', text: change });
    return true;
  }

  // -------------------------------------------------------------------------------------------

  /** Everything but the messages is the same in every request, so Ollama can reuse its cache (summaries included). */
  private request(messages: OllamaMessage[]): ChatRequest {
    const { model, numCtx } = this.config;
    // Ollama rejects images for a model without vision (e.g. after switching models), so leave a note instead.
    if (!this.config.capabilities.includes('vision')) messages = messages.map(withoutImages);
    const req: ChatRequest = {
      model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...messages],
      ...(this.tools && { tools: this.toolDefs() }),
      options: { ...(numCtx && { num_ctx: numCtx }), num_predict: MAX_OUTPUT_TOKENS },
    };
    const think = thinkParam(this.config.think, this.config.capabilities);
    if (think !== undefined) req.think = think;
    return req;
  }

  private toolDefs(): OllamaTool[] | undefined {
    return this.tools ? toolSchemas(this.config.permissionMode === 'plan') : undefined;
  }

  /**
   * The context window to plan for: the smaller of the requested `num_ctx` and the loaded model's
   * (Ollama keeps using a model loaded with a larger window).
   */
  private async contextLimit(): Promise<number | undefined> {
    const loaded = await this.deps.contextLength?.(this.config.model).catch(() => undefined);
    const limits = [this.config.numCtx, loaded].filter((n): n is number => !!n && n > 0);
    return limits.length ? Math.min(...limits) : undefined;
  }

  /** Estimated prompt tokens of the next request: Ollama's count for the last call plus what was added since. */
  private promptEstimate(): number {
    const b = this.baseline;
    if (b && b.messages <= this.messages.length) return b.tokens + messagesTokens(this.messages.slice(b.messages));
    return requestTokens(this.systemPrompt, this.toolDefs(), this.messages);
  }

  private async compactIfFull(signal: AbortSignal) {
    const limit = await this.contextLimit();
    if (limit && this.promptEstimate() >= limit * COMPACT_AT) await this.compact(true, signal, limit);
  }

  /**
   * Replaces the older messages with a summary the model writes, keeping the newest ones as they are.
   * If the summary fails, that is reported and the conversation stays as it was; an interrupt is thrown.
   */
  private async compact(auto: boolean, signal: AbortSignal, limit: number | undefined) {
    const before = this.promptEstimate();
    const overhead = requestTokens(this.systemPrompt, this.toolDefs(), []);
    const cut = splitPoint(this.messages, keepBudget(limit ?? Infinity, overhead, messagesTokens(this.messages), !auto));
    if (cut === 0) {
      if (!auto) this.send({ type: 'compact', phase: 'failed', auto, message: '要約できるほどの会話がまだありません' });
      return;
    }
    this.send({ type: 'compact', phase: 'start', auto });
    const toSummarize = this.messages.slice(0, cut);
    const kept = this.messages.slice(cut);
    let summary = '';
    try {
      // Leave the rest of the window for the summary (and any thinking before it).
      const window = (limit ?? Infinity) * COMPACT_AT;
      if (messagesTokens(toSummarize) <= window - overhead) {
        // Shaped like the real requests, so Ollama reuses the cached conversation.
        summary = await this.summarize(this.request([...toSummarize, { role: 'user', content: SUMMARY_PROMPT }]), signal);
      } else {
        const pieces = transcriptPieces(toSummarize, window - PIECE_OVERHEAD);
        for (const [i, piece] of pieces.entries()) {
          // A plain text task without the system prompt or tools, which leaves more room for the piece.
          const messages: OllamaMessage[] = [{ role: 'user', content: piecePrompt(summary, piece, i, pieces.length) }];
          summary = await this.summarize({ ...this.request([]), messages, tools: undefined }, signal);
        }
      }
    } catch (err) {
      if (signal.aborted) throw new Interrupted();
      this.send({ type: 'compact', phase: 'failed', auto, message: describeError(err) });
      return;
    }

    const promptKept = kept.some((m) => m.role === 'user' && m.content === this.lastPrompt);
    this.messages.splice(0, this.messages.length, ...summaryMessages(summary, promptKept ? undefined : this.lastPrompt, kept[0]?.role), ...kept);
    // The model no longer sees what it read, so Edit and overwriting need a fresh Read again.
    this.readFiles.clear();
    this.baseline = undefined;
    const after = this.promptEstimate();
    this.persist({ type: 'compact', messages: [...this.messages], summary, auto, tokensBefore: before, tokensAfter: after, timestamp: new Date().toISOString() });
    this.send({ type: 'compact', phase: 'done', auto, summary, tokensBefore: before, tokensAfter: after });
  }

  private async summarize(req: ChatRequest, signal: AbortSignal): Promise<string> {
    const summary = cleanSummary((await this.deps.chat(req, signal, {})).content);
    if (!summary) throw new Error('モデルが要約を返しませんでした');
    return summary;
  }

  private async callModel(signal: AbortSignal): Promise<ChatResult> {
    const req = this.request(this.messages);
    const partial = { text: '', thinking: '' };
    try {
      return await this.deps.chat(req, signal, {
        onContent: (text) => {
          partial.text += text;
          this.send({ type: 'delta', channel: 'text', text });
        },
        onThinking: (text) => {
          partial.thinking += text;
          this.send({ type: 'delta', channel: 'thinking', text });
        },
      });
    } catch (err) {
      // Keep what was generated before an interrupt or a failure, so the conversation reads as it happened
      // and continuing can build on it.
      if (partial.text || partial.thinking) {
        this.push({ role: 'assistant', content: partial.text, ...(partial.thinking && { thinking: partial.thinking }) });
        this.send({ type: 'assistant', text: partial.text, thinking: partial.thinking || undefined, toolCalls: [] });
      }
      throw err;
    }
  }

  /** Runs the calls in order. Every call gets a tool message, even when interrupted, so the conversation stays valid. */
  private async runCalls(calls: ToolCall[], signal: AbortSignal) {
    for (const call of calls) {
      let r: { output: string; isError: boolean };
      if (signal.aborted) {
        r = { output: 'Cancelled: the user interrupted before this tool ran.', isError: true };
      } else {
        try {
          r = await this.runCall(call, signal);
        } catch (err) {
          if (!signal.aborted) throw err;
          r = { output: 'Interrupted by the user.', isError: true };
        }
      }
      this.push({ role: 'tool', content: r.output, tool_call_id: call.id, tool_name: call.name }, { isError: r.isError });
      this.send({ type: 'toolResult', id: call.id, output: r.output, isError: r.isError });
    }
    if (signal.aborted) throw new Interrupted();
  }

  private async runCall(call: ToolCall, signal: AbortSignal): Promise<{ output: string; isError: boolean }> {
    const sig = `${call.name}\0${JSON.stringify(call.input)}`;
    this.lastCall = sig === this.lastCall.sig ? { sig, count: this.lastCall.count + 1 } : { sig, count: 1 };
    if (this.lastCall.count > MAX_REPEATS) {
      return {
        output: `You already made this exact call ${MAX_REPEATS} times in a row. Do not repeat it. Change your approach, or stop and tell the user what is blocking you.`,
        isError: true,
      };
    }

    const { cwd, permissionMode } = this.config;
    const ctx = { cwd, signal, readFiles: this.readFiles };
    const g = gate(permissionMode, call.name, call.input, cwd);
    if (g.kind === 'deny') return { output: g.message, isError: true };
    // Don't ask the user about a call that would fail anyway (e.g. Edit before Read).
    const invalid = await validateTool(call.name, call.input, ctx);
    if (invalid) return { output: invalid, isError: true };
    if (g.kind === 'ask') {
      const info = await (this.deps.assess ?? assess)(call.name, call.input, cwd);
      if (signal.aborted) throw new Interrupted();
      const applied = info.auto && this.deps.autoApprove();
      const id = `perm_${randomUUID()}`;
      const description = typeof call.input.description === 'string' ? call.input.description : undefined;
      // Register before announcing, so an answer that comes back synchronously isn't lost.
      const answer = applied ? undefined : this.waitForAnswer(id, signal);
      this.send({ type: 'permission', id, toolName: call.name, input: call.input, description, approval: { ...info, applied } });
      if (answer) {
        const { allow, message } = await answer;
        if (!allow) return { output: message || DENIED, isError: true };
      }
    }
    return runTool(call.name, call.input, ctx);
  }

  private waitForAnswer(id: string, signal: AbortSignal): Promise<{ allow: boolean; message?: string }> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.send({ type: 'permissionCancelled', id });
        reject(new Interrupted());
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, (answer) => {
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      });
    });
  }

  private result(
    subtype: Extract<AgentEvent, { type: 'result' }>['subtype'],
    started: number,
    numTurns: number,
    stats: TurnStats | undefined,
    message?: string,
  ): Extract<AgentEvent, { type: 'result' }> {
    const isError = subtype === 'error' || subtype === 'max_turns';
    return { type: 'result', isError, subtype, message, durationMs: Date.now() - started, numTurns, stats };
  }

  /** `notice`: the harness wrote this message itself; the GUI shows the notice instead of the message. */
  private push(message: OllamaMessage, opts: { isError?: boolean; notice?: string } = {}) {
    const { isError, notice } = opts;
    this.messages.push(message);
    this.persist({ type: 'message', message, ...(isError && { isError }), ...(notice && { notice }), timestamp: new Date().toISOString() });
    if (notice) this.send({ type: 'notice', text: notice });
  }

  private persist(record: SessionRecord) {
    const { store } = this.deps;
    if (!store) return;
    if (!this.metaWritten) this.writeMeta();
    store.append(this.config.sessionId, record);
  }

  /** Records the settings: before the session's first record, and again whenever they change. */
  private writeMeta() {
    const { store } = this.deps;
    if (!store) return;
    this.metaWritten = true;
    const { sessionId, cwd, model, think, numCtx, permissionMode } = this.config;
    store.append(sessionId, { type: 'meta', sessionId, cwd, model, think, numCtx: numCtx ?? 0, permissionMode, timestamp: new Date().toISOString() });
  }

  private send(ev: AgentEvent) {
    this.emit('event', ev);
  }
}

/** Ollama rejects `think: true` for models without the thinking capability, so only send it to those that have it. */
export function thinkParam(setting: ThinkSetting, capabilities: string[]): ChatRequest['think'] {
  if (!capabilities.includes('thinking')) return undefined;
  switch (setting) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'low':
    case 'medium':
    case 'high':
      return setting;
    default:
      return undefined;
  }
}

function withoutImages(m: OllamaMessage): OllamaMessage {
  if (m.role !== 'user' || !m.images?.length) return m;
  const { images, ...rest } = m;
  return { ...rest, content: `${m.content}\n\n(${images.length} image(s) were attached here, but this model cannot see images.)` };
}

/** Messages the harness wrote to the model in the user role, as opposed to the user's own prompts. */
function isHarnessMessage(content: string): boolean {
  return content === CUT_OFF || content.startsWith(SUMMARY_HEADER);
}

/**
 * A session saved mid-tool (server stopped) ends with tool calls that have no results. Models expect a result
 * for every call, so add placeholders.
 */
function closeDanglingToolCalls(history: OllamaMessage[]): OllamaMessage[] {
  const out = [...history];
  let i = out.length - 1;
  while (i >= 0 && out[i].role === 'tool') i--;
  const last = out[i];
  if (last?.role !== 'assistant' || !last.tool_calls?.length) return out;
  const answered = new Set(out.slice(i + 1).map((m) => (m.role === 'tool' ? m.tool_call_id : undefined)));
  for (const c of toToolCalls(last.tool_calls)) {
    if (!answered.has(c.id)) out.push({ role: 'tool', content: 'Cancelled: the session ended before this tool ran.', tool_call_id: c.id, tool_name: c.name });
  }
  return out;
}
