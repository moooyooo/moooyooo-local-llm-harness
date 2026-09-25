import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { AgentEvent, PermissionMode } from '../shared/protocol.js';
import { AgentSession, CHECKPOINT_EVERY, MAX_OUTPUT_TOKENS, RESTORED_HEADER, thinkParam, type AgentDeps } from './agent.js';
import { CheckpointStore } from './checkpoints.js';
import { msg, TextError, textOf, type Text } from '../shared/i18n/index.js';
import { SUMMARY_HEADER, SUMMARY_PROMPT } from './compact.js';
import type { ChatFn, ChatRequest, ChatResult, OllamaMessage, OllamaToolCall } from './ollama.js';
import { checkpointsOf, SessionStore, toEvents, toMessages } from './store.js';
import { SHELL_TOOL } from './tools.js';

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

function session(
  chat: ChatFn,
  opts: {
    cwd: string;
    mode?: PermissionMode;
    auto?: boolean;
    store?: SessionStore;
    caps?: string[];
    numCtx?: number;
    /** Context window of the "loaded" model: a number, or a function for one that changes. */
    loadedCtx?: number | (() => number | undefined);
    unload?: AgentDeps['unload'];
    history?: OllamaMessage[];
    checkpoints?: AgentDeps['checkpoints'];
    resumeCheckpoints?: { commit: string; n: number }[];
  },
) {
  const events: AgentEvent[] = [];
  const loaded = opts.loadedCtx ?? 4096;
  const deps: AgentDeps = {
    chat,
    store: opts.store,
    autoApprove: () => !!opts.auto,
    contextLength: async () => (typeof loaded === 'function' ? loaded() : loaded),
    unload: opts.unload,
    checkpoints: opts.checkpoints,
  };
  const s = new AgentSession(
    {
      sessionId: SESSION,
      cwd: opts.cwd,
      model: 'test',
      think: '',
      numCtx: opts.numCtx,
      permissionMode: opts.mode ?? 'default',
      capabilities: opts.caps ?? ['completion', 'tools'],
      history: opts.history,
      checkpoints: opts.resumeCheckpoints,
    },
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

/** Server text as the Japanese GUI shows it. */
const ja = (t: Text) => textOf('ja', t);

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
  assert.ok(requests[0].tools?.some((t) => t.function.name === SHELL_TOOL));
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
  const { chat, requests } = scripted(reply('', [call('call_1', SHELL_TOOL, { command: 'touch x' })]), reply('ok'));
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
  const { chat } = scripted(reply('', [call('call_1', SHELL_TOOL, { command: 'mkdir sub' })]), reply('ok'));
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
    reply('', [call('call_1', 'Write', { file_path: 'a.txt', content: 'x' }), call('call_2', SHELL_TOOL, { command: 'ls' })]),
    reply('ok'),
  );
  const { s, events, answerWith } = session(chat, { cwd, mode: 'acceptEdits' });
  answerWith((sess, ev) => sess.respondPermission(ev.id, true));
  await s.sendUser('go');
  const perms = events.filter((e) => e.type === 'permission');
  assert.equal(perms.length, 1);
  assert.equal(perms[0].type === 'permission' && perms[0].toolName, SHELL_TOOL);
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
  const { chat } = scripted(reply('', [call('call_1', SHELL_TOOL, { command: 'git add -A && git commit -m x' })]), reply('ok'));
  const { s, events, answerWith } = session(chat, { cwd, mode: 'bypassPermissions' });
  answerWith((sess, ev) => sess.respondPermission(ev.id, false));
  await s.sendUser('commit');
  const perm = last(events, 'permission')!;
  assert.ok(perm.approval.security, 'security scan attached');
});

test('interrupt while waiting for permission cancels the prompt and closes the tool call', async () => {
  const cwd = tmp();
  const { chat, requests } = scripted(
    reply('', [call('call_1', SHELL_TOOL, { command: 'touch a' }), call('call_2', SHELL_TOOL, { command: 'touch b' })]),
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
  assert.match(ja(r.message ?? ''), /not found/);
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
  assert.match(ja(result.message ?? ''), /もう一度途中で切れた/);

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

/** A file whose Read result alone fills most of an 8K window (one token per Japanese character). */
function bigFile(cwd: string) {
  writeFileSync(path.join(cwd, 'big.txt'), Array.from({ length: 100 }, () => 'あ'.repeat(70)).join('\n'));
}

test('near the context limit, older messages are summarized before the next model call', async () => {
  const cwd = tmp();
  bigFile(cwd);
  const store = new SessionStore(tmp());
  const { chat, requests } = scripted(
    reply('', [call('call_1', 'Read', { file_path: 'big.txt' })]),
    reply('SUMMARY 1'),
    reply('SUMMARY TEXT'),
    reply('', [call('call_2', 'Edit', { file_path: 'big.txt', old_string: 'あ', new_string: 'い' })]),
    reply('done'),
  );
  const { s, events } = session(chat, { cwd, store, numCtx: 8192, loadedCtx: 8192 });
  await s.sendUser('big.txt を読んで直して');

  // Too big to summarize in one request: summarized in two pieces, the second carrying the first summary,
  // with the whole file across them. Same options, but no system prompt or tools.
  const [p1, p2] = [requests[1], requests[2]];
  for (const p of [p1, p2]) {
    assert.equal(p.messages.length, 1);
    assert.equal(p.tools, undefined);
    assert.equal(p.options?.num_ctx, 8192);
  }
  assert.match(p1.messages[0].content, /Part 1 of 2/);
  assert.match(p2.messages[0].content, /Summary of the earlier parts:\nSUMMARY 1/);
  const chars = (p1.messages[0].content + p2.messages[0].content).split('あ').length - 1;
  assert.ok(chars >= 7000, `the whole file is summarized (${chars})`);

  // The next call sees the summary, with the latest request word for word, instead of the old messages.
  const next = requests[3].messages;
  assert.equal(next.length, 2);
  assert.ok(next[1].content.startsWith(SUMMARY_HEADER));
  assert.match(next[1].content, /SUMMARY TEXT/);
  assert.match(next[1].content, /big\.txt を読んで直して/);

  const done = last(events, 'compact')!;
  assert.equal(done.phase, 'done');
  assert.equal(done.auto, true);
  assert.ok(done.tokensAfter! < done.tokensBefore!);
  // The model no longer sees the file, so editing needs a fresh Read.
  assert.match(events.filter((e) => e.type === 'toolResult').at(-1)!.output, /Read .* first/);
  assert.equal(last(events, 'result')!.subtype, 'success');

  // Resuming continues from the summary; the history still shows everything.
  const records = (await store.load(SESSION))!;
  assert.deepEqual(toMessages(records).map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.ok(toMessages(records)[0].content.startsWith(SUMMARY_HEADER));
  const types = toEvents(records).events.map((e) => e.type);
  assert.deepEqual(types, ['user', 'assistant', 'toolResult', 'compact', 'assistant', 'toolResult', 'assistant', 'result']);
});

test('if the summary fails, the turn goes on with the conversation unchanged', async () => {
  const cwd = tmp();
  bigFile(cwd);
  const { chat, requests } = scripted(reply('', [call('call_1', 'Read', { file_path: 'big.txt' })]), reply(''), reply('done'));
  const { s, events } = session(chat, { cwd, numCtx: 8192, loadedCtx: 8192 });
  await s.sendUser('read big.txt');
  assert.equal(last(events, 'compact')!.phase, 'failed');
  assert.deepEqual(requests[2].messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(last(events, 'result')!.subtype, 'success');
});

test('compacting on request summarizes all but the latest exchange', async () => {
  const turn = (i: number): OllamaMessage[] => [
    { role: 'user', content: `依頼${i} ${'あ'.repeat(400)}` },
    { role: 'assistant', content: `回答${i} ${'い'.repeat(400)}` },
  ];
  const history = [...turn(1), ...turn(2), ...turn(3)];
  const { chat, requests } = scripted(reply('SUMMARY'), reply('ok'));
  const { s, events } = session(chat, { cwd: tmp(), numCtx: 32768, loadedCtx: 32768, history });
  await s.compactNow();

  // It fits in one request shaped like the conversation (same tools), so Ollama can reuse its cache.
  assert.deepEqual(requests[0].messages.slice(1, -1), history.slice(0, 5), 'everything before the last reply is summarized');
  assert.deepEqual(requests[0].messages.at(-1), { role: 'user', content: SUMMARY_PROMPT });
  assert.ok(requests[0].tools?.length);
  assert.deepEqual(events.filter((e) => e.type === 'compact').map((e) => e.type === 'compact' && e.phase), ['start', 'done']);
  assert.equal(last(events, 'compact')!.auto, false);
  assert.equal(s.busy, false);

  await s.sendUser('次へ');
  const msgs = requests[1].messages;
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(msgs[1].content, /依頼3/, 'the summarized latest request is repeated');
  assert.equal(msgs[2].content, history[5].content);
});

test('compacting on request with nothing to summarize reports it', async () => {
  const { chat, requests } = scripted();
  const { s, events } = session(chat, { cwd: tmp() });
  await s.compactNow();
  assert.equal(requests.length, 0);
  const ev = last(events, 'compact')!;
  assert.equal(ev.phase, 'failed');
  assert.match(ja(ev.message ?? ''), /まだありません/);
});

test('images go to a vision model, and are replaced by a note for a model without vision', async () => {
  const png = 'iVBORw0KGgo' + 'AAAA';
  const { chat, requests } = scripted(reply('red'), reply('ok'));
  // A 4K window would be compacted right away: an image is estimated at 2,500 tokens.
  const { s } = session(chat, { cwd: tmp(), caps: ['completion', 'tools', 'vision'], loadedCtx: 32768 });
  await s.sendUser('何色？', [png]);
  assert.deepEqual(requests[0].messages[1], { role: 'user', content: '何色？', images: [png] });

  s.configure({ model: 'text-only', think: '', permissionMode: 'default', capabilities: ['completion', 'tools'] });
  await s.sendUser('続けて');
  const earlier = requests[1].messages[1];
  assert.equal(earlier.role === 'user' && earlier.images, undefined);
  assert.match(earlier.content, /1 image\(s\) were attached here, but this model cannot see images/);
});

test('settings changed between turns apply from the next message', async () => {
  const store = new SessionStore(tmp());
  let release!: () => void;
  const firstCall = new Promise<void>((r) => (release = r));
  const { chat: inner, requests } = scripted(reply('first'), reply('second'));
  const chat: ChatFn = async (req, signal, cb) => {
    if (requests.length === 0) await firstCall;
    return inner(req, signal, cb);
  };
  const { s, events } = session(chat, { cwd: tmp(), store });
  const next = { model: 'other', think: 'off' as const, numCtx: 16384, permissionMode: 'plan' as const, capabilities: ['completion', 'tools', 'thinking'] };

  const turn = s.sendUser('one');
  assert.equal(s.configure(next), false, 'not during a turn');
  release();
  await turn;
  assert.equal(s.configure(next), true);
  assert.equal(last(events, 'init')!.model, 'other');
  assert.match(ja(last(events, 'notice')!.text), /モデル test → other、思考 既定 → オフ、コンテキスト長 既定 → 16K、権限モード default → plan/);
  assert.equal(s.configure(next), true, 'no change');
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);

  await s.sendUser('two');
  const req = requests[1];
  assert.equal(req.model, 'other');
  assert.equal(req.think, false);
  assert.equal(req.options?.num_ctx, 16384);
  assert.deepEqual(req.tools?.map((t) => t.function.name).sort(), ['Glob', 'Grep', 'LS', 'Read']);
  assert.match(req.messages[0].content, /# Plan mode/);
  assert.deepEqual(req.messages.slice(1).map((m) => m.content), ['one', 'first', 'two'], 'the conversation goes on');

  // The session list shows the new model, and the history notes the change.
  const records = (await store.load(SESSION))!;
  assert.equal((await store.list())[0].model, 'other');
  const notices = toEvents(records).events.filter((e) => e.type === 'notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].type === 'notice' ? ja(notices[0].text) : '', /モデル test → other/);
});

test('a model loaded with a smaller window than num_ctx is freed so it loads again with ours, once', async () => {
  let loaded: number | undefined = 16384;
  const unloads: string[] = [];
  const { chat: inner } = scripted(reply('one'), reply('two'));
  // Ollama loads it again, but (say, short of memory) with less than asked for.
  const chat: ChatFn = async (req, signal, cb) => ((loaded = 32768), inner(req, signal, cb));
  const unload = async (model: string) => (unloads.push(model), (loaded = undefined), true);
  const { s, events } = session(chat, { cwd: tmp(), numCtx: 65536, loadedCtx: () => loaded, unload });

  await s.sendUser('first');
  assert.deepEqual(unloads, ['test']);
  assert.match(ja(last(events, 'notice')!.text), /test を 16K で読み込んでいたため、64K で読み込み直します/);
  assert.equal(last(events, 'result')!.stats?.contextMax, 32768, 'the meter shows the window actually in use');

  await s.sendUser('second');
  assert.equal(unloads.length, 1, 'not retried for the same settings');
});

test('if the model stays loaded (another request is running), the turn goes on and the next one tries again', async () => {
  const unloads: string[] = [];
  const { chat } = scripted(reply('one'), reply('two'));
  const unload = async (model: string) => (unloads.push(model), false);
  const { s, events } = session(chat, { cwd: tmp(), numCtx: 65536, loadedCtx: 16384, unload });
  await s.sendUser('first');
  assert.match(ja(last(events, 'notice')!.text), /今回は 16K のまま続けます/);
  assert.equal(last(events, 'result')!.subtype, 'success');
  await s.sendUser('second');
  assert.equal(unloads.length, 2);
});

test('web tools are offered, allowed and described only when web access is on', async () => {
  const { chat, requests } = scripted(reply('', [call('call_1', 'WebSearch', { query: 'ollama' })]), reply('off'), reply('on'));
  const { s, events } = session(chat, { cwd: tmp(), mode: 'bypassPermissions' });
  await s.sendUser('search');
  const names = (i: number) => requests[i].tools?.map((t) => t.function.name) ?? [];
  assert.ok(!names(0).includes('WebSearch') && !names(0).includes('WebFetch'));
  assert.match(last(events, 'toolResult')!.output, /Web access is turned off/, 'a call anyway is refused, even in bypass mode');
  assert.doesNotMatch(requests[0].messages[0].content, /# Web access/);

  assert.equal(s.configure({ model: 'test', think: '', permissionMode: 'bypassPermissions', web: true, capabilities: ['completion', 'tools'] }), true);
  assert.match(ja(last(events, 'notice')!.text), /Web 検索 オフ → オン/);
  assert.equal(last(events, 'init')!.web, true);
  await s.sendUser('again');
  assert.ok(names(2).includes('WebSearch') && names(2).includes('WebFetch'));
  assert.match(requests[2].messages[0].content, /# Web access[\s\S]*untrusted/);
});

test('a web query that carries a secret is refused before anything is sent or asked', async () => {
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  const { chat } = scripted(reply('', [call('call_1', 'WebSearch', { query: `why is ${key} rejected` })]), reply('ok'));
  const { s, events } = session(chat, { cwd: tmp() });
  s.configure({ model: 'test', think: '', permissionMode: 'default', web: true, capabilities: ['completion', 'tools'] });
  await s.sendUser('search');
  assert.ok(!events.some((e) => e.type === 'permission'), 'the user is not even asked');
  assert.match(last(events, 'toolResult')!.output, /contains a secret \(AWS アクセスキー\)/);
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

test('a checkpoint before each message lets the user roll the files back, and the model is told', async () => {
  const cwd = tmp();
  const data = tmp();
  writeFileSync(path.join(cwd, 'a.txt'), 'v1\n');
  const store = new SessionStore(data);
  const checkpoints = new CheckpointStore(data);
  const { chat, requests } = scripted(reply('', [call('c1', 'Write', { file_path: 'b.txt', content: 'new\n' })]), reply('done'), reply('ok'));
  const { s, events } = session(chat, { cwd, mode: 'acceptEdits', store, checkpoints });
  await s.sendUser('make b');
  const first = last(events, 'checkpoint')!;
  assert.deepEqual([first.n, first.reason, first.changed], [1, 'prompt', 0]);
  assert.equal(readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'new\n');

  await s.restoreCheckpoint(first.commit);
  assert.ok(!existsSync(path.join(cwd, 'b.txt')), 'the file made after the checkpoint is gone');
  const backup = last(events, 'checkpoint')!;
  assert.deepEqual([backup.n, backup.reason], [2, 'backup']);
  assert.equal(last(events, 'restore')!.phase, 'done');
  assert.match(ja(last(events, 'notice')!.text), /チェックポイント #1 に戻しました（1 ファイルを削除）/);

  await s.sendUser('next');
  const sent = requests.at(-1)!.messages.slice(-2);
  assert.ok(sent[0].role === 'user' && sent[0].content.startsWith(RESTORED_HEADER), 'the model hears about the restore');
  assert.deepEqual(sent[1], { role: 'user', content: 'next' });

  // Saved and replayed with the session, and still restorable after resuming.
  const records = (await store.load(SESSION))!;
  assert.deepEqual(toEvents(records).events.filter((e) => e.type === 'checkpoint').map((e) => e.type === 'checkpoint' && e.n), [1, 2, 3]);
  const resumed = session(scripted().chat, { cwd, store, checkpoints, resumeCheckpoints: checkpointsOf(records), history: toMessages(records) });
  assert.ok(resumed.s.hasCheckpoint(first.commit));
  await resumed.s.restoreCheckpoint(backup.commit);
  assert.equal(readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'new\n', 'undoing the restore brings the file back');
});

test('long turns get checkpoints along the way, but only when files changed', async () => {
  const cwd = tmp();
  const writes = Array.from({ length: CHECKPOINT_EVERY }, (_, i) => call(`w${i}`, 'Write', { file_path: `f${i}.txt`, content: `${i}` }));
  const { chat } = scripted(reply('', writes), reply('done'));
  const { s, events } = session(chat, { cwd, mode: 'acceptEdits', checkpoints: new CheckpointStore(tmp()) });
  await s.sendUser('write many');
  const cps = events.filter((e): e is Extract<AgentEvent, { type: 'checkpoint' }> => e.type === 'checkpoint');
  assert.deepEqual(cps.map((c) => [c.reason, c.changed]), [['prompt', 0], ['progress', CHECKPOINT_EVERY]]);
});

test('no checkpoints in plan mode, and a failing checkpoint does not stop the task', async () => {
  const cwd = tmp();
  const plan = session(scripted(reply('plan')).chat, { cwd, mode: 'plan', checkpoints: new CheckpointStore(tmp()) });
  await plan.s.sendUser('plan');
  assert.ok(!plan.events.some((e) => e.type === 'checkpoint'));

  let attempts = 0;
  const broken = { snapshot: async () => { attempts++; throw new TextError(msg('checkpoint.noGit')); } } as unknown as CheckpointStore;
  const { s, events } = session(scripted(reply('one'), reply('two')).chat, { cwd, checkpoints: broken });
  await s.sendUser('first');
  await s.sendUser('second');
  assert.equal(attempts, 1, 'a permanent failure turns checkpoints off for the session');
  assert.deepEqual(events.filter((e) => e.type === 'notice').map((e) => e.type === 'notice' && ja(e.text)), ['このフォルダではチェックポイントを記録しません: git が見つかりません']);
  assert.equal(last(events, 'result')!.subtype, 'success');
});
