import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { capOutput, runTool, SHELL_TOOL, type ToolContext } from './tools.js';

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(files: Record<string, string> = {}): ToolContext {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'harness-tools-'));
  roots.push(cwd);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), content);
  }
  return { cwd, signal: new AbortController().signal, readFiles: new Set() };
}

test('Read numbers lines and pages with offset/limit', async () => {
  const ctx = setup({ 'a.txt': 'one\ntwo\nthree\n' });
  const r = await runTool('Read', { file_path: 'a.txt' }, ctx);
  assert.equal(r.isError, false);
  assert.equal(r.output, '     1\tone\n     2\ttwo\n     3\tthree');
  const page = await runTool('Read', { file_path: 'a.txt', offset: 2, limit: 1 }, ctx);
  assert.match(page.output, /^\s+2\ttwo\n\n\(1 more lines/);
  assert.equal((await runTool('Read', { file_path: 'missing.txt' }, ctx)).isError, true);
});

test('Edit needs a prior Read and a unique match', async () => {
  const ctx = setup({ 'a.ts': 'const a = 1;\nconst b = 1;\n' });
  const edit = (input: Record<string, unknown>) => runTool('Edit', { file_path: 'a.ts', ...input }, ctx);
  assert.match((await edit({ old_string: 'a = 1', new_string: 'a = 2' })).output, /Read .* first/);
  await runTool('Read', { file_path: 'a.ts' }, ctx);
  assert.match((await edit({ old_string: '= 1', new_string: '= 2' })).output, /appears 2 times/);
  assert.match((await edit({ old_string: 'nope', new_string: 'x' })).output, /not found/);
  const ok = await edit({ old_string: 'const a = 1;', new_string: 'const a = $&2;' });
  assert.equal(ok.isError, false, ok.output);
  assert.equal(readFileSync(path.join(ctx.cwd, 'a.ts'), 'utf8'), 'const a = $&2;\nconst b = 1;\n', '$ patterns are literal');
  const all = await edit({ old_string: '= ', new_string: '== ', replace_all: true });
  assert.match(all.output, /2 replacements/);
});

test('a path that does not exist gets the working folder, and the file there with that name', async () => {
  const ctx = setup({ 'src/a.py': 'x\n' });
  const guess = path.join(path.sep, 'home', 'user', 'project', 'src', 'a.py');
  const r = await runTool('Read', { file_path: guess }, ctx);
  assert.equal(r.isError, true);
  assert.ok(r.output.includes(`The working folder is ${ctx.cwd}. Did you mean ${path.join(ctx.cwd, 'src', 'a.py')}?`), r.output);
  const ls = await runTool('LS', { path: 'nope' }, ctx);
  assert.ok(ls.output.includes(`The working folder is ${ctx.cwd}.`), ls.output);
  assert.doesNotMatch(ls.output, /Did you mean/);
});

test('Edit keeps CRLF line endings', async () => {
  const ctx = setup({ 'w.txt': 'a\r\nb\r\n' });
  await runTool('Read', { file_path: 'w.txt' }, ctx);
  const r = await runTool('Edit', { file_path: 'w.txt', old_string: 'a\nb', new_string: 'a\nx' }, ctx);
  assert.equal(r.isError, false, r.output);
  assert.equal(readFileSync(path.join(ctx.cwd, 'w.txt'), 'utf8'), 'a\r\nx\r\n');
});

test('Write creates folders but will not overwrite an unread file', async () => {
  const ctx = setup({ 'exists.txt': 'old' });
  assert.equal((await runTool('Write', { file_path: 'd/e/new.txt', content: 'hi' }, ctx)).isError, false);
  assert.ok(existsSync(path.join(ctx.cwd, 'd/e/new.txt')));
  assert.match((await runTool('Write', { file_path: 'exists.txt', content: 'x' }, ctx)).output, /Read it first/);
  await runTool('Read', { file_path: 'exists.txt' }, ctx);
  assert.equal((await runTool('Write', { file_path: 'exists.txt', content: 'new' }, ctx)).isError, false);
});

test('shell: output, exit code and working folder', { skip: process.platform === 'win32' }, async () => {
  const ctx = setup();
  const ok = await runTool(SHELL_TOOL, { command: 'pwd && echo hi' }, ctx);
  assert.equal(ok.isError, false);
  assert.match(ok.output, /hi$/);
  assert.ok(ok.output.includes(path.basename(ctx.cwd)));
  const bad = await runTool(SHELL_TOOL, { command: 'echo oops >&2; exit 3' }, ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.output, /oops[\s\S]*exit code 3/);
});

test('shell: timeout and interrupt kill the command', { skip: process.platform === 'win32' }, async () => {
  const ctx = setup();
  const t = await runTool(SHELL_TOOL, { command: 'sleep 30', timeout: 1000 }, ctx);
  assert.match(t.output, /timed out/);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  const started = Date.now();
  const i = await runTool(SHELL_TOOL, { command: 'sleep 30' }, { ...ctx, signal: ctrl.signal });
  assert.match(i.output, /Interrupted/);
  assert.ok(Date.now() - started < 5000);
});

test('Glob, Grep and LS', async () => {
  const ctx = setup({ 'src/a.ts': 'export const needle = 1;\n', 'src/b.js': '// nothing\n', 'node_modules/x/c.ts': 'needle' });
  const g = await runTool('Glob', { pattern: '**/*.ts' }, ctx);
  assert.equal(g.output, path.join('src', 'a.ts'));
  const files = await runTool('Grep', { pattern: 'needle' }, ctx);
  assert.equal(files.output, path.join('src', 'a.ts'));
  const content = await runTool('Grep', { pattern: 'NEEDLE', '-i': true, output_mode: 'content', path: 'src' }, ctx);
  assert.ok(content.output.includes(`${path.join('src', 'a.ts')}:1:export const needle`), content.output);
  assert.equal((await runTool('Grep', { pattern: 'zzz' }, ctx)).output, 'No matches found');
  const ls = await runTool('LS', {}, ctx);
  assert.match(ls.output, /node_modules\/\nsrc\//);
});

test('unknown tools and bad input are tool errors', async () => {
  const ctx = setup();
  assert.match((await runTool('Nope', {}, ctx)).output, /Unknown tool/);
  assert.match((await runTool('Read', {}, ctx)).output, /file_path is required/);
});

test('capOutput keeps head and tail', () => {
  const s = 'a'.repeat(100) + 'b'.repeat(100);
  const c = capOutput(s, 50);
  assert.ok(c.startsWith('a'.repeat(35)));
  assert.ok(c.endsWith('b'.repeat(15)));
  assert.match(c, /150 chars truncated/);
});
