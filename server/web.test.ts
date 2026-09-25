import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';

// A fake SearXNG. SEARXNG_URL is read when web.ts loads, so import it after the server is listening.
let handler: http.RequestListener = (_req, res) => res.end();
const server = http.createServer((req, res) => handler(req, res));
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.SEARXNG_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const { checkUrl, decode, htmlToText, isBlockedAddress, PAGE_CHARS, pageOutput, safeLookup, webFetch, webSearch } = await import('./web.js');
after(() => {
  server.closeAllConnections();
  server.close();
});

const signal = new AbortController().signal;

test('addresses on this machine and the local network are blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.ok(isBlockedAddress(ip), ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isBlockedAddress(ip), ip);
});

test('WebFetch refuses local hosts, other schemes and credentials before any request', () => {
  for (const url of ['http://localhost:38720/', 'http://api.localhost/', 'http://127.0.0.1:11434/api/tags', 'http://[::1]/', 'http://192.168.1.1/', 'http://[::ffff:127.0.0.1]/']) {
    assert.match(checkUrl(url) ?? '', /this machine or the local network/, url);
  }
  assert.match(checkUrl('file:///etc/passwd') ?? '', /only http/);
  assert.match(checkUrl('ftp://example.com/') ?? '', /only http/);
  assert.match(checkUrl('https://user:pass@example.com/') ?? '', /credentials/);
  assert.match(checkUrl('not a url') ?? '', /Not a valid URL/);
  assert.equal(checkUrl('https://docs.ollama.com/context-length'), undefined);
});

test('a host name that resolves to this machine is refused when it is looked up', async () => {
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => safeLookup('localhost', {}, (e) => resolve(e)));
  assert.equal(err?.code, 'EBLOCKED');
  await assert.rejects(webFetch('http://127.0.0.1:1/', 0, signal), /this machine or the local network/);
});

test('pages become text: the main content, without navigation, scripts or images', () => {
  const html = `<html><head><title>Guide &amp; Tips</title><script>alert(1)</script></head><body>
    <nav>Home | Docs</nav><header>Site header</header>
    <main><h1>Context length</h1><p>Set <code>num_ctx</code> to <a href="/x">64K</a>.</p>
    <ul><li>first</li><li>second</li></ul><img src="a.png" alt="diagram">
    <table><tr><th>Name</th><th>Size</th></tr><tr><td>qwen</td><td>27B</td></tr></table></main>
    <footer>Copyright</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Guide & Tips');
  assert.match(text, /Context length/, 'headings keep their case');
  assert.match(text, /Set num_ctx to 64K\./);
  assert.match(text, /\* first\n \* second/);
  assert.match(text, /Name +Size/);
  for (const noise of ['Home | Docs', 'Site header', 'Copyright', 'alert', 'a.png', '/x']) assert.ok(!text.includes(noise), noise);
});

test('a page without <main> uses the body', () => {
  assert.match(htmlToText('<body><p>plain page</p></body>').text, /plain page/);
});

test('long pages are read in parts', () => {
  const text = 'a'.repeat(PAGE_CHARS + 500);
  const first = pageOutput({ title: 'T', text }, 'https://example.com/', 0);
  assert.match(first, /^Title: T\nURL: https:\/\/example.com\/\n\n/);
  assert.match(first, new RegExp(`500 more characters. Call WebFetch with offset=${PAGE_CHARS}`));
  const second = pageOutput({ title: 'T', text }, 'https://example.com/', PAGE_CHARS);
  assert.match(second, /\(from character \d+\)\n\na{500}$/);
  assert.match(pageOutput({ title: '', text }, 'https://example.com/', PAGE_CHARS * 2), /past the end/);
});

test('the charset comes from the header or a <meta> tag', () => {
  const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b]); // 日本 in Shift_JIS
  assert.equal(decode(sjis, 'text/html; charset=Shift_JIS'), '日本');
  assert.equal(decode(Buffer.concat([Buffer.from('<meta charset="shift_jis">'), sjis]), 'text/html').slice(-2), '日本');
  assert.equal(decode(Buffer.from('日本'), 'text/html'), '日本');
});

test('search results are listed with their URLs and snippets, without duplicates', async () => {
  let asked = '';
  handler = (req, res) => {
    asked = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        results: [
          { title: 'Context length', url: 'https://docs.ollama.com/context-length', content: 'Set  OLLAMA_CONTEXT_LENGTH\n to 64000', publishedDate: '2026-09-23T01:28:21' },
          { title: 'Same page again', url: 'https://docs.ollama.com/context-length', content: 'dup' },
          { title: 'Issue', url: 'https://github.com/ollama/ollama/issues/2714', content: 'x'.repeat(1000) },
        ],
      }),
    );
  };
  const out = await webSearch('ollama num_ctx', signal);
  assert.match(asked, /^\/search\?q=ollama\+num_ctx&format=json$/);
  assert.match(out, /^1\. Context length\n   https:\/\/docs\.ollama\.com\/context-length\n   2026-09-23\n   Set OLLAMA_CONTEXT_LENGTH to 64000/);
  assert.doesNotMatch(out, /Same page again/);
  assert.match(out, /2\. Issue/);
  assert.ok(out.length < 1000, 'snippets are cut');
  assert.match(out, /Read a page with WebFetch/);

  handler = (_req, res) => res.end(JSON.stringify({ results: [] }));
  assert.match(await webSearch('nothing', signal), /No results/);
  handler = (_req, res) => (res.writeHead(403), res.end());
  await assert.rejects(webSearch('x', signal), /HTTP 403 \(is the json format enabled/);
});
