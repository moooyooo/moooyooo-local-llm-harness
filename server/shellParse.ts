/**
 * A small, conservative lexer for the commands Claude Code runs through its Bash / PowerShell tools.
 * It understands just enough to split a command into simple commands and words without being fooled by
 * quoting: single/double quotes, PowerShell here-strings (@'…'@, @"…"@), bash heredocs (<<'EOF'),
 * escapes, comments, redirections and separators (&&, ||, ;, |, &, newline).
 *
 * It is not a full shell parser. Callers must treat `null` (unparseable) as "needs a human".
 */

export type ShellKind = 'bash' | 'powershell';

export interface SimpleCommand {
  /** Program and arguments with quotes removed. Quoted text stays one word. */
  words: string[];
  /** Output redirection targets (`> file`, `>> file`, `2> file`). `>&2` style duplications are dropped. */
  redirects: string[];
}

export interface ParsedCommand {
  commands: SimpleCommand[];
  /**
   * Text where the shell performs expansion (unquoted and double-quoted parts, expandable heredocs).
   * Check it for command substitution; literal single-quoted text is excluded.
   */
  expandable: string;
}

const SEPARATOR_CHARS = new Set([';', '|', '&']);

export function parseShell(command: string, shell: ShellKind): ParsedCommand | null {
  const src = command.replace(/\r\n/g, '\n');
  const n = src.length;
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let redirects: string[] = [];
  let word: string | null = null;
  let expandable = '';
  /** What the next completed word is: an argument, an output target, or input data to ignore. */
  let next: 'arg' | 'redirect' | 'input' = 'arg';
  const heredocs: { delim: string; literal: boolean; stripTabs: boolean }[] = [];

  const append = (s: string, isExpandable: boolean) => {
    word = (word ?? '') + s;
    if (isExpandable) expandable += s;
  };
  const endWord = () => {
    if (word === null) return;
    if (next === 'redirect') redirects.push(word);
    else if (next === 'arg') words.push(word);
    next = 'arg';
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
    next = 'arg';
  };

  let i = 0;
  while (i < n) {
    const c = src[i];

    if (c === '\n') {
      endCommand();
      i++;
      // Heredoc bodies start on the line after the operator.
      for (const h of heredocs) {
        let found = false;
        while (i < n) {
          const eol = src.indexOf('\n', i);
          const line = src.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if ((h.stripTabs ? line.replace(/^\t+/, '') : line) === h.delim) {
            found = true;
            break;
          }
          if (!h.literal) expandable += `${line}\n`;
        }
        if (!found) return null;
      }
      heredocs.length = 0;
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i++;
      continue;
    }
    if (c === '#' && word === null) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('&&', i) || src.startsWith('||', i)) {
      endCommand();
      i += 2;
      continue;
    }
    if (SEPARATOR_CHARS.has(c)) {
      endCommand();
      i++;
      continue;
    }

    if (c === '>') {
      // `2>` / `*>`: the fd prefix belongs to the operator, not the previous word.
      if (word !== null && /^[0-9*]$/.test(word)) word = null;
      else endWord();
      i++;
      if (src[i] === '>') i++;
      if (src[i] === '&') {
        // `>&2`, `2>&1`: fd duplication, no file involved.
        i++;
        while (i < n && /[0-9-]/.test(src[i])) i++;
        continue;
      }
      next = 'redirect';
      continue;
    }

    if (c === '<') {
      endWord();
      if (shell === 'bash' && src.startsWith('<(', i)) {
        expandable += '<('; // process substitution
        i++;
        continue;
      }
      if (shell === 'bash' && src.startsWith('<<<', i)) {
        i += 3;
        next = 'input';
        continue;
      }
      if (shell === 'bash' && src.startsWith('<<', i)) {
        i += 2;
        const stripTabs = src[i] === '-';
        if (stripTabs) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let raw = '';
        while (i < n && !/[\s;|&<>()]/.test(src[i])) raw += src[i++];
        if (!raw) return null;
        const literal = /['"\\]/.test(raw);
        heredocs.push({ delim: raw.replace(/['"\\]/g, ''), literal, stripTabs });
        continue;
      }
      // Input redirection reads a file; the target is not an argument.
      i++;
      next = 'input';
      continue;
    }

    if (shell === 'powershell' && c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && src[i + 2] === '\n') {
      const q = src[i + 1];
      const start = i + 3;
      // The closing '@ / "@ must start a line.
      const close = src.indexOf(`\n${q}@`, start - 1);
      if (close < 0) return null;
      append(src.slice(start, close), q === '"');
      i = close + 3;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) return null;
        if (src[j] === "'") {
          if (shell === 'powershell' && src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      append(s, false);
      i = j + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= n) return null;
        const d = src[j];
        if (d === '"') {
          if (shell === 'powershell' && src[j + 1] === '"') {
            s += '"';
            j += 2;
            continue;
          }
          break;
        }
        if ((shell === 'bash' && d === '\\') || (shell === 'powershell' && d === '`')) {
          if (j + 1 >= n) return null;
          s += src[j + 1];
          j += 2;
          continue;
        }
        if (shell === 'bash' && d === '`') expandable += '`';
        s += d;
        j++;
      }
      append(s, true);
      i = j + 1;
      continue;
    }

    if (shell === 'bash' && c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      append(src[i + 1] ?? '', true);
      i += 2;
      continue;
    }

    if (c === '`') {
      if (shell === 'powershell') {
        // Escape character; before a newline it continues the line.
        if (src[i + 1] === '\n') i += 2;
        else {
          append(src[i + 1] ?? '', true);
          i += 2;
        }
        continue;
      }
      expandable += '`'; // bash command substitution
      append('`', false);
      i++;
      continue;
    }

    append(c, true);
    i++;
  }

  if (heredocs.length) return null;
  endCommand();
  return { commands, expandable };
}
