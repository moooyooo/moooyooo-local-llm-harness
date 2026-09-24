import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { SecurityFinding, SecurityScan } from '../shared/protocol.js';
import type { GitOp } from './autoApprove.js';

/**
 * Pre-flight check for git init/add/commit/push: look for secrets and for files that usually
 * belong in .gitignore among what would be recorded (init/add/commit) or published (push).
 */

const execFileAsync = promisify(execFile);

const MAX_FILES = 3000;
const MAX_FINDINGS = 100;
const MAX_CONTENT_BYTES = 1024 * 1024;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;
const MAX_PER_FILE = 5;
const MAX_PUSH_DIFF_BYTES = 20 * 1024 * 1024;

// --- Rules -------------------------------------------------------------------------------------

interface PathRule {
  re: RegExp;
  severity: SecurityFinding['severity'];
  rule: string;
}

const SENSITIVE_FILES: PathRule[] = [
  { re: /(^|\/)\.env(\.(?!example$|sample$|template$|dist$|defaults$)[^/]+)?$/i, severity: 'high', rule: '.env ファイル（秘密情報を含むことが多い）' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|ppk)$/i, severity: 'high', rule: '秘密鍵・証明書ファイル' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, severity: 'high', rule: 'SSH 秘密鍵' },
  { re: /(^|\/)\.(netrc|pgpass|git-credentials)$/i, severity: 'high', rule: '認証情報を含む設定ファイル' },
  { re: /(^|\/)(credentials|secrets?)(\.[a-z]+)?$|service[-_]?account[^/]*\.json$/i, severity: 'high', rule: '認証情報ファイル' },
  { re: /\.tfstate(\.backup)?$/i, severity: 'high', rule: 'Terraform state（秘密情報を含む）' },
  { re: /\.(log)$/i, severity: 'warn', rule: 'ログファイル（.gitignore 推奨）' },
  { re: /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i, severity: 'warn', rule: 'OS が作るファイル（.gitignore 推奨）' },
  { re: /\.(suo|user|pyc|pyo|class|o|obj)$/i, severity: 'warn', rule: 'ビルド・IDE の生成物（.gitignore 推奨）' },
  { re: /\.(sqlite3?|db|mdf|ldf)$/i, severity: 'warn', rule: 'データベースファイル（個人データを含む可能性）' },
];

/** Generated / dependency directories: reported once per directory instead of per file. */
const IGNORE_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', 'dist', 'build', 'out', '.next',
  '.nuxt', 'target', 'bin', 'obj', '.vs', '.idea', 'coverage', '.terraform', '.gradle', '.parcel-cache', '.turbo',
]);
/** `bin/` is source in many Node/shell projects; treat bin/obj as build output only next to a .NET project. */
const DOTNET_ONLY_DIRS = new Set(['bin', 'obj']);
const DOTNET_PROJECT = /\.(cs|vb|fs)proj$|\.sln$/i;

interface ContentRule {
  re: RegExp;
  severity: SecurityFinding['severity'];
  rule: string;
}

const CONTENT_RULES: ContentRule[] = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/, severity: 'high', rule: '秘密鍵' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high', rule: 'AWS アクセスキー' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/, severity: 'high', rule: 'GitHub トークン' },
  { re: /\bsk-ant-[A-Za-z0-9_-]{20,}/, severity: 'high', rule: 'Anthropic API キー' },
  { re: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/, severity: 'high', rule: 'OpenAI 形式の API キー' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high', rule: 'Google API キー' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, severity: 'high', rule: 'Slack トークン' },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, severity: 'high', rule: 'Stripe 本番キー' },
  { re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, severity: 'high', rule: 'SendGrid API キー' },
  { re: /AccountKey=[A-Za-z0-9+/=]{40,}/, severity: 'high', rule: 'Azure ストレージキー' },
  { re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?|mssql|sqlserver):\/\/[^\s:/@"']+:[^\s@/"']+@/i, severity: 'high', rule: 'パスワード付きの接続文字列' },
  { re: /\/\/[^\s]*:_authToken=(?!\$\{)[^\s]+/, severity: 'high', rule: 'npm 認証トークン' },
];

/** `password = "<literal>"`: only quoted literals of 8+ chars, and not obvious placeholders. */
const ASSIGNMENT = /\b(password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{8,})["']/i;
const PLACEHOLDER = /^(x+|\*+|\.+|<.*>|\$\{.*\}|\{\{.*\}\}|%.*%|changeme|change_me|your[_-]?|example|dummy|sample|placeholder|test|password|secret|null|none|undefined|todo)/i;

// --- Entry point -------------------------------------------------------------------------------

export async function scanBeforeGit(ops: GitOp[], cwd: string): Promise<SecurityScan> {
  const scan = new Scan(ops);
  try {
    const top = await gitTop(cwd);
    if (!top) {
      scan.scope = 'git 管理前のフォルダ全体（git init / add で記録されうるファイル）';
      await scan.walk(cwd, cwd, await readGitignore(cwd));
    } else {
      const scopes: string[] = [];
      if (ops.some((o) => o !== 'push')) {
        scopes.push('コミット対象になりうる変更・未追跡ファイル');
        await scan.workingTree(top);
      }
      if (ops.includes('push')) {
        scopes.push('push で送信されるコミット');
        await scan.unpushed(top);
      }
      scan.scope = scopes.join(' / ');
    }
  } catch (err) {
    scan.error = String(err instanceof Error ? err.message : err);
  }
  return scan.result();
}

// --- Implementation ----------------------------------------------------------------------------

async function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer, windowsHide: true, timeout: 20000 });
  return stdout;
}

async function gitTop(cwd: string): Promise<string | null> {
  try {
    return path.normalize((await git(cwd, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    return null;
  }
}

async function readGitignore(dir: string): Promise<string[]> {
  try {
    return (await readFile(path.join(dir, '.gitignore'), 'utf8'))
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^\/|\/$/g, ''))
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

class Scan {
  scope = '';
  error?: string;
  private findings: SecurityFinding[] = [];
  private seen = new Set<string>();
  private checked = 0;
  private truncated = false;
  /** Per ignore-dir file counts, reported as one finding each. */
  private ignoredDirs = new Map<string, number>();
  private dotnetDirs = new Map<string, boolean>();

  constructor(private ops: GitOp[]) {}

  private isDotnetDir(absDir: string): boolean {
    let v = this.dotnetDirs.get(absDir);
    if (v === undefined) {
      try {
        v = readdirSync(absDir).some((n) => DOTNET_PROJECT.test(n));
      } catch {
        v = false;
      }
      this.dotnetDirs.set(absDir, v);
    }
    return v;
  }

  /** Whether directory `name` inside `absParent` is generated output that belongs in .gitignore. */
  private isIgnoreDir(name: string, absParent: string): boolean {
    if (!IGNORE_DIRS.has(name)) return false;
    return !DOTNET_ONLY_DIRS.has(name) || this.isDotnetDir(absParent);
  }

  result(): SecurityScan {
    for (const [dir, count] of this.ignoredDirs) {
      this.add({ path: `${dir}/`, severity: 'warn', rule: '依存関係・生成物のフォルダ（.gitignore 推奨）', detail: count ? `${count} ファイル` : undefined });
    }
    const order = { high: 0, warn: 1 };
    this.findings.sort((a, b) => order[a.severity] - order[b.severity]);
    return { ops: this.ops, scope: this.scope, checkedFiles: this.checked, findings: this.findings, truncated: this.truncated, error: this.error };
  }

  private add(f: SecurityFinding) {
    // The same file can appear in several unpushed commits.
    const key = `${f.path}\0${f.rule}\0${f.detail ?? ''}`;
    if (this.seen.has(key)) return;
    if (this.findings.length >= MAX_FINDINGS) {
      this.truncated = true;
      return;
    }
    this.seen.add(key);
    this.findings.push(f);
  }

  /** Returns the ignore-dir prefix if `rel` lives in one (e.g. "web/node_modules"). */
  private ignoreDirOf(root: string, rel: string): string | undefined {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (this.isIgnoreDir(parts[i], path.join(root, ...parts.slice(0, i)))) return parts.slice(0, i + 1).join('/');
    }
    return undefined;
  }

  /** Path rules, size and content for one file on disk. */
  async checkFile(root: string, rel: string) {
    const dir = this.ignoreDirOf(root, rel);
    if (dir) {
      this.ignoredDirs.set(dir, (this.ignoredDirs.get(dir) ?? 0) + 1);
      return;
    }
    if (this.checked >= MAX_FILES) {
      this.truncated = true;
      return;
    }
    this.checked++;
    for (const r of SENSITIVE_FILES) if (r.re.test(rel)) this.add({ path: rel, severity: r.severity, rule: r.rule });

    let size: number;
    try {
      size = (await stat(path.join(root, rel))).size;
    } catch {
      return; // deleted or unreadable
    }
    if (size > LARGE_FILE_BYTES) this.add({ path: rel, severity: 'warn', rule: '大きなファイル（5MB 超）', detail: `${(size / 1024 / 1024).toFixed(1)} MB` });
    if (size > MAX_CONTENT_BYTES) return;
    const buf = await readFile(path.join(root, rel));
    if (buf.subarray(0, 8000).includes(0)) return; // binary
    this.checkText(rel, buf.toString('utf8').split('\n'));
  }

  private checkText(rel: string, lines: string[], lineNumbers = true) {
    let hits = 0;
    for (let i = 0; i < lines.length && hits < MAX_PER_FILE; i++) {
      const line = lines[i];
      if (line.length > 5000) continue; // minified bundles
      for (const r of CONTENT_RULES) {
        const m = r.re.exec(line);
        if (m) {
          this.add({ path: rel, severity: r.severity, rule: r.rule, detail: redact(m[0]), line: lineNumbers ? i + 1 : undefined });
          hits++;
        }
      }
      const a = ASSIGNMENT.exec(line);
      if (a && !PLACEHOLDER.test(a[2])) {
        this.add({ path: rel, severity: 'warn', rule: `パスワード・キーらしき値（${a[1]}）`, detail: redact(a[2]), line: lineNumbers ? i + 1 : undefined });
        hits++;
      }
    }
  }

  /** Before `git init`: everything under the folder, minus what the existing .gitignore names. */
  async walk(root: string, dir: string, gitignore: string[]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
      if (e.name === '.git' || gitignore.includes(e.name) || gitignore.includes(rel)) continue;
      if (e.isDirectory()) {
        if (this.isIgnoreDir(e.name, dir)) {
          this.ignoredDirs.set(rel, 0);
          continue;
        }
        await this.walk(root, path.join(dir, e.name), gitignore);
      } else if (e.isFile()) {
        await this.checkFile(root, rel);
      }
      if (this.truncated) return;
    }
  }

  /** Staged, modified and untracked-but-not-ignored files: a superset of what `git add -A && git commit` records. */
  async workingTree(top: string) {
    const out = await git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const entries = out.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      const [x, y, rel] = [e[0], e[1], e.slice(3)];
      if (x === 'R' || x === 'C') i++; // next entry is the original path
      if (x === 'D' || y === 'D') continue;
      await this.checkFile(top, rel);
      if (this.truncated) return;
    }
  }

  /** Commits not on the upstream yet (all of history if there is none): file names and added lines. */
  async unpushed(top: string) {
    let range = 'HEAD';
    try {
      await git(top, ['rev-parse', '--abbrev-ref', '@{u}']);
      range = '@{u}..HEAD';
    } catch {
      // no upstream: the first push sends everything
    }
    let diff: string;
    try {
      diff = await git(top, ['log', '-p', '--no-color', '--no-ext-diff', '--format=', range], MAX_PUSH_DIFF_BYTES);
    } catch (err) {
      if (/maxBuffer/i.test(String(err))) {
        this.truncated = true;
        return;
      }
      if (/does not have any commits|unknown revision/i.test(String(err))) return;
      throw err;
    }
    let file = '';
    let added: string[] = [];
    const flush = () => {
      if (!file) return;
      this.checked++;
      const dir = this.ignoreDirOf(top, file);
      if (dir) this.ignoredDirs.set(dir, (this.ignoredDirs.get(dir) ?? 0) + 1);
      else {
        for (const r of SENSITIVE_FILES) if (r.re.test(file)) this.add({ path: file, severity: r.severity, rule: r.rule });
        this.checkText(file, added, false);
      }
      added = [];
    };
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) {
        flush();
        file = line.startsWith('+++ b/') ? line.slice(6) : '';
      } else if (line.startsWith('+')) {
        added.push(line.slice(1));
      }
    }
    flush();
  }
}

function redact(s: string): string {
  const t = s.trim();
  return t.length <= 6 ? '***' : `${t.slice(0, 4)}…（${t.length}文字）`;
}
