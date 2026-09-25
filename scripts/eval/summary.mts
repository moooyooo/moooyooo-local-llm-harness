/**
 * Summarizes scripts/eval results per label and task: pass rate and averages.
 *   npx tsx scripts/eval/summary.mts [results.jsonl]   (default /tmp/llh-eval/results.jsonl)
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? `${process.env.EVAL_OUT ?? '/tmp/llh-eval'}/results.jsonl`;
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const groups = new Map<string, any[]>();
for (const r of rows) {
  const key = `${r.label}\t${r.task}`;
  groups.set(key, [...(groups.get(key) ?? []), r]);
}
const avg = (rs: any[], f: (r: any) => number) => rs.reduce((s, r) => s + f(r), 0) / rs.length;
const table = [...groups].map(([key, rs]) => {
  const [label, task] = key.split('\t');
  return {
    label,
    task,
    runs: rs.length,
    pass: `${rs.filter((r) => r.pass).length}/${rs.length}`,
    minutes: avg(rs, (r) => r.durationMs / 60_000).toFixed(1),
    calls: avg(rs, (r) => r.calls).toFixed(0),
    kTokensOut: avg(rs, (r) => r.evalTokens / 1000).toFixed(1),
    toolErrors: avg(rs, (r) => r.toolErrors).toFixed(1),
    editFailures: avg(rs, (r) => r.editFailures).toFixed(1),
    repeats: avg(rs, (r) => r.repeatRefusals).toFixed(1),
    cutOffs: avg(rs, (r) => r.cutOffs).toFixed(1),
    compactions: avg(rs, (r) => r.compactions).toFixed(1),
    trims: avg(rs, (r) => r.trims ?? 0).toFixed(1),
    continues: avg(rs, (r) => r.continues).toFixed(1),
    timeouts: rs.filter((r) => r.timedOut).length,
  };
});
console.table(table);
