function normalizePath(p: string) {
  return p.replace(/^\/([a-z])\//i, '$1:/').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function samePath(a: string, b: string) {
  return normalizePath(a) === normalizePath(b);
}

export function baseName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

export function formatDate(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One-line summary of a tool input (command, path, pattern, ...). */
export function summarizeInput(input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt;
  return typeof v === 'string' ? truncate(v.split('\n')[0], 120) : '';
}

export function formatBytes(n: number) {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** 131072 → "128K". */
/** Seconds as m:ss (h:mm:ss from an hour). */
export function formatDuration(totalSeconds: number) {
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
  const m = Math.floor(totalSeconds / 60);
  return m < 60 ? `${m}:${s}` : `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}:${s}`;
}

export function formatTokens(n: number) {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n >= 10_000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();
}

export type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** Line diff (LCS) of an Edit's old/new strings, so a one-line change inside a big block shows as one line. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // Too big for the O(n·m) table: show everything as removed + added.
  if (a.length * b.length > 250_000) return [...a.map((text) => ({ op: '-' as const, text })), ...b.map((text) => ({ op: '+' as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i++] });
      j++;
    } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ op: '-', text: a[i++] });
    } else {
      out.push({ op: '+', text: b[j++] });
    }
  }
  return out;
}

export function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}\n…(${s.length - n} chars truncated)` : s;
}
