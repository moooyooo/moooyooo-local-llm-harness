import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PermissionMode } from '../shared/protocol.js';
import { SHELL_TOOL } from './tools.js';

/** Project instruction files, read from the working folder like Codex (AGENTS.md) and Claude Code (CLAUDE.md). */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const MAX_INSTRUCTIONS_CHARS = 16_000;

export function buildSystemPrompt(opts: { cwd: string; permissionMode: PermissionMode; tools: boolean }): string {
  const { cwd, permissionMode, tools } = opts;
  const parts = [
    'You are a coding agent running in "Local Harness", a GUI on the user\'s own computer. ' +
      'You help the user with software engineering tasks in their working folder' + (tools ? ' by using the provided tools.' : '.'),
    section('Environment', [
      `Working folder: ${cwd}`,
      `Platform: ${process.platform} (${os.release()})${tools ? `, shell tool: ${SHELL_TOOL}` : ''}`,
      `Today's date: ${new Date().toISOString().slice(0, 10)}`,
      gitInfo(cwd),
    ]),
  ];

  if (tools) {
    parts.push(
      section('How to work', [
        'Answer in the language the user writes in.',
        'Look before you change: inspect the relevant files with Read, Grep, Glob and LS. Never guess what a file contains.',
        'To change an existing file, Read it, then use Edit with an exact old_string that is unique in the file. Use Write only for new files or full rewrites.',
        'Keep each Write or Edit to about 200 lines. Split bigger work into several files, or Write a first part and add the rest with Edit: ' +
          'a long tool call takes many minutes to generate and can be cut off.',
        `Use Read/Grep/Glob/LS instead of ${SHELL_TOOL} commands such as cat, grep, find or ls.`,
        'Paths may be absolute or relative to the working folder. Stay inside the working folder unless the user asks otherwise.',
        `Each ${SHELL_TOOL} call starts in the working folder; cd does not carry over. Do not run interactive programs or servers that never exit.`,
        'Some tool calls need the user\'s permission. If a call is denied, do not repeat it; change your approach or ask the user.',
        'Work step by step and check each tool result before continuing. After changing code, run the relevant build or tests when there are any.',
        'When the task is done, stop calling tools and reply with a short summary of what you did.',
        'Be concise. Use Markdown. Never print or commit secrets such as API keys.',
      ]),
    );
  } else {
    parts.push(section('Notes', ['Answer in the language the user writes in.', 'This model has no tools here, so you cannot read or change files; ask the user to paste what you need.']));
  }

  if (permissionMode === 'plan') {
    parts.push(
      section('Plan mode', [
        'Only read-only tools are available. Investigate the code, then reply with a concrete, step-by-step implementation plan ' +
          '(files to change and how). Do not claim to have changed anything.',
      ]),
    );
  }

  const instructions = projectInstructions(cwd);
  if (instructions) parts.push(`# Project instructions\n\nThe user's instructions for this project. Follow them.\n\n${instructions}`);
  return parts.join('\n\n');
}

function section(title: string, lines: (string | undefined)[]): string {
  return `# ${title}\n${lines.filter(Boolean).map((l) => `- ${l}`).join('\n')}`;
}

function gitInfo(cwd: string): string {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .toString()
      .trim();
    return `Git repository: yes (branch ${branch})`;
  } catch {
    return 'Git repository: no';
  }
}

function projectInstructions(cwd: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of INSTRUCTION_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(cwd, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(`## ${name}\n\n${text.length > MAX_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}\n…(truncated)` : text}`);
  }
  return out.join('\n\n');
}
