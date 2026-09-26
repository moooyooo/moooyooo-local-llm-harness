import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanSummary,
  estimateTokens,
  IMAGE_TOKENS,
  keepBudget,
  messagesTokens,
  piecePrompt,
  splitPoint,
  SUMMARY_HEADER,
  SUMMARY_PROMPT,
  summaryMessages,
  transcriptPieces,
  trimToolOutputs,
  TRIMMED_PREFIX,
} from './compact.js';
import type { OllamaMessage } from './ollama.js';

const user = (content: string): OllamaMessage => ({ role: 'user', content });
const assistant = (content: string, call?: string): OllamaMessage => ({
  role: 'assistant',
  content,
  ...(call && { tool_calls: [{ id: call, function: { name: 'Read', arguments: { file_path: 'a.txt' } } }] }),
});
const tool = (content: string, id: string): OllamaMessage => ({ role: 'tool', content, tool_call_id: id, tool_name: 'Read' });

test('token estimate: about 3 ASCII characters per token, one per Japanese character, a fixed cost per image', () => {
  assert.equal(estimateTokens('abcdef'), 2);
  assert.equal(estimateTokens('あいう'), 3);
  assert.equal(estimateTokens(''), 0);
  assert.equal(messagesTokens([{ role: 'user', content: '', images: ['a', 'b'] }]) - messagesTokens([user('')]), 2 * IMAGE_TOKENS);
  assert.match(transcriptPieces([{ role: 'user', content: 'これ', images: ['a'] }], 100)[0], /^USER: これ \[1 image\(s\) attached\]/);
});

test('split keeps the newest messages that fit, and never starts the kept part with a tool result', () => {
  const msgs = [user('x'.repeat(300)), assistant('', 'c1'), tool('y'.repeat(300), 'c1'), assistant('z'.repeat(30))];
  const last = messagesTokens(msgs.slice(3));
  assert.equal(splitPoint(msgs, last), 3, 'keeps only the last message');
  // Enough room for the tool result but not its call: the tool result goes with the call into the summary.
  assert.equal(splitPoint(msgs, messagesTokens(msgs.slice(2))), 3);
  assert.equal(splitPoint(msgs, messagesTokens(msgs.slice(1))), 1);
  assert.equal(splitPoint(msgs, 0), msgs.length, 'a message bigger than the budget is summarized too');
  assert.equal(splitPoint(msgs, 1e9), 0, 'everything fits: nothing to summarize');
});

test('keep budget targets half the window, and a manual compaction also summarizes a short conversation', () => {
  assert.equal(keepBudget(32768, 2000, 20000, false), 32768 / 2 - 2000 - 2000);
  assert.equal(keepBudget(32768, 2000, 4000, true), 1000);
  assert.equal(keepBudget(4096, 3000, 20000, false), 0, 'never negative');
});

test('a conversation too long for one request is cut into pieces that fit, leaving nothing out', () => {
  const file = Array.from({ length: 300 }, (_, i) => `line ${i}: ${i === 150 ? 'SECRET HARBOR' : 'filler text here'}`).join('\n');
  const msgs = [user('read it'), assistant('', 'c1'), tool(file, 'c1'), assistant('Z'.repeat(5000))];
  const pieces = transcriptPieces(msgs, 1000);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(estimateTokens(p) <= 1000 + 10, 'each piece fits');
  const all = pieces.join('\n');
  assert.match(all, /^USER: read it/);
  assert.match(all, /ASSISTANT called Read \{"file_path":"a.txt"\}/);
  assert.match(all, /SECRET HARBOR/, 'the middle of a long tool result is kept');
  assert.equal(all.split('\n').filter((l) => l.includes('filler text here')).length, 299);
  assert.equal((all.match(/Z/g) ?? []).length, 5000, 'a line longer than a piece is split, not cut');
});

test('each step of a piece-by-piece summary carries the summary so far', () => {
  const first = piecePrompt('', 'USER: hi', 0, 2);
  assert.match(first, /Part 1 of 2 of the conversation:\nUSER: hi/);
  assert.doesNotMatch(first, /Summary of the earlier parts/);
  const second = piecePrompt('## Task\nbuild', 'ASSISTANT: ok', 1, 2);
  assert.match(second, /Summary of the earlier parts:\n## Task\nbuild/);
  assert.match(second, /Do not guess/);
  assert.match(SUMMARY_PROMPT, /Do not call any tools/);
});

test('summary messages repeat the latest request and keep turns alternating', () => {
  const [s] = summaryMessages('did things', 'build the app', 'assistant');
  assert.ok(s.content.startsWith(SUMMARY_HEADER));
  assert.match(s.content, /did things/);
  assert.match(s.content, /word for word:\nbuild the app/);
  assert.equal(summaryMessages('x', undefined, 'assistant').length, 1);
  assert.deepEqual(summaryMessages('x', undefined, 'user').map((m) => m.role), ['user', 'assistant']);
  assert.doesNotMatch(summaryMessages('x', undefined, undefined)[0].content, /word for word/);
});

test('stray reasoning before </think> is removed from a summary', () => {
  assert.equal(cleanSummary('thinking...\n</think>\n\n## Task'), '## Task');
  assert.equal(cleanSummary('  ## Task  '), '## Task');
});

test('long tool outputs before the kept part are replaced with a note keeping their first line', () => {
  const messages: OllamaMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'Read', arguments: { file_path: 'x' } } }] },
    { role: 'tool', content: `     1\tfirst line\n${'x'.repeat(3000)}`, tool_call_id: 'a', tool_name: 'Read' },
    { role: 'tool', content: 'short', tool_call_id: 'b', tool_name: 'Bash' },
    { role: 'tool', content: 'y'.repeat(3000), tool_call_id: 'c', tool_name: 'Bash' },
  ];
  const { messages: out, trimmed } = trimToolOutputs(messages, 4);
  assert.equal(trimmed, 1);
  assert.equal(out[2].content, `${TRIMMED_PREFIX}; run the Read call again if you still need it. It began: 1\tfirst line]`);
  assert.deepEqual(out.slice(3), messages.slice(3), 'short outputs and the kept part stay');
  assert.equal(trimToolOutputs(out, 4).trimmed, 0, 'a note is not trimmed again');
});
