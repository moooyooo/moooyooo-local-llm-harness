import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentEvent, PermissionMode } from '../shared/protocol.js';
import { AgentSession, MAX_OUTPUT_TOKENS, thinkParam, type AgentDeps } from './agent.js';
import type { ChatFn, ChatRequest, ChatResult, OllamaToolCall } from './ollama.js';
import { SessionStore, toEvents, toMessages } from './store.js';

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));
function tmp(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-agent-'));
  roots.push(root);
  return root;
}

const SESSION = '00000000-0000-4000-8000-000000000001';
const reply = (content: string, toolCalls: OllamaToolCall[] = []): ChatResult => ({
  content,
  thinking: '',
  toolCalls,
  doneReason: 'stop',
  promptEvalCount: 100,
  evalCount: 10,
  evalDuration: 1e9,
});
const call = (id: string, name: string, args: Record<string, unknown>): OllamaToolCall => ({ id, function: { name, arguments: args } });

/** A fake model that answers each request with the next scripted reply and records the requests. */
function scripted(...replies: ChatResult[]) {
  const requests: ChatRequest[] = [];
  const chat: ChatFn = async (req, signal, cb) => {
    requests.push(structuredClone(req));
    if (signal.aborted) throw new Error('aborted');
    const r = replies.shift();
    if (!r) throw new Error('no more scripted replies');
    if (r.content) cb.onContent?.(r.content);
    return r;
  };
  return { chat, requests };
}

function session(chat: ChatFn, opts: { cwd: string; mode?: PermissionMode; auto?: boolean; store?: SessionStore; caps?: string[] }) {
  const events: AgentEvent[] = [];
  const deps: AgentDeps = { chat, store: opts.store, autoApprove: () => !!opts.auto, contextLength: async () => 4096 };
  const s = new AgentSession(
    { sessionId: SESSION, cwd: opts.cwd, model: 'test', think: '', permissionMode: opts.mode ?? 'default', capabilities: opts.caps ?? ['completion', 'tools'] },
    deps,
  );
  s.on('event', (ev) => {
    events.push(ev);
    // Answer prompts through the public API, as the GUI would.
    if (ev.type === 'permission' && !ev.approval.applied) onPermission?.(s, ev);
  });
  let onPermission: ((s: AgentSession, ev: Extract<AgentEvent, { type: 'permission' }>) => void) | undefined;
  return { s, events, answerWith: (fn: typeof onPermission) => (onPermission = fn) };
}

const last = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type).at(-1);

test('plain answer: streams, commits the message and reports stats', async () => {
  const { chat, requests } = scripted(reply('こんにちは'));
  const { s, events } = session(chat, { cwd: tmp() });
  await s.sendUser('hi');
  assert.deepEqual(events.map((e) => e.type), ['delta', 'assistant', 'result']);
  const result = last(events, 'result')!;
  assert.equal(result.subtype, 'success');
  assert.equal(result.stats?.contextUsed, 110);
  assert.equal(result.stats?.contextMax, 4096, 'falls back to the loaded context length');
  assert.equal(result.stats?.tokensPerSec, 10);
  assert.equal(requests[0].messages[0].role, 'system');
  assert.deepEqual(requests[0].messages[1], { role: 'user', content: 'hi' });
  assert.ok(requests[0].tools?.some((t) => t.function.name === 'Bash'));
});

test('read inside the working folder runs without a prompt, and its result goes back to the model', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'a.txt'), 'hello\n');
  const { chat, requests } = scripted(reply('', [call('call_1', 'Read', { file_path: 'a.txt' })]), reply('done'));
  const { s, events } = session(chat, { cwd });
  await s.sendUser('read a.txt');
  assert.ok(!events.some((e) => e.type === 'permission'));
  const tr = last(events, 'toolResult')!;
  assert.equal(tr.id, 'call_1');
  assert.match(tr.output, /1\thello/);
  const toolMsg = requests[1].messages.at(-1)!;
  assert.equal(toolMsg.role, 'tool');
  assert.equal(toolMsg.role === 'tool' && toolMsg.tool_call_id, 'call_1');
});

test('write asks for permission; allowing runs it', async () => {
  const cwd = tmp();
  const { chat } = scripted(reply('', [call('call_1', 'Write', { file_path: 'new.txt', content: 'x' })]), reply('ok'));
  const { s, events, answerWith } = session(chat, { cwd });
  answerWith((sess, ev) => sess.respondPermission(ev.id, true));
  await s.sendUser('write');
  const perm = last(events, 'permission')!;
  assert.equal(perm.toolName, 'Write');
  assert.equal(perm.approval.auto, true, 'inside cwd qualifies for auto-approval');
  assert.equal(readFileSync(path.join(cwd, 'new.txt'), 'utf8'), 'x');
  assert.equal(last(events, 'result')!.subtype, 'success');
});

test('denying returns an error result to the model and does not run the tool', async () => {
  const cwd = tmp();
  const { chat, requests } = scripted(reply('', [call('call_1', 'Bash', { command: 'touch x' })]), reply('ok'));
  const { s, events, answerWith } = session(chat, { cwd });
  answerWith((sess, ev) => sess.respondPermission(ev.id, false));
  await s.sendUser('go');
  const tr = last(events, 'toolResult')!;
  assert.equal(tr.isError, true);
  assert.match(tr.output, /doesn't want to proceed/);
  assert.equal(requests.length, 2);
});

test('auto-approval answers qualifying prompts itself', async () => {
  const cwd = tmp();
  const { chat } = scripted(reply('', [call('call_1', 'Bash', { command: 'mkdir sub' })]), reply('ok'));
  const { s, events } = session(chat, { cwd, auto: true });
  await s.sendUser('go');
  const perm = last(events, 'permission')!;
  assert.equal(perm.approval.applied, true);
  assert.equal(last(events, 'toolResult')!.isError, false);
});

test('a call that would fail anyway is not shown to the user as a prompt', async () => {
  const cwd = tmp();
  writeFileSync(path.join(cwd, 'a.txt'), 'x\n');
  const { chat } = scripted(reply('', [call('call_1', 'Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' })]), reply('ok'));
  const { s, events } = session(chat, { cwd });
  await s.sendUser('edit without reading');
  assert.ok(!events.some((e) => e.type === 'permission'));
  assert.match(last(events, 'toolResult')!.output, /Read .* first/);
  assert.equal(readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'x\n');
});

test('acceptEdits writes inside the folder silently, but still asks for shell commands', async () => {
  const cwd = tmp();
  const { chat } = scripted(
    reply('', [call('call_1', 'Write', { file_path: 'a.txt', content: 'x' }), call('call_2', 'Bash', { command: 'ls' })]),
    reply('ok'),
  );
  const { s, events, answerWith } = session(chat, { cwd, mode: 'acceptEdits' });
  answerWith((sess, ev) => sess.respondPermission(ev.id, true));
  await s.sendUser('go');
  const perms = events.filter((e) => e.type === 'permission');
  assert.equal(perms.length, 1);
  assert.equal(perms[0].type === 'permission' && perms[0].toolName, 'Bash');
});

test('plan mode offers only read-only tools and refuses others', async () => {
  const cwd = tmp();
  const { chat, requests } = scripted(reply('', [call('call_1', 'Write', { file_path: 'a.txt', content: 'x' })]), reply('plan'));
  const { s, events } = session(chat, { cwd, mode: 'plan' });
  await s.sendUser('plan it');
  assert.deepEqual(requests[0].tools?.map((t) => t.function.name).sort(), ['Glob', 'Grep', 'LS', 'Read']);
  assert.match(last(events, 'toolResult')!.output, /Plan mode/);
  assert.ok(!events.some((e) => e.type === 'permission'));
});

test('bypass mode still asks before git commit', async () => {
  const cwd = tmp();
  const { chat } = scripted(reply('', [call('call_1', 'Bash', { command: 'git add -A && git commit -m x' })]), reply('ok'));
  const { s, events, answerWith } = session(chat, { cwd, mode: 'bypassPermissions' });
  answerWith((sess, ev) => sess.respondPermission(ev.id, false));
  await s.sendUser('commit');
  const perm = last(events, 'permission')!;
  assert.ok(perm.approval.security, 'security scan attached');
});

test('interrupt while waiting for permission cancels the prompt and closes the tool call', async () => {
  const cwd = tmp();
  const { chat, requests } = scripted(
    reply('', [call('call_1', 'Bash', { command: 'touch a' }), call('call_2', 'Bash', { command: 'touch b' })]),
    reply('after'),
  );
  const { s, events, answerWith } = session(chat, { cwd });
  answerWith((sess) => setImmediate(() => sess.interrupt()));
  await s.sendUser('go');
  assert.equal(last(events, 'result')!.subtype, 'interrupted');
  assert.ok(events.some((e) => e.type === 'permissionCancelled'));
  const results = events.filter((e) => e.type === 'toolResult');
  assert.equal(results.length, 2, 'every call gets a result');

  // The conversation stays valid: the next message continues after the two tool results.
  await s.sendUser('next');
  const msgs = requests.at(-1)!.messages;
  assert.deepEqual(msgs.slice(-4).map((m) => m.role), ['assistant', 'tool', 'tool', 'user']);
});

test('the same call repeated in a row is refused after a few times', async () => {
  const cwd = tmp();
  const again = () => reply('', [call('c', 'LS', {})]);
  const { chat } = scripted(again(), again(), again(), again(), reply('stop'));
  const { s, events } = session(chat, { cwd });
  await s.sendUser('loop');
  const results = events.filter((e): e is Extract<AgentEvent, { type: 'toolResult' }> => e.type === 'toolResult');
  assert.equal(results.length, 4);
  assert.match(results[3].output, /already made this exact call/);
});

test('model errors end the turn with an error result', async () => {
  const chat: ChatFn = async () => {
    throw new Error('model "x" not found');
  };
  const { s, events } = session(chat, { cwd: tmp() });
  await s.sendUser('hi');
  const r = last(events, 'result')!;
  assert.equal(r.subtype, 'error');
  assert.match(r.message ?? '', /not found/);
});

test('a failed model call keeps what was streamed before the failure', async () => {
  const store = new SessionStore(tmp());
  const chat: ChatFn = async (_req, _signal, cb) => {
    cb.onThinking?.('ファイルを書く準備');
    throw new Error('terminated');
  };
  const { s, events } = session(chat, { cwd: tmp(), store });
  await s.sendUser('go');
  assert.deepEqual(events.map((e) => e.type), ['delta', 'assistant', 'result']);
  assert.equal(last(events, 'assistant')!.thinking, 'ファイルを書く準備');
  assert.equal(last(events, 'result')!.subtype, 'error');
  const saved = toMessages((await store.load(SESSION))!);
  assert.deepEqual(saved.at(-1), { role: 'assistant', content: '', thinking: 'ファイルを書く準備' });
});

test('a reply cut off at the output limit is retried once with a request for smaller steps', async () => {
  const store = new SessionStore(tmp());
  const cut = (): ChatResult => ({ ...reply(''), doneReason: 'length', evalCount: MAX_OUTPUT_TOKENS });
  const { chat, requests } = scripted(cut(), cut());
  const { s, events } = session(chat, { cwd: tmp(), store });
  await s.sendUser('build the whole app');

  assert.equal(requests.length, 2);
  assert.equal(requests[0].options?.num_predict, MAX_OUTPUT_TOKENS);
  const note = requests[1].messages.at(-1)!;
  assert.equal(note.role, 'user');
  assert.match(note.content, /cut off/);
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);
  const result = last(events, 'result')!;
  assert.equal(result.subtype, 'success');
  assert.match(result.message ?? '', /もう一度途中で切れた/);

  // History shows the notice instead of the note, and the note doesn't count as a prompt.
  const records = (await store.load(SESSION))!;
  assert.deepEqual(toEvents(records).events.map((e) => e.type), ['user', 'assistant', 'notice', 'assistant', 'result']);
  assert.equal((await store.list())[0].promptCount, 1);
});

test('a cut-off reply that still holds a whole tool call runs it instead of retrying', async () => {
  const cwd = tmp();
  const { chat, requests } = scripted({ ...reply('', [call('call_1', 'LS', {})]), doneReason: 'length' }, reply('done'));
  const { s, events } = session(chat, { cwd });
  await s.sendUser('go');
  assert.ok(!events.some((e) => e.type === 'notice'));
  assert.deepEqual(requests[1].messages.slice(-2).map((m) => m.role), ['assistant', 'tool']);
  assert.equal(last(events, 'result')!.message, undefined);
});

test('without the tools capability no tools are sent', async () => {
  const { chat, requests } = scripted(reply('hello'));
  const { s } = session(chat, { cwd: tmp(), caps: ['completion'] });
  await s.sendUser('hi');
  assert.equal(requests[0].tools, undefined);
});

test('sessions are saved and can be resumed', async () => {
  const cwd = tmp();
  const store = new SessionStore(tmp());
  writeFileSync(path.join(cwd, 'a.txt'), 'hello\n');
  const { chat } = scripted(reply('', [call('call_1', 'Read', { file_path: 'a.txt' })]), reply('it says hello'));
  const { s } = session(chat, { cwd, store });
  await s.sendUser('what is in a.txt?');

  const records = await store.load(SESSION);
  assert.ok(records);
  assert.deepEqual(toMessages(records).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  const { events } = toEvents(records);
  assert.deepEqual(events.map((e) => e.type), ['user', 'assistant', 'toolResult', 'assistant', 'result']);

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].firstPrompt, 'what is in a.txt?');
  assert.equal(list[0].cwd, cwd);
  assert.equal(list[0].model, 'test');
});

test('think is only sent to thinking models', () => {
  assert.equal(thinkParam('on', ['completion']), undefined);
  assert.equal(thinkParam('on', ['thinking']), true);
  assert.equal(thinkParam('off', ['thinking']), false);
  assert.equal(thinkParam('high', ['thinking']), 'high');
  assert.equal(thinkParam('', ['thinking']), undefined);
});
