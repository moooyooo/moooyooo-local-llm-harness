/**
 * Recovery for Edit calls whose old_string doesn't match the file exactly. Local models often get whitespace wrong
 * (indentation, trailing spaces, blank lines around the snippet) or send "\n" as two characters. A fuzzy match is
 * accepted only when it is unique in the file; otherwise the model is shown the most similar lines instead.
 */

export interface FuzzyMatch {
  /** The exact text in the file to replace. */
  oldStr: string;
  /** new_string adjusted the same way (line endings, indentation). */
  newStr: string;
  /** For the tool result, so the model learns what was different. */
  note: string;
}

/** Ways of comparing a line, from strictest to loosest. */
const LINE_MATCHERS: { name: string; norm: (line: string) => string }[] = [
  { name: 'ignoring leading and trailing whitespace', norm: (l) => l.trim() },
  { name: 'ignoring differences in whitespace', norm: (l) => l.trim().replace(/\s+/g, ' ') },
];

export function fuzzyMatch(text: string, oldStr: string, newStr: string): FuzzyMatch | undefined {
  // "\n" written as a backslash and an n where a line break was meant.
  if (!oldStr.includes('\n') && /\\[nt]/.test(oldStr)) {
    const o = unescape(oldStr);
    const n = unescape(newStr);
    if (countOf(text, o) === 1) return { oldStr: o, newStr: n, note: 'old_string had "\\n" written out; it was read as line breaks' };
    oldStr = o;
    newStr = n;
  }
  const pattern = trimBlankLines(oldStr.replace(/\r\n/g, '\n').split('\n'));
  if (!pattern.lines.length || pattern.lines.every((l) => !l.trim())) return;
  const lines = splitLines(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const { name, norm } of LINE_MATCHERS) {
    const want = pattern.lines.map(norm);
    const found: number[] = [];
    for (let i = 0; i + want.length <= lines.length && found.length < 2; i++) {
      if (want.every((w, k) => norm(lines[i + k].text) === w)) found.push(i);
    }
    if (found.length !== 1) continue;
    const i = found[0];
    const fileLines = lines.slice(i, i + want.length).map((l) => l.text);
    const newLines = reindentLines(pattern.lines, fileLines, trimBlankLines(newStr.replace(/\r\n/g, '\n').split('\n'), pattern).lines);
    if (!newLines) return;
    const last = lines[i + want.length - 1];
    const matched = text.slice(lines[i].start, last.start + last.text.length);
    return {
      oldStr: matched,
      newStr: newLines.join(eol),
      note: `old_string did not match exactly; it matched lines ${i + 1}-${i + want.length} ${name}`,
    };
  }
}

/** The part of the file most like old_string, as numbered lines, to show when nothing matched. */
export function closestLines(text: string, oldStr: string, context = 1): { from: number; to: number; lines: string[] } | undefined {
  const want = trimBlankLines(oldStr.replace(/\r\n/g, '\n').split('\n')).lines.map((l) => l.trim());
  const lines = splitLines(text).map((l) => l.text);
  if (!want.length) return;
  let best = { at: -1, score: 0 };
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let k = 0; k < want.length && i + k < lines.length; k++) if (want[k] && lines[i + k].trim() === want[k]) score++;
    if (score > best.score) best = { at: i, score };
  }
  if (best.at < 0) return;
  const from = Math.max(0, best.at - context);
  const to = Math.min(lines.length, best.at + want.length + context);
  return { from: from + 1, to, lines: lines.slice(from, to) };
}

function countOf(text: string, s: string): number {
  return s ? text.split(s).length - 1 : 0;
}

function unescape(s: string): string {
  return s.replace(/\\(n|t|"|\\)/g, (_, c: string) => ({ n: '\n', t: '\t', '"': '"', '\\': '\\' })[c]!);
}

/** Leading and trailing blank lines dropped; `like` drops as many as another string had, so both stay aligned. */
function trimBlankLines(lines: string[], like?: { head: number; tail: number }): { lines: string[]; head: number; tail: number } {
  let head = 0;
  let tail = 0;
  const limit = (n: number | undefined) => n ?? Infinity;
  while (head < lines.length && head < limit(like?.head) && !lines[head].trim()) head++;
  while (tail < lines.length - head && tail < limit(like?.tail) && !lines[lines.length - 1 - tail].trim()) tail++;
  return { lines: lines.slice(head, lines.length - tail), head, tail };
}

function splitLines(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /\r?\n/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ text: text.slice(start, m.index), start });
    start = m.index + m[0].length;
  }
  out.push({ text: text.slice(start), start });
  return out;
}

/** Indentation of the first non-blank line. */
function indentOf(lines: string[]): string {
  const line = lines.find((l) => l.trim());
  return line ? line.slice(0, line.length - line.trimStart().length) : '';
}

/**
 * new_string with the indentation corrected the way old_string's lines were off from the file's. When old_string was off
 * by the same amount on every line, everything shifts by that. Otherwise (e.g. one closing bracket off by a space) each
 * line of new_string takes the correction of the old_string line with the same text, or of the last such line; this
 * needs spaces only. undefined when it can't be done safely.
 */
function reindentLines(pattern: string[], fileLines: string[], newLines: string[]): string[] | undefined {
  if (sameRelativeIndent(pattern, fileLines)) {
    const [from, to] = [indentOf(pattern), indentOf(fileLines)];
    return newLines.map((l) => reindent(l, from, to));
  }
  const lead = (l: string) => l.slice(0, l.length - l.trimStart().length);
  if ([...pattern, ...fileLines, ...newLines].some((l) => lead(l).includes('\t'))) return;
  const width = (l: string) => lead(l).length;
  const deltas = pattern.map((l, k) => (l.trim() ? width(fileLines[k]) - width(l) : undefined));
  let delta = deltas.find((d) => d !== undefined) ?? 0;
  let next = 0;
  return newLines.map((l) => {
    if (!l.trim()) return l;
    for (let k = next; k < pattern.length; k++) {
      if (deltas[k] !== undefined && pattern[k].trim() === l.trim()) {
        delta = deltas[k]!;
        next = k + 1;
        break;
      }
    }
    return ' '.repeat(Math.max(0, width(l) + delta)) + l.trimStart();
  });
}

/** Each non-blank line is indented the same relative to the first one in both. */
function sameRelativeIndent(a: string[], b: string[]): boolean {
  const width = (l: string) => l.length - l.trimStart().length;
  const base = (ls: string[]) => width(ls.find((l) => l.trim()) ?? '');
  const [ba, bb] = [base(a), base(b)];
  return a.every((l, k) => !l.trim() || !b[k].trim() || width(l) - ba === width(b[k]) - bb);
}

/** Moves a line from old_string's indentation to the file's. */
function reindent(line: string, from: string, to: string): string {
  if (from === to || !line.trim()) return line;
  return line.startsWith(from) ? to + line.slice(from.length) : line;
}
