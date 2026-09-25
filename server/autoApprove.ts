import path from 'node:path';
import { msg, type Text } from '../shared/i18n/index.js';
import { parseShell, type ShellKind, type SimpleCommand } from './shellParse.js';

/**
 * Decides whether a permission prompt may be auto-approved when the GUI's "自動承認" is on.
 *
 * Policy: approve only what stays inside the session's working folder and cannot affect the host
 * (OS settings, other folders, global installs, processes, services, registry, credentials).
 * Anything not positively recognised as safe goes to the user, so parsing failures fail closed.
 */
export interface ApprovalDecision {
  auto: boolean;
  /** Shown in the GUI, e.g. why a request still needs a manual decision. */
  reason: Text;
}

const auto = (reason: Text): ApprovalDecision => ({ auto: true, reason });
export const manual = (reason: Text): ApprovalDecision => ({ auto: false, reason });

const NO_HOST_EFFECT_TOOLS = new Set([
  'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
  'Skill', 'ToolSearch', 'EnterPlanMode',
]);
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS: Record<string, ShellKind> = { Bash: 'bash', PowerShell: 'powershell' };

/** Credentials and keys: reading them is not host-affecting, but it is never routine either. */
export const SENSITIVE_PATH = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.azure|\.kube|\.docker)([\\/]|$)|(^|[\\/])\.env(\.[^\\/]*)?$|credentials|id_rsa|id_ed25519|\.pem$|\.pfx$|\.key$/i;
/** Inside the project, but changing these alters git internals or Claude Code's own permissions. */
export const PROTECTED_IN_PROJECT = /(^|[\\/])\.git([\\/]|$)|(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i;

export function shellKindOf(toolName: string): ShellKind | undefined {
  return SHELL_TOOLS[toolName];
}

export function classifyPermission(toolName: string, input: any, cwd: string): ApprovalDecision {
  if (NO_HOST_EFFECT_TOOLS.has(toolName)) return auto(msg('approve.noHostEffect'));
  if (toolName === 'ExitPlanMode') return manual(msg('approve.planApproval'));
  if (toolName === 'AskUserQuestion') return manual(msg('approve.question'));
  if (toolName.startsWith('mcp__')) return manual(msg('approve.mcp'));

  if (READ_TOOLS.has(toolName)) {
    const p = String(input?.file_path ?? input?.path ?? input?.notebook_path ?? '');
    return SENSITIVE_PATH.test(p) ? manual(msg('approve.readSensitive')) : auto(msg('approve.readOnly'));
  }

  if (EDIT_TOOLS.has(toolName)) {
    const p = String(input?.file_path ?? input?.notebook_path ?? '');
    if (!p) return manual(msg('approve.noTarget'));
    if (!insideCwd(p, cwd)) return manual(msg('approve.writeOutside'));
    if (PROTECTED_IN_PROJECT.test(p)) return manual(msg('approve.protected'));
    if (SENSITIVE_PATH.test(p)) return manual(msg('approve.editCredentials'));
    return auto(msg('approve.editInside'));
  }

  const shell = shellKindOf(toolName);
  if (shell) return classifyCommand(String(input?.command ?? ''), cwd, shell);

  return manual(msg('approve.unknownTool', { tool: toolName }));
}

// ---------------------------------------------------------------------------------------------
// Shell commands

/** Programs that only read or print. Arguments are not path-checked. */
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'dir', 'cat', 'type', 'head', 'tail', 'wc', 'pwd', 'echo', 'printf', 'which', 'where', 'tree', 'file', 'stat',
  'du', 'grep', 'egrep', 'rg', 'sort', 'uniq', 'diff', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'date', 'true',
  'false', 'test', 'jq', 'less', 'more', 'column',
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'get-itemproperty', 'get-location', 'gl',
  'select-string', 'sls', 'test-path', 'measure-object', 'measure', 'resolve-path', 'get-command', 'gcm',
  'write-output', 'write-host', 'select-object', 'where-object', 'foreach-object', 'sort-object',
  'format-table', 'ft', 'format-list', 'fl', 'out-string', 'convertfrom-json', 'convertto-json', 'get-date',
  'split-path', 'join-path', 'get-filehash', 'compare-object', 'get-process', 'get-nettcpconnection',
]);

/** Programs that write, allowed only when every path-like argument stays inside the working folder. */
const PATH_CHECKED_PROGRAMS = new Set([
  'cd', 'set-location', 'sl', 'pushd', 'popd', 'mkdir', 'md', 'touch', 'new-item', 'ni', 'cp', 'copy', 'copy-item',
  'mv', 'move', 'move-item', 'set-content', 'add-content', 'out-file',
]);

const GIT_SAFE = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'rev-parse', 'add', 'commit', 'fetch', 'switch', 'grep', 'shortlog', 'describe']);
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PKG_SAFE = new Set(['run', 'run-script', 'test', 't', 'ci', 'install', 'i', 'add', 'ls', 'list', 'view', 'outdated', 'why', 'build', 'dev', 'lint', 'typecheck']);
const GLOBAL_FLAG = /^(-g|--global|--location=global)$/i;
const DEV_TOOLS = new Set(['tsc', 'tsx', 'vite', 'vitest', 'jest', 'eslint', 'prettier', 'biome', 'pytest', 'ruff', 'mypy', 'black']);
const RUNTIMES = new Set(['node', 'python', 'python3', 'py', 'deno']);
const PY_MODULES = new Set(['pytest', 'unittest', 'mypy', 'ruff', 'black']);
const BUILD_TOOLS: Record<string, Set<string>> = {
  cargo: new Set(['build', 'check', 'test', 'fmt', 'clippy']),
  go: new Set(['build', 'test', 'vet', 'fmt']),
  dotnet: new Set(['build', 'test']),
};
const DELETE_PROGRAMS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri']);
const NULL_DEVICE = /^(\/dev\/null|\$null|nul)$/i;

export function classifyCommand(command: string, cwd: string, shell: ShellKind): ApprovalDecision {
  if (!command.trim()) return manual(msg('approve.emptyCommand'));
  const parsed = parseShell(command, shell);
  if (!parsed) return manual(msg('approve.unparsable'));
  if (/\$\(|`|<\(/.test(parsed.expandable)) return manual(msg('approve.substitution'));

  for (const cmd of parsed.commands) {
    const decision = classifySimpleCommand(cmd, cwd);
    if (!decision.auto) return decision;
  }
  return auto(msg('approve.commandInside'));
}

function classifySimpleCommand({ words, redirects }: SimpleCommand, cwd: string): ApprovalDecision {
  for (const target of redirects) {
    if (!NULL_DEVICE.test(target) && !insideCwd(target, cwd)) return manual(msg('approve.redirectOutside'));
  }
  const [rawProgram, ...args] = words;
  if (!rawProgram) return auto(msg('approve.redirectOnly'));
  if (/^[A-Za-z_]\w*=/.test(rawProgram)) return manual(msg('approve.envAssignment'));
  const program = rawProgram.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const sub = args.find((a) => !a.startsWith('-'))?.toLowerCase();

  if (READ_ONLY_PROGRAMS.has(program)) return auto(msg('approve.read'));
  if (program === 'find') {
    return args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint)/.test(a)) ? manual(msg('approve.findDelete')) : auto(msg('approve.read'));
  }
  if (PATH_CHECKED_PROGRAMS.has(program)) {
    return pathArgs(args).every((a) => insideCwd(a, cwd)) ? auto(msg('approve.inside')) : manual(msg('approve.outsidePaths'));
  }
  if (program === 'git') return classifyGit(args, cwd);
  if (PKG_MANAGERS.has(program)) {
    if (args.some((a) => GLOBAL_FLAG.test(a)) || args.join(' ').toLowerCase().includes('--location global')) {
      return manual(msg('approve.global'));
    }
    return sub && PKG_SAFE.has(sub) ? auto(`${program} ${sub}`) : manual(`${program} ${sub ?? ''}`.trim());
  }
  if (program === 'npx' || program === 'bunx' || (program === 'pnpm' && sub === 'dlx')) {
    const tool = args.find((a) => !a.startsWith('-') && a !== 'dlx');
    return tool && DEV_TOOLS.has(tool.toLowerCase()) ? auto(`${program} ${tool}`) : manual(msg('approve.npxAny'));
  }
  if (DEV_TOOLS.has(program)) return auto(program);
  if (RUNTIMES.has(program)) return classifyRuntime(program, args, cwd);
  if (BUILD_TOOLS[program]) {
    return sub && BUILD_TOOLS[program].has(sub) ? auto(`${program} ${sub}`) : manual(`${program} ${sub ?? ''}`.trim());
  }
  if (DELETE_PROGRAMS.has(program)) return manual(msg('approve.delete'));
  return manual(msg('approve.unknownCommand', { program: rawProgram }));
}

/** `git -c key=value`: only settings that can't run code or redirect data. */
const GIT_SAFE_CONFIG = /^(user\.(name|email)|commit\.gpgsign|tag\.gpgsign|core\.quotepath|core\.autocrlf|core\.safecrlf|color\.[\w.]+|i18n\.[\w.]+|init\.defaultbranch|advice\.[\w.]+)=/i;

function classifyGit(allArgs: string[], cwd: string): ApprovalDecision {
  // Global options come before the subcommand: git [-c k=v] [-C dir] [--no-pager] <sub> ...
  let i = 0;
  for (; i < allArgs.length; i++) {
    const a = allArgs[i];
    if (a === '-c') {
      if (!GIT_SAFE_CONFIG.test(allArgs[i + 1] ?? '')) return manual(msg('approve.gitConfig', { value: allArgs[i + 1] ?? '' }));
      i++;
    } else if (a === '-C') {
      if (!insideCwd(allArgs[i + 1] ?? '', cwd)) return manual(msg('approve.gitOtherRepo'));
      i++;
    } else if (/^--(git-dir|work-tree|exec-path|namespace)/.test(a)) {
      return manual(`git ${a}`);
    } else if (!a.startsWith('-')) {
      break;
    }
  }
  const args = allArgs.slice(i);
  const sub = args[0]?.toLowerCase();
  if (!sub) return auto('git');
  if (sub === 'init') {
    // `git init [dir]`: the new repository must be inside the working folder.
    const rest = args.slice(args.indexOf('init') + 1);
    if (rest.some((a) => /^--(separate-git-dir|template)/.test(a))) return manual(msg('approve.gitInitOptions'));
    const dirs = rest.filter((a, i) => !a.startsWith('-') && !/^(-b|--initial-branch)$/.test(rest[i - 1] ?? ''));
    return dirs.every((d) => insideCwd(d, cwd)) ? auto('git init') : manual(msg('approve.gitInitOutside'));
  }
  if (sub === 'branch') return args.some((a) => /^-(d|D|m|M|-delete|-move)$/.test(a)) ? manual(msg('approve.gitBranchChange')) : auto('git branch');
  if (sub === 'stash') return ['list', 'show'].includes(args[1] ?? '') ? auto(msg('approve.gitStashRead')) : manual(msg('approve.gitStashChange'));
  if (sub === 'remote') return args.length === 1 || args[1] === '-v' ? auto(msg('approve.gitRemoteRead')) : manual(msg('approve.gitRemoteChange'));
  return GIT_SAFE.has(sub) ? auto(`git ${sub}`) : manual(msg('approve.gitRisky', { sub }));
}

/** `node script.js` / `python -m pytest`: running the project's own files is fine, inline code is not. */
function classifyRuntime(program: string, args: string[], cwd: string): ApprovalDecision {
  if (args.some((a) => /^(-e|-c|-p|--eval|--print|--command)$/.test(a))) return manual(msg('approve.inlineCode', { program }));
  const m = args.indexOf('-m');
  if (m >= 0) return PY_MODULES.has(args[m + 1] ?? '') ? auto(`${program} -m ${args[m + 1]}`) : manual(`${program} -m ${args[m + 1] ?? ''}`);
  const script = args.find((a) => !a.startsWith('-'));
  if (!script) return manual(msg('approve.interactive', { program }));
  return insideCwd(script, cwd) ? auto(msg('approve.scriptInside', { program })) : manual(msg('approve.scriptOutside'));
}

/** Non-flag arguments; PowerShell `-Name value` pairs are treated as paths too, which only errs towards manual. */
function pathArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith('-'));
}

// ---------------------------------------------------------------------------------------------
// git operations that publish or record files, which get a security scan first

export type GitOp = 'init' | 'add' | 'commit' | 'push';
const GIT_OPS: ReadonlySet<string> = new Set<GitOp>(['init', 'add', 'commit', 'push']);

/** git operations in a shell command that should trigger the pre-commit security scan. */
export function gitOperations(command: string, shell: ShellKind): GitOp[] {
  const parsed = parseShell(command, shell);
  const ops = new Set<GitOp>();
  if (parsed) {
    for (const { words } of parsed.commands) {
      if (words[0]?.toLowerCase().replace(/\.exe$/, '') !== 'git') continue;
      for (const w of words.slice(1)) if (GIT_OPS.has(w)) ops.add(w as GitOp);
    }
  } else {
    // Unparseable commands are never auto-approved, but still deserve the scan.
    for (const m of command.matchAll(/\bgit\b[^\n]*?\b(init|add|commit|push)\b/g)) ops.add(m[1] as GitOp);
  }
  return [...ops];
}

/**
 * True if `p` resolves inside `cwd`. Home (`~`), env vars, PowerShell provider paths (`HKCU:`, `Env:`)
 * and drive-relative paths (`C:foo`, e.g. `C:\x` after bash ate the backslashes) are treated as outside
 * because they can't be resolved safely here.
 */
export function insideCwd(p: string, cwd: string): boolean {
  if (!p) return false;
  if (/^~|[$%]|^[a-z]{2,}:|^[a-z]:(?![\\/])/i.test(p)) return false;
  const rel = path.relative(path.resolve(cwd), path.resolve(cwd, p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
