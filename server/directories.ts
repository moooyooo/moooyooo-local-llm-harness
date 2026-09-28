import { mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { msg, TextError } from '../shared/i18n/index.js';
import type { DirectoryListing, DirectoryRequest } from '../shared/protocol.js';

const MAX_ENTRIES = 500;

/** Match the session's relative-path base; only ~ and ~/ (not shell variables) are expanded. */
export function resolveDirectory(value: string, base = process.cwd()): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new TextError(msg('folder.invalidPath'));
  }
  const input = value.trim();
  if (input === '~') return os.homedir();
  if (/^~[/\\]/.test(input)) return path.resolve(os.homedir(), input.slice(2));
  return path.resolve(base, input || '.');
}

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((s) => s.isDirectory(), () => false);
}

async function listing(dir: string, entries: DirectoryListing['entries'], truncated = false): Promise<DirectoryListing> {
  const home = os.homedir();
  const projects = path.join(home, 'Projects');
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? undefined : parent, home,
    projects: await isDirectory(projects) ? projects : undefined, entries, truncated };
}

async function listDirectories(input: string, base: string, complete = false): Promise<DirectoryListing> {
  const target = resolveDirectory(input, base);
  // With a partial leaf name, offer its siblings. A trailing separator means its children.
  const children = !input.trim() || input.trim() === '~' || /[/\\]$/.test(input);
  const dir = complete && !children ? path.dirname(target) : target;
  const prefix = complete && !children ? path.basename(target).toLocaleLowerCase() : '';
  const candidates = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name.toLocaleLowerCase().startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const entries: DirectoryListing['entries'] = [];
  // Check links in bounded batches; files and broken links must never appear as folders.
  for (let i = 0; i < candidates.length && entries.length <= MAX_ENTRIES; i += 32) {
    const batch = await Promise.all(candidates.slice(i, i + 32).map(async (e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() || await isDirectory(full) ? { name: e.name, path: full } : undefined;
    }));
    entries.push(...batch.filter((e): e is { name: string; path: string } => !!e));
  }
  return listing(dir, entries.slice(0, MAX_ENTRIES), entries.length > MAX_ENTRIES);
}

async function createDirectory(parentInput: string, name: string, base: string): Promise<DirectoryListing> {
  // A single directory under the displayed parent. Never overwrite or create implicit ancestors.
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 255 ||
      name === '.' || name === '..' || /[/\\<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new TextError(msg('folder.invalidName'));
  }
  const parent = resolveDirectory(parentInput, base);
  const dir = path.join(parent, name);
  await mkdir(dir);
  return listing(dir, []);
}

/** All callers use the existing WebSocket Origin check. This API is not available to models. */
export async function directoryRequest(request: DirectoryRequest, base: string): Promise<DirectoryListing> {
  try {
    return await (request.type === 'createDirectory'
      ? createDirectory(request.parent, request.name, base)
      : listDirectories(request.path, base, request.complete === true));
  } catch (error) {
    if (error instanceof TextError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new TextError(msg('folder.exists'));
    if (code === 'EACCES' || code === 'EPERM') throw new TextError(msg('folder.denied'));
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TextError(msg('folder.notFound'));
    throw new TextError(msg('folder.failed', { reason: code ?? String(error) }));
  }
}
