import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { SecurityScan } from '../shared/protocol.js';
import { textOf } from '../shared/i18n/index.js';
import { findSecret, scanBeforeGit } from './secretScan.js';

// Fake secrets are assembled at runtime so this file itself never matches a secret pattern.
const FAKE_AWS = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const FAKE_GH = 'ghp' + '_' + 'a'.repeat(36);
const FAKE_ANTHROPIC = 'sk-' + 'ant-' + 'x'.repeat(30);
const FAKE_KEY_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function tmp(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-scan-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
}

function write(root: string, rel: string, content: string) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

function git(root: string, ...args: string[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });
}

const has = (s: SecurityScan, p: string, rule?: RegExp) => s.findings.some((f) => f.path === p && (!rule || rule.test(textOf('ja', f.rule))));
const secretIn = (text: string) => { const m = findSecret(text); return m && textOf('ja', m); };

test('before git init: secrets, sensitive files and generated folders', async () => {
  const root = tmp({
    'src/app.ts': 'export const ok = 1;\n',
    'src/config.ts': `export const aws = "${FAKE_AWS}";\n`,
    '.env': `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`,
    '.env.example': 'ANTHROPIC_API_KEY=\n',
    'keys/server.pem': `${FAKE_KEY_HEADER}\nabc\n`,
    'settings.json': '{ "password": "changeme" }\n{ "api_key": "r3alLooking-Val" }\n',
    'node_modules/x/index.js': 'module.exports = 1;\n',
    'bin/cli.js': '#!/usr/bin/env node\n',
    'dotnet/App.csproj': '<Project />\n',
    'dotnet/bin/Debug/app.dll': 'MZ\0\0binary',
    'debug.log': 'hello\n',
  });
  const s = await scanBeforeGit(['init'], root);
  assert.equal(s.error, undefined);
  assert.ok(has(s, 'src/config.ts', /AWS/));
  assert.ok(has(s, '.env', /\.env/));
  assert.ok(has(s, '.env', /Anthropic/), 'content of .env is scanned too');
  assert.ok(!has(s, '.env.example'), '.env.example is a template');
  assert.ok(!has(s, '.env', /OpenAI/), 'an Anthropic key is not also reported as OpenAI');
  assert.ok(has(s, 'keys/server.pem', /秘密鍵/));
  assert.ok(has(s, 'settings.json', /api_key/));
  assert.ok(!s.findings.some((f) => f.detail && textOf('ja', f.detail).includes('changeme')), 'placeholders are ignored');
  assert.ok(has(s, 'node_modules/', /gitignore/));
  assert.ok(has(s, 'dotnet/bin/', /gitignore/), '.NET build output');
  assert.ok(!has(s, 'bin/'), 'bin/ outside a .NET project is source');
  assert.ok(has(s, 'debug.log'));
  assert.ok(!has(s, 'src/app.ts'));
  assert.ok(s.findings.every((f) => !f.detail || !textOf('ja', f.detail).includes(FAKE_AWS)), 'secrets are redacted');
  assert.equal(s.findings[0].severity, 'high', 'high severity first');
});

test('existing .gitignore is respected before init', async () => {
  const root = tmp({ '.gitignore': 'node_modules/\n.env\n', '.env': `X=${FAKE_GH}\n`, 'node_modules/a.js': '', 'a.ts': '' });
  const s = await scanBeforeGit(['init'], root);
  assert.deepEqual(s.findings, []);
});

test('commit: scans staged, modified and untracked files, not ignored ones', async () => {
  const root = tmp({ '.gitignore': 'node_modules/\n', 'README.md': '# x\n', 'node_modules/a.js': `const t = "${FAKE_GH}";` });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  write(root, 'README.md', `# x\ntoken: ${FAKE_GH}\n`);
  write(root, 'new/secret.txt', `${FAKE_KEY_HEADER}\n`);
  write(root, 'clean.ts', 'export {};\n');

  const s = await scanBeforeGit(['add', 'commit'], root);
  assert.equal(s.error, undefined);
  assert.ok(has(s, 'README.md', /GitHub/));
  assert.ok(has(s, 'new/secret.txt', /秘密鍵/));
  assert.ok(!has(s, 'clean.ts'));
  assert.ok(!s.findings.some((f) => f.path.startsWith('node_modules')), 'ignored files are not part of the commit');
  assert.ok(s.checkedFiles >= 3);
});

test('clean commit has no findings', async () => {
  const root = tmp({ 'a.ts': 'export const a = 1;\n' });
  git(root, 'init', '-q');
  const s = await scanBeforeGit(['commit'], root);
  assert.deepEqual(s.findings, []);
  assert.equal(s.checkedFiles, 1);
});

test('push: secrets anywhere in unpushed history are found, even if later deleted', async () => {
  const root = tmp({ 'a.ts': 'export {};\n' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'one');
  write(root, 'cfg.ts', `const k = "${FAKE_AWS}";\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'oops');
  rmSync(path.join(root, 'cfg.ts'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'remove');

  const s = await scanBeforeGit(['push'], root);
  assert.equal(s.error, undefined);
  assert.ok(has(s, 'cfg.ts', /AWS/), 'history still contains the key');
  assert.match(textOf('ja', s.scope), /push/);
});

test('findSecret spots a secret in a single string, such as a web query or URL', () => {
  assert.equal(secretIn(`aws key ${FAKE_AWS} leaked`), 'AWS アクセスキー');
  assert.equal(secretIn(`https://example.com/?token=${FAKE_GH}`), 'GitHub トークン');
  assert.match(secretIn('api_key = "' + 'q7Zp2LmX9vR4' + '"') ?? '', /api_key/);
  assert.equal(findSecret('api_key = "your-api-key-here"'), undefined, 'placeholders are fine');
  assert.equal(findSecret('ollama num_ctx 64k mlx reload'), undefined);
});
