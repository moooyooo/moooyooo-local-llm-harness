import type { ApprovalInfo, PermissionMode } from '../shared/protocol.js';
import {
  classifyPermission,
  EDIT_TOOLS,
  gitOperations,
  insideCwd,
  manual,
  PROTECTED_IN_PROJECT,
  READ_TOOLS,
  SENSITIVE_PATH,
  shellKindOf,
} from './autoApprove.js';
import { scanBeforeGit } from './secretScan.js';
import { isReadOnlyTool } from './tools.js';

/**
 * Whether a tool call runs silently, needs the user's permission, or is refused, by permission mode.
 * This replaces Claude Code's own permission system; `autoApprove.ts` then decides which prompts
 * may be answered automatically.
 */
export type Gate = { kind: 'allow' } | { kind: 'ask' } | { kind: 'deny'; message: string };

const ALLOW: Gate = { kind: 'allow' };
const ASK: Gate = { kind: 'ask' };

export function gate(mode: PermissionMode, toolName: string, input: Record<string, unknown>, cwd: string): Gate {
  if (mode === 'plan' && !isReadOnlyTool(toolName)) {
    return { kind: 'deny', message: 'Plan mode is read-only, so this tool is not available. Present your plan to the user instead.' };
  }

  if (READ_TOOLS.has(toolName)) {
    const p = String(input.file_path ?? input.path ?? '.');
    if (insideCwd(p, cwd) && !SENSITIVE_PATH.test(p)) return ALLOW;
    return mode === 'bypassPermissions' ? ALLOW : ASK;
  }

  if (EDIT_TOOLS.has(toolName)) {
    if (mode === 'bypassPermissions') return ALLOW;
    const p = String(input.file_path ?? '');
    if (mode === 'acceptEdits' && p && insideCwd(p, cwd) && !PROTECTED_IN_PROJECT.test(p) && !SENSITIVE_PATH.test(p)) return ALLOW;
    return ASK;
  }

  const shell = shellKindOf(toolName);
  if (shell) {
    // git init/add/commit/push always ask, even in bypass mode, so the security scan runs first.
    if (gitOperations(String(input.command ?? ''), shell).length) return ASK;
    return mode === 'bypassPermissions' ? ALLOW : ASK;
  }

  // Unknown tools fail in the tool runner.
  return ALLOW;
}

/** Classifier decision plus, for git init/add/commit/push, a scan of what would be recorded or published. */
export async function assess(toolName: string, input: Record<string, unknown>, cwd: string): Promise<Omit<ApprovalInfo, 'applied'>> {
  let decision = classifyPermission(toolName, input, cwd);
  const shell = shellKindOf(toolName);
  const ops = shell ? gitOperations(String(input.command ?? ''), shell) : [];
  const security = ops.length ? await scanBeforeGit(ops, cwd) : undefined;
  if (security?.error) decision = manual(`セキュリティチェックに失敗（${security.error}）`);
  else if (security?.findings.length) decision = manual(`セキュリティチェックで ${security.findings.length} 件の注意点`);
  else if (security?.truncated) decision = manual('セキュリティチェックが上限に達し、一部未確認');
  return { ...decision, security };
}
