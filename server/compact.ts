import type { OllamaMessage, OllamaTool } from './ollama.js';

/**
 * Context compaction: when the conversation nears the context window, older messages are replaced by a summary the
 * model writes. Ollama never refuses an oversized prompt; it silently drops the oldest part (including the user's
 * request), so the harness has to do this before that happens.
 */

/** Compact when the next request is estimated to fill this share of the context window. */
export const COMPACT_AT = 0.8;
/** After compacting, the conversation should take about this share, so the next compaction is far off. */
const TARGET_AFTER = 0.5;
/** Room reserved for the summary when deciding how much to keep. */
const SUMMARY_RESERVE = 2000;
/** A manual compaction keeps at most this share of the current conversation. */
const MANUAL_KEEP = 0.25;
/** Room for the summary so far and the instructions in each request of a piece-by-piece summary. */
export const PIECE_OVERHEAD = SUMMARY_RESERVE + 500;

const SUMMARY_FORMAT =
  'Write it in the language the user writes in, as concise Markdown with these sections:\n' +
  '1. Task: what the user asked for, and their constraints and preferences.\n' +
  '2. Remaining work: what is left to do, and the very next step.\n' +
  '3. Progress: what has been done (files created or changed with their paths, commands run and their results).\n' +
  '4. Key facts: decisions, errors and details needed to continue.\n' +
  'Keep it under about 500 words. Leave out file contents that can be read again. ' +
  'Do not guess: state only what the conversation shows, and say so when something is unknown.';

export const SUMMARY_PROMPT =
  'Your context window is nearly full, so the conversation so far will be replaced by a summary that you write now. ' +
  `Do not call any tools. ${SUMMARY_FORMAT}`;

/** Rough token count that errs high: about 3 ASCII characters per token, one token per other character (e.g. Japanese). */
export function estimateTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3) + (text.length - ascii);
}

export function messageTokens(m: OllamaMessage): number {
  let n = 4 + estimateTokens(m.content);
  if (m.role === 'assistant') {
    if (m.thinking) n += estimateTokens(m.thinking);
    if (m.tool_calls?.length) n += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return n;
}

export function messagesTokens(messages: OllamaMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

/** Estimated prompt size of a whole request. */
export function requestTokens(system: string, tools: OllamaTool[] | undefined, messages: OllamaMessage[]): number {
  return estimateTokens(system) + (tools ? estimateTokens(JSON.stringify(tools)) : 0) + messagesTokens(messages);
}

/**
 * How many recent tokens to keep verbatim. `overhead` is the system prompt and tool definitions.
 * A manual compaction also summarizes most of a conversation that is far from full.
 */
export function keepBudget(limit: number, overhead: number, current: number, manual: boolean): number {
  const budget = Math.max(0, limit * TARGET_AFTER - overhead - SUMMARY_RESERVE);
  return manual ? Math.min(budget, current * MANUAL_KEEP) : budget;
}

/**
 * Where to split `messages`: those before the returned index are summarized, the rest are kept as they are.
 * Keeps the newest messages that fit in `keepTokens`, and never starts the kept part with a tool result, which
 * must stay with the call that produced it. 0 means there is nothing to summarize.
 */
export function splitPoint(messages: OllamaMessage[], keepTokens: number): number {
  let cut = messages.length;
  let kept = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    kept += messageTokens(messages[i]);
    if (kept > keepTokens) break;
    cut = i;
  }
  while (cut < messages.length && messages[cut].role === 'tool') cut++;
  return cut;
}

/**
 * A conversation too long to summarize in one request, as plain-text pieces of at most `maxTokens` each.
 * Nothing is left out: a summary made from shortened tool results invents what was cut (seen with qwen3.8).
 */
export function transcriptPieces(messages: OllamaMessage[], maxTokens: number): string[] {
  const max = Math.max(maxTokens, 200);
  const pieces: string[] = [];
  let lines: string[] = [];
  let used = 0;
  for (const line of messages.flatMap(transcriptLines).flatMap((l) => splitLine(l, max))) {
    const t = estimateTokens(line) + 1;
    if (used + t > max && lines.length) {
      pieces.push(lines.join('\n'));
      lines = [];
      used = 0;
    }
    lines.push(line);
    used += t;
  }
  if (lines.length) pieces.push(lines.join('\n'));
  return pieces;
}

function transcriptLines(m: OllamaMessage): string[] {
  const text = (label: string, s: string) => (s ? `${label}: ${s}`.split('\n') : []);
  switch (m.role) {
    case 'assistant':
      return [
        ...text('ASSISTANT', m.content),
        ...(m.tool_calls ?? []).map((c) => `ASSISTANT called ${c.function.name} ${JSON.stringify(c.function.arguments)}`),
      ];
    case 'tool':
      return text(`RESULT of ${m.tool_name ?? 'tool'}`, m.content || '(empty)');
    default:
      return text(m.role.toUpperCase(), m.content);
  }
}

/** A line longer than the limit, cut into parts that fit. */
function splitLine(line: string, maxTokens: number): string[] {
  if (estimateTokens(line) <= maxTokens) return [line];
  const parts: string[] = [];
  let start = 0;
  let cost = 0;
  for (let i = 0; i < line.length; i++) {
    cost += line.charCodeAt(i) < 128 ? 1 / 3 : 1;
    if (cost >= maxTokens) {
      parts.push(line.slice(start, i + 1));
      start = i + 1;
      cost = 0;
    }
  }
  if (start < line.length) parts.push(line.slice(start));
  return parts;
}

/** One step of a piece-by-piece summary: the summary so far plus the next piece, asking for an updated summary. */
export function piecePrompt(summarySoFar: string, piece: string, index: number, count: number): string {
  return [
    'A long conversation between a user and a coding assistant is being summarized piece by piece, because it is too long to read at once. ' +
      'The summary will replace the conversation, so the assistant can continue the work from it.',
    summarySoFar && `Summary of the earlier parts:\n${summarySoFar}`,
    `Part ${index + 1} of ${count} of the conversation:\n${piece}`,
    `Write an updated summary that covers ${summarySoFar ? 'the earlier parts and ' : ''}this part. ${SUMMARY_FORMAT}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Starts the message that holds a summary. */
export const SUMMARY_HEADER = '[Summary of the earlier conversation]';

/** The messages that replace the summarized part. */
export function summaryMessages(summary: string, latestRequest: string | undefined, nextRole: OllamaMessage['role'] | undefined): OllamaMessage[] {
  const parts = [
    SUMMARY_HEADER,
    'The earlier part of this conversation was replaced by this summary to free up context. Continue from here. ' +
      'Files may have changed since: Read a file again before editing it.',
    summary,
  ];
  if (latestRequest) parts.push(`The user's latest request, word for word:\n${latestRequest}`);
  const out: OllamaMessage[] = [{ role: 'user', content: parts.join('\n\n') }];
  // Keep user and assistant turns alternating.
  if (nextRole === 'user') out.push({ role: 'assistant', content: 'Understood. I will continue from the summary.' });
  return out;
}

/** Thinking models run with `think: false` may still put their reasoning before a stray `</think>`. */
export function cleanSummary(text: string): string {
  const end = text.lastIndexOf('</think>');
  return (end >= 0 ? text.slice(end + '</think>'.length) : text).trim();
}
