import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { msg, TextError } from '../shared/i18n/index.js';
import type { FileChange } from '../shared/protocol.js';
import { DATA_DIR } from './store.js';
import { SKIP_DIRS } from './tools.js';

/**
 * Checkpoints: snapshots of a working folder's files, kept in a git repository of the harness's own
 * (`<data dir>/checkpoints/<hash of the folder>/`) with the folder as its work tree. The folder's own `.git`,
 * branches and history are never touched, and the folder need not be a git repository.
 *
 * What a snapshot leaves out, and a restore therefore never changes: files matched by the folder's .gitignore,
 * dependency folders (`SKIP_DIRS`), git repositories inside the folder, and files over `MAX_FILE_BYTES`.
 * Each session has a ref (`refs/sessions/<id>`) whose commits chain its checkpoints, which keeps them from being
 * garbage-collected.
 */

/** Larger files are left out of checkpoints. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** New files for one snapshot; more means the folder is probably not a project (e.g. the home folder). */
export const MAX_NEW_FILES = 50_000;
const MAX_NEW_BYTES = 1024 * 1024 * 1024;
/** Changed files listed for one checkpoint, and the longest diff shown for one file. */
const MAX_CHANGES = 1000;
const MAX_PATCH_CHARS = 200_000;
/** Checkpoint repositories unused for this long are deleted at startup. */
const KEEP_DAYS = 30;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface Snapshot {
  commit: string;
  /** Files that differ from the session's previous checkpoint (0 for its first). */
  changed: number;
  /** Paths left out from now on because they are git repositories or too large (only newly found ones). */
  excluded: string[];
}

export interface RestoreResult {
  /** The state just before restoring, so the restore itself can be undone. */
  backup: Snapshot;
  /** Files written back from the checkpoint (changed or deleted since), and files created since that were deleted. */
  restored: number;
  deleted: number;
}

const GITCONFIG = `# Used only by the harness's checkpoint repositories (GIT_CONFIG_GLOBAL), so the user's own git settings,
# such as signing or line-ending conversion, don't apply to them.
[user]
\tname = moooyooo Local LLM Harness
\temail = checkpoints@localhost
[core]
\tautocrlf = false
\tsafecrlf = false
\tquotePath = false
\tfsmonitor = false
\tlongpaths = true
[commit]
\tgpgsign = false
[gc]
\tauto = 0
[advice]
\taddEmbeddedRepo = false
[init]
\tdefaultBranch = main
[safe]
\tdirectory = *
`;

export class CheckpointStore {
  readonly root: string;
  /** Git commands on one repository run one at a time (they share its index). */
  private locks = new Map<string, Promise<unknown>>();

  constructor(dataDir = DATA_DIR) {
    this.root = path.join(dataDir, 'checkpoints');
  }

  /** Records the folder's current files for `sessionId` and returns the checkpoint. */
  snapshot(cwd: string, sessionId: string, label: string): Promise<Snapshot> {
    return this.withRepo(cwd, async (repo) => {
      const { tree, excluded } = await repo.stage();
      return { ...(await repo.commit(sessionId, tree, label)), excluded };
    });
  }

  /** Files changed since checkpoint `commit`, compared with the folder now. */
  changes(cwd: string, commit: string): Promise<{ files: FileChange[]; truncated: boolean }> {
    return this.withRepo(cwd, async (repo) => {
      await repo.verify(commit);
      const { tree } = await repo.stage();
      const files = await repo.diff(commit, tree);
      return { files: files.slice(0, MAX_CHANGES), truncated: files.length > MAX_CHANGES };
    });
  }

  /** The diff of one file since checkpoint `commit`. */
  patch(cwd: string, commit: string, file: string): Promise<{ patch: string; truncated: boolean }> {
    return this.withRepo(cwd, async (repo) => {
      await repo.verify(commit);
      const { tree } = await repo.stage();
      const patch = await repo.git(['diff-tree', '-p', '--no-color', '--no-renames', '--no-ext-diff', commit, tree, '--', file]);
      return { patch: patch.slice(0, MAX_PATCH_CHARS), truncated: patch.length > MAX_PATCH_CHARS };
    });
  }

  /**
   * Puts the folder's files back as they were at `commit`: files changed or deleted since are written back, and
   * files created since are deleted. The state before is recorded first (`backup`).
   */
  restore(cwd: string, sessionId: string, commit: string, backupLabel: string): Promise<RestoreResult> {
    return this.withRepo(cwd, async (repo) => {
      await repo.verify(commit);
      const { tree, excluded } = await repo.stage();
      const backup = { ...(await repo.commit(sessionId, tree, backupLabel)), excluded };
      const changes = await repo.diff(commit, tree);
      const created = changes.filter((c) => c.status === 'added').map((c) => c.path);
      const back = changes.filter((c) => c.status !== 'added').map((c) => c.path);
      if (back.length) await repo.git(['checkout', commit, '--pathspec-from-file=-', '--pathspec-file-nul'], back.join('\0'));
      for (const file of created) await removeFile(cwd, file);
      return { backup, restored: back.length, deleted: created.length };
    });
  }

  /** Deletes checkpoint repositories not used for `KEEP_DAYS`. */
  async prune(now = Date.now()): Promise<void> {
    const names = await readdir(this.root).catch(() => [] as string[]);
    for (const name of names) {
      const dir = path.join(this.root, name);
      const used = await stat(path.join(dir, 'last-used')).catch(() => undefined);
      if (used && now - used.mtimeMs > KEEP_DAYS * 86_400_000) await rm(dir, { recursive: true, force: true });
    }
  }

  private async withRepo<T>(cwd: string, fn: (repo: Repo) => Promise<T>): Promise<T> {
    const dir = path.join(this.root, folderKey(cwd));
    const prev = this.locks.get(dir) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const repo = new Repo(dir, cwd, path.join(this.root, 'gitconfig'));
      await repo.open();
      return fn(repo);
    });
    this.locks.set(dir, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(dir) === run) this.locks.delete(dir);
    }
  }
}

/** One folder's checkpoint repository. */
class Repo {
  private readonly dir: string;
  private readonly cwd: string;
  /** The gitconfig used instead of the user's. */
  private readonly config: string;

  constructor(dir: string, cwd: string, config: string) {
    this.dir = dir;
    this.cwd = cwd;
    this.config = config;
  }

  async open() {
    if (!existsSync(path.join(this.dir, 'HEAD'))) {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.config, GITCONFIG);
      await this.git(['init', '-q'], undefined, false);
      await this.git(['config', 'core.bare', 'false']);
      const skip = [...SKIP_DIRS].filter((d) => d !== '.git').map((d) => `${d}/`);
      await writeFile(path.join(this.dir, 'info', 'exclude'), ['# Left out of checkpoints', ...skip, '.DS_Store', ''].join('\n'));
      await writeFile(path.join(this.dir, 'folder.txt'), `${this.cwd}\n`);
    } else if (!existsSync(this.config)) {
      await writeFile(this.config, GITCONFIG);
    }
    await writeFile(path.join(this.dir, 'last-used'), new Date().toISOString());
  }

  /**
   * Adds the folder's current files to the index and returns its tree. Git repositories inside the folder (which
   * `git add` can't take) and files over the size limit are excluded first.
   */
  async stage(): Promise<{ tree: string; excluded: string[] }> {
    const untracked = splitZ(await this.git(['ls-files', '-z', '--others', '--exclude-standard']));
    // A nested repository is listed as its folder, with a trailing slash.
    const excluded = untracked.filter((p) => p.endsWith('/'));
    const files = untracked.filter((p) => !p.endsWith('/'));
    if (files.length > MAX_NEW_FILES) throw new TextError(msg('checkpoint.tooMany', { count: files.length, max: MAX_NEW_FILES }));
    let bytes = 0;
    for (const f of files) {
      const st = await lstat(path.join(this.cwd, f)).catch(() => undefined);
      if (!st?.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) excluded.push(f);
      else bytes += st.size;
    }
    if (bytes > MAX_NEW_BYTES) throw new TextError(msg('checkpoint.tooLarge', { size: `${Math.round(bytes / 1024 / 1024)} MB` }));
    const patterns = excluded.filter((p) => !p.includes('\n')).map((p) => `/${escapeGlob(p)}`);
    if (patterns.length) await appendFile(path.join(this.dir, 'info', 'exclude'), patterns.join('\n') + '\n');
    try {
      await this.git(['add', '-A', '--ignore-errors']);
    } catch (err) {
      // An unreadable file is skipped (and reported without "fatal:"); anything else is a real failure.
      if (!(err instanceof GitError) || /^fatal:/m.test(err.stderr)) throw err;
    }
    return { tree: (await this.git(['write-tree'])).trim(), excluded };
  }

  /** Commits `tree` on the session's ref, or reuses the previous checkpoint when nothing changed. */
  async commit(sessionId: string, tree: string, label: string): Promise<Omit<Snapshot, 'excluded'>> {
    const ref = `refs/sessions/${sessionId}`;
    const parent = (await this.git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]).catch(() => '')).trim();
    if (parent && (await this.git(['rev-parse', `${parent}^{tree}`])).trim() === tree) return { commit: parent, changed: 0 };
    const commit = (await this.git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', label])).trim();
    await this.git(['update-ref', ref, commit]);
    const changed = parent ? splitZ(await this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-only', parent, commit])).length : 0;
    return { commit, changed };
  }

  /** Changes from `commit` to `tree`, by path. */
  async diff(commit: string, tree: string): Promise<FileChange[]> {
    const status = splitZ(await this.git(['diff-tree', '-r', '-z', '--no-renames', '--name-status', commit, tree]));
    const counts = new Map<string, { added?: number; deleted?: number }>();
    for (const entry of splitZ(await this.git(['diff-tree', '-r', '-z', '--no-renames', '--numstat', commit, tree]))) {
      const [added, deleted, ...rest] = entry.split('\t');
      // Binary files have "-" for both counts.
      counts.set(rest.join('\t'), added === '-' ? {} : { added: Number(added), deleted: Number(deleted) });
    }
    const out: FileChange[] = [];
    for (let i = 0; i + 1 < status.length; i += 2) {
      const code = status[i][0];
      const file = status[i + 1];
      out.push({ path: file, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', ...counts.get(file) });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async verify(commit: string) {
    if (!COMMIT_RE.test(commit)) throw new TextError(msg('checkpoint.unknown'));
    await this.git(['cat-file', '-e', `${commit}^{commit}`]).catch(() => {
      throw new TextError(msg('checkpoint.unknown'));
    });
  }

  git(args: string[], input?: string, withWorkTree = true): Promise<string> {
    const base = withWorkTree ? ['--git-dir', this.dir, '--work-tree', this.cwd] : ['--git-dir', this.dir];
    return new Promise((resolve, reject) => {
      const child = execFile(
        'git',
        [...base, ...args],
        { cwd: this.cwd, env: gitEnv(this.config), maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) return resolve(stdout);
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new TextError(msg('checkpoint.noGit')));
          reject(new GitError(args[0], stderr || err.message));
        },
      );
      // Git may exit before reading stdin (EPIPE); its exit code and stderr tell what happened.
      child.stdin?.on('error', () => {});
      if (input === undefined) child.stdin?.end();
      else child.stdin?.end(input);
    });
  }
}

class GitError extends TextError {
  readonly stderr: string;
  constructor(command: string, stderr: string) {
    super(msg('checkpoint.gitFailed', { command, reason: stderr.trim().split('\n').slice(-3).join(' ') }));
    this.stderr = stderr;
  }
}

/** The user's git settings and variables (hooks, signing, GIT_DIR from a parent git process) must not apply. */
function gitEnv(config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

function folderKey(cwd: string): string {
  const p = path.resolve(cwd);
  return createHash('sha256').update(process.platform === 'win32' ? p.toLowerCase() : p).digest('hex').slice(0, 16);
}

/** Deletes a file created after the checkpoint, then folders left empty by that (never the working folder). */
async function removeFile(cwd: string, file: string) {
  const abs = path.join(cwd, file);
  const st = await lstat(abs).catch(() => undefined);
  if (!st || st.isDirectory()) return;
  await rm(abs, { force: true });
  for (let dir = path.dirname(file); dir !== '.' && dir !== path.sep && dir !== '/'; dir = path.dirname(dir)) {
    try {
      await rmdir(path.join(cwd, dir));
    } catch {
      break;
    }
  }
}

function splitZ(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

/** A literal path as a .gitignore pattern. */
function escapeGlob(p: string): string {
  return p.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ');
}
