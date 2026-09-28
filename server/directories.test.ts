import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { TextError } from '../shared/i18n/index.js';
import { directoryRequest, resolveDirectory } from './directories.js';

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'llh-folders-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const hasKey = (key: string) => (err: unknown) => err instanceof TextError && typeof err.text !== 'string' && err.text.key === key;

test('working-folder paths expand home and share the session base without shell expansion', () => {
  const base = path.join(os.tmpdir(), 'base');
  assert.equal(resolveDirectory('~', base), os.homedir());
  assert.equal(resolveDirectory('~/Projects', base), path.join(os.homedir(), 'Projects'));
  assert.equal(resolveDirectory('~\\Projects', base), path.join(os.homedir(), 'Projects'));
  assert.equal(resolveDirectory('child', base), path.join(base, 'child'));
  assert.equal(resolveDirectory('', base), base);
  assert.equal(resolveDirectory('$HOME', base), path.join(base, '$HOME'));
  assert.throws(() => resolveDirectory('x\0y'), hasKey('folder.invalidPath'));
  assert.throws(() => resolveDirectory(undefined as unknown as string), hasKey('folder.invalidPath'));
});

test('browsing lists only directories, with parent navigation and paths for spaced or Unicode names', async (t) => {
  const base = await fixture(t);
  for (const name of ['project 10', 'project 2', '.hidden', '日本語']) await mkdir(path.join(base, name));
  await writeFile(path.join(base, 'file.txt'), 'keep');
  const result = await directoryRequest({ type: 'listDirectories', path: base }, base);
  assert.equal(result.path, base);
  assert.equal(result.parent, path.dirname(base));
  assert.equal(result.home, os.homedir());
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries.map((e) => e.name), ['.hidden', 'project 2', 'project 10', '日本語']);
  assert.ok(result.entries.every((e) => e.path === path.join(base, e.name)));
  const root = await directoryRequest({ type: 'listDirectories', path: path.parse(base).root }, base);
  assert.equal(root.parent, undefined);
});

test('completion narrows a partial leaf and lists children after a trailing separator', async (t) => {
  const base = await fixture(t);
  await mkdir(path.join(base, 'Projects', 'demo'), { recursive: true });
  await mkdir(path.join(base, 'Other'));
  const siblings = await directoryRequest({ type: 'listDirectories', path: 'pro', complete: true }, base);
  assert.deepEqual(siblings.entries.map((e) => e.name), ['Projects']);
  const children = await directoryRequest({ type: 'listDirectories', path: `Projects${path.sep}`, complete: true }, base);
  assert.deepEqual(children.entries.map((e) => e.name), ['demo']);
  assert.equal(children.path, path.join(base, 'Projects'));
});

test('folder creation selects the new directory and never overwrites existing files or folders', async (t) => {
  const base = await fixture(t);
  const request = { type: 'createDirectory' as const, parent: base, name: '新しい project' };
  const created = await directoryRequest(request, base);
  assert.equal(created.path, path.join(base, request.name));
  assert.equal(created.parent, base);
  assert.deepEqual(created.entries, []);
  await assert.rejects(directoryRequest(request, base), hasKey('folder.exists'));
  await writeFile(path.join(base, 'existing'), 'unchanged');
  await assert.rejects(directoryRequest({ ...request, name: 'existing' }, base), hasKey('folder.exists'));
  assert.equal(await readFile(path.join(base, 'existing'), 'utf8'), 'unchanged');
});

test('creation rejects traversal, paths, reserved names and missing parents', async (t) => {
  const base = await fixture(t);
  for (const name of ['', ' ', '.', '..', '../escape', 'x/y', 'x\\y', '/outside', 'C:\\outside', 'x\0y', 'CON', 'nul.txt', 'name.', ' space']) {
    await assert.rejects(directoryRequest({ type: 'createDirectory', parent: base, name }, base), hasKey('folder.invalidName'), name);
  }
  await assert.rejects(directoryRequest({ type: 'createDirectory', parent: path.join(base, 'missing'), name: 'child' }, base), hasKey('folder.notFound'));
  const result = await directoryRequest({ type: 'listDirectories', path: base }, base);
  assert.deepEqual(result.entries, []);
});

test('missing folders and files produce translated picker errors', async (t) => {
  const base = await fixture(t);
  await writeFile(path.join(base, 'file'), 'data');
  for (const target of ['missing', 'file']) {
    await assert.rejects(directoryRequest({ type: 'listDirectories', path: target }, base), hasKey('folder.notFound'));
  }
});

test('folder links are browsable while file links and broken links are excluded', { skip: process.platform === 'win32' }, async (t) => {
  const base = await fixture(t);
  await mkdir(path.join(base, 'folder'));
  await writeFile(path.join(base, 'file'), 'data');
  await symlink(path.join(base, 'folder'), path.join(base, 'folder-link'));
  await symlink(path.join(base, 'file'), path.join(base, 'file-link'));
  await symlink(path.join(base, 'missing'), path.join(base, 'broken-link'));
  const result = await directoryRequest({ type: 'listDirectories', path: base }, base);
  assert.deepEqual(result.entries.map((e) => e.name), ['folder', 'folder-link']);
});

test('large folder lists are bounded, and completion finds entries beyond the initial list', async (t) => {
  const base = await fixture(t);
  await Promise.all(Array.from({ length: 505 }, (_, i) => mkdir(path.join(base, `project-${i}`))));
  const result = await directoryRequest({ type: 'listDirectories', path: base }, base);
  assert.equal(result.entries.length, 500);
  assert.equal(result.truncated, true);
  const completed = await directoryRequest({ type: 'listDirectories', path: 'project-504', complete: true }, base);
  assert.deepEqual(completed.entries.map((e) => e.name), ['project-504']);
  assert.equal(completed.truncated, false);
});
