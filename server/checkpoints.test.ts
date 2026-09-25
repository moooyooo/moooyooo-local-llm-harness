import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { CheckpointStore } from './checkpoints.js';

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'harness-cp-'));
  roots.push(root);
  const cwd = path.join(root, 'work');
  mkdirSync(cwd);
  for (const [p, content] of Object.entries(files)) write(cwd, p, content);
  return { cwd, store: new CheckpointStore(path.join(root, 'data')) };
}

function write(cwd: string, p: string, content: string) {
  mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
  writeFileSync(path.join(cwd, p), content);
}

const read = (cwd: string, p: string) => readFileSync(path.join(cwd, p), 'utf8');
const SID = '00000000-0000-4000-8000-00000000000a';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

test('changes since a checkpoint, and restoring it (which can itself be undone)', async () => {
  const { cwd, store } = setup({ 'a.txt': 'one\n', 'src/b.txt': 'b\n' });
  const first = await store.snapshot(cwd, SID, 'before');
  assert.equal(first.changed, 0);

  write(cwd, 'a.txt', 'one\ntwo\n');
  rmSync(path.join(cwd, 'src/b.txt'));
  write(cwd, 'new/deep/c.txt', 'c\n');
  const { files } = await store.changes(cwd, first.commit);
  assert.deepEqual(files, [
    { path: 'a.txt', status: 'modified', added: 1, deleted: 0 },
    { path: 'new/deep/c.txt', status: 'added', added: 1, deleted: 0 },
    { path: 'src/b.txt', status: 'deleted', added: 0, deleted: 1 },
  ]);
  const { patch } = await store.patch(cwd, first.commit, 'a.txt');
  assert.match(patch, /^\+two$/m);

  const r = await store.restore(cwd, SID, first.commit, 'before restore');
  assert.deepEqual([r.restored, r.deleted, r.backup.changed], [2, 1, 3]);
  assert.equal(read(cwd, 'a.txt'), 'one\n');
  assert.equal(read(cwd, 'src/b.txt'), 'b\n');
  assert.ok(!existsSync(path.join(cwd, 'new')), 'folders left empty are removed');

  // Undo the restore.
  await store.restore(cwd, SID, r.backup.commit, 'undo');
  assert.equal(read(cwd, 'a.txt'), 'one\ntwo\n');
  assert.equal(read(cwd, 'new/deep/c.txt'), 'c\n');
  assert.ok(!existsSync(path.join(cwd, 'src/b.txt')));
});

test('an unchanged folder reuses the previous checkpoint', async () => {
  const { cwd, store } = setup({ 'a.txt': 'a' });
  const one = await store.snapshot(cwd, SID, 'one');
  const two = await store.snapshot(cwd, SID, 'two');
  assert.equal(two.commit, one.commit);
  write(cwd, 'a.txt', 'b');
  const three = await store.snapshot(cwd, SID, 'three');
  assert.notEqual(three.commit, one.commit);
  assert.equal(three.changed, 1);
});

test("the folder's own git repository is never touched", async () => {
  const { cwd, store } = setup({ 'a.txt': 'a\n' });
  git(cwd, 'init', '-q');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'first');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const cp = await store.snapshot(cwd, SID, 'before');
  write(cwd, 'a.txt', 'changed\n');
  write(cwd, 'b.txt', 'b\n');
  await store.restore(cwd, SID, cp.commit, 'backup');
  assert.equal(read(cwd, 'a.txt'), 'a\n');
  assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(git(cwd, 'status', '--porcelain'), '', 'index and work tree match the last commit again');
  assert.equal(git(cwd, 'log', '--oneline').trim().split('\n').length, 1);
});

test('ignored files, dependency folders and repositories inside the folder are left out and left alone', async () => {
  const { cwd, store } = setup({ '.gitignore': 'out.log\n', 'a.txt': 'a', 'out.log': 'log1', 'node_modules/x/i.js': 'x' });
  mkdirSync(path.join(cwd, 'inner'));
  git(path.join(cwd, 'inner'), 'init', '-q');
  write(cwd, 'inner/n.txt', 'n1');
  const cp = await store.snapshot(cwd, SID, 'before');
  assert.deepEqual(cp.excluded, ['inner/']);

  write(cwd, 'out.log', 'log2');
  write(cwd, 'inner/n.txt', 'n2');
  write(cwd, 'node_modules/x/i.js', 'y');
  write(cwd, 'a.txt', 'b');
  const { files } = await store.changes(cwd, cp.commit);
  assert.deepEqual(files.map((f) => f.path), ['a.txt']);
  await store.restore(cwd, SID, cp.commit, 'backup');
  assert.deepEqual([read(cwd, 'a.txt'), read(cwd, 'out.log'), read(cwd, 'inner/n.txt'), read(cwd, 'node_modules/x/i.js')], ['a', 'log2', 'n2', 'y']);
  assert.deepEqual((await store.snapshot(cwd, SID, 'again')).excluded, [], 'reported once');
});

test('paths that look like patterns are taken literally', async () => {
  // As a pattern, "[x].md" would also match "x.md".
  const { cwd, store } = setup({ '[x].md': 'brackets', 'x.md': 'plain', 'y.md': 'y' });
  const cp = await store.snapshot(cwd, SID, 'before');
  write(cwd, '[x].md', 'changed');
  write(cwd, 'x.md', 'changed too');
  const { files } = await store.changes(cwd, cp.commit);
  assert.deepEqual(files.map((f) => f.path), ['[x].md', 'x.md']);
  const { patch } = await store.patch(cwd, cp.commit, '[x].md');
  assert.match(patch, /^\+changed$/m);
  assert.doesNotMatch(patch, /changed too/);
  await store.restore(cwd, SID, cp.commit, 'backup');
  assert.deepEqual([read(cwd, '[x].md'), read(cwd, 'x.md'), read(cwd, 'y.md')], ['brackets', 'plain', 'y']);
});

test('only commits of the checkpoint repository are accepted', async () => {
  const { cwd, store } = setup({ 'a.txt': 'a' });
  await store.snapshot(cwd, SID, 'one');
  await assert.rejects(store.changes(cwd, 'HEAD'), /チェックポイントではありません/);
  await assert.rejects(store.restore(cwd, SID, '0'.repeat(40), 'x'), /チェックポイントではありません/);
});

test('repositories unused for a long time are pruned', async () => {
  const { cwd, store } = setup({ 'a.txt': 'a' });
  await store.snapshot(cwd, SID, 'one');
  const [dir] = readdirSync(store.root).filter((n) => n !== 'gitconfig');
  const old = new Date(Date.now() - 40 * 86_400_000);
  utimesSync(path.join(store.root, dir, 'last-used'), old, old);
  await store.prune();
  assert.ok(!existsSync(path.join(store.root, dir)));
});
