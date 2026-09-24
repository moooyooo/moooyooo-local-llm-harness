import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import type { ChatRequest } from './ollama.js';

// A fake Ollama. OLLAMA_HOST is read when ollama.ts loads, so import it after the server is listening.
let handler: http.RequestListener = (_req, res) => res.end();
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_HOST = `127.0.0.1:${(server.address() as AddressInfo).port}`;
const { chat, describeError } = await import('./ollama.js');
after(() => {
  server.closeAllConnections();
  server.close();
});

const req: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const ndjson = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l) + '\n').join('');

async function readBody(req: http.IncomingMessage): Promise<string> {
  let s = '';
  for await (const part of req) s += part;
  return s;
}

test('chat streams thinking and text, and collects tool calls and stats', async () => {
  let body: Record<string, unknown> = {};
  handler = async (req, res) => {
    body = JSON.parse(await readBody(req));
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const all = Buffer.from(
      ndjson(
        { message: { role: 'assistant', content: '', thinking: '考え' } },
        { message: { role: 'assistant', content: 'こんにちは' } },
        { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', function: { index: 0, name: 'LS', arguments: {} } }] } },
        { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 5, eval_duration: 1e9 },
      ),
    );
    // Split inside a multi-byte character, in separate writes.
    const cut = all.indexOf(Buffer.from('こ')) + 1;
    res.write(all.subarray(0, cut));
    setTimeout(() => res.end(all.subarray(cut)), 20);
  };
  const seen = { text: '', thinking: '' };
  const r = await chat(req, new AbortController().signal, {
    onContent: (t) => (seen.text += t),
    onThinking: (t) => (seen.thinking += t),
  });
  assert.equal(body.stream, true);
  assert.equal(body.model, 'm');
  assert.deepEqual(seen, { text: 'こんにちは', thinking: '考え' });
  assert.equal(r.content, 'こんにちは');
  assert.equal(r.toolCalls[0].function.name, 'LS');
  assert.equal(r.doneReason, 'stop');
  assert.equal(r.promptEvalCount, 12);
  assert.equal(r.evalCount, 5);
});

test('chat reports the error message of a failed request', async () => {
  handler = (_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model "m" not found' }));
  };
  await assert.rejects(chat(req, new AbortController().signal, {}), /model "m" not found/);
});

test('chat stops when interrupted mid-stream', async () => {
  handler = (_req, res) => {
    res.writeHead(200);
    res.write(ndjson({ message: { content: 'a' } })); // and never finishes
  };
  const ctrl = new AbortController();
  await assert.rejects(chat(req, ctrl.signal, { onContent: () => ctrl.abort() }));
  assert.ok(ctrl.signal.aborted);
});

test('a connection dropped by Ollama is reported as such', async () => {
  handler = (_req, res) => {
    res.writeHead(200);
    res.write(ndjson({ message: { content: 'a' } }));
    setTimeout(() => res.socket?.destroy(), 20);
  };
  const err = await chat(req, new AbortController().signal, {}).then(
    () => assert.fail('should have failed'),
    (e: unknown) => e,
  );
  assert.match(describeError(err), /接続が切れました/);
});

test('describeError reads the error code from node:http and fetch errors', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  assert.match(describeError(refused), /接続できません/);
  assert.match(describeError(new TypeError('fetch failed', { cause: refused })), /接続できません/);
});
