/**
 * Evaluation runner: gives fixed tasks (scripts/eval/tasks/<name>/) to the harness's agent loop without the GUI, then
 * checks the result with the task's own copy of its tests and records how the run went.
 *
 * Meant to run inside a container through scripts/eval/eval.sh: the agent works in bypassPermissions mode and every
 * prompt is allowed, so it must not run on the host. The harness to evaluate is imported from --harness, so the same
 * runner measures any version of it.
 *
 * tsx run.mts --harness DIR --out DIR --label NAME --model MODEL [--ctx N] [--think T] [--runs K]
 *             [--timeout-min M] [--continues C] [--features a,b|all|none] TASK...
 *
 * --features turns on experimental changes of the harness (server/features.ts; ignored by versions without it).
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: opt, positionals: tasks } = parseArgs({
  allowPositionals: true,
  options: {
    harness: { type: 'string' },
    out: { type: 'string' },
    label: { type: 'string' },
    model: { type: 'string' },
    ctx: { type: 'string', default: '16384' },
    think: { type: 'string', default: 'off' },
    runs: { type: 'string', default: '1' },
    'timeout-min': { type: 'string', default: '25' },
    continues: { type: 'string', default: '2' },
    features: { type: 'string', default: 'none' },
  },
});
if (!opt.harness || !opt.out || !opt.label || !opt.model || !tasks.length) {
  console.error('usage: run.mts --harness DIR --out DIR --label NAME --model MODEL [options] TASK...');
  process.exit(2);
}

const harness = path.resolve(opt.harness);
const load = (p: string) => import(path.join(harness, p));
const { AgentSession } = await load('server/agent.ts');
const ollama = await load('server/ollama.ts');
const { SessionStore } = await load('server/store.ts');
const checkpoints = existsSync(path.join(harness, 'server/checkpoints.ts'))
  ? new (await load('server/checkpoints.ts')).CheckpointStore(path.join(opt.out, opt.label, 'data'))
  : undefined;
const { msg, textOf } = await load('shared/i18n/index.ts');
const features = existsSync(path.join(harness, 'server/features.ts')) ? (await load('server/features.ts')).parseFeatures(opt.features) : undefined;
/** What the GUI's 「続きから再開」 button sends. */
const CONTINUE = textOf('ja', msg('transcript.continuePrompt'));

const model = opt.model;
const numCtx = Number(opt.ctx) || undefined;
const timeoutMs = Number(opt['timeout-min']) * 60_000;
const store = new SessionStore(path.join(opt.out, opt.label, 'data'));
const capabilities: string[] = await ollama.modelCapabilities(model);

for (const task of tasks) {
  const dir = path.join(HERE, 'tasks', task);
  const prompt = readFileSync(path.join(dir, 'prompt.txt'), 'utf8').trim();
  for (let run = 1; run <= Number(opt.runs); run++) {
    const record = await runOnce(task, dir, prompt, run);
    appendFileSync(path.join(opt.out, 'results.jsonl'), JSON.stringify(record) + '\n');
    const { pass, durationMs, calls, editFailures, toolErrors, repeatRefusals, cutOffs, compactions, continues, timedOut } = record;
    console.log(
      `${opt.label} ${task}#${run}: ${pass ? 'PASS' : 'FAIL'} ${(durationMs / 60_000).toFixed(1)}min calls=${calls} ` +
        `toolErrors=${toolErrors} editFailures=${editFailures} repeats=${repeatRefusals} cutOffs=${cutOffs} ` +
        `compactions=${compactions} continues=${continues}${timedOut ? ' TIMEOUT' : ''}`,
    );
  }
}

async function runOnce(task: string, dir: string, prompt: string, run: number) {
  const cwd = path.join(opt.out!, opt.label!, 'work', `${task}-${run}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  cpSync(path.join(dir, 'files'), cwd, { recursive: true });

  const totals = { calls: 0, evalTokens: 0, promptTokens: 0, lengthStops: 0 };
  const chat = async (req: unknown, signal: AbortSignal, cb: unknown) => {
    const r = await ollama.chat(req, signal, cb);
    totals.calls++;
    totals.evalTokens += r.evalCount;
    totals.promptTokens += r.promptEvalCount;
    if (r.doneReason === 'length') totals.lengthStops++;
    return r;
  };
  const sessionId = randomUUID();
  const s = new AgentSession(
    { sessionId, cwd, model, think: opt.think, numCtx, permissionMode: 'bypassPermissions', capabilities, features },
    {
      chat,
      store,
      autoApprove: () => true,
      contextLength: async (m: string) => (await ollama.listLoaded()).find((x: { name: string }) => x.name === m)?.contextLength,
      unload: (m: string, signal: AbortSignal) => ollama.unloadModel(m, signal),
      checkpoints,
    },
  );

  const m = { toolCalls: {} as Record<string, number>, toolErrors: 0, editFailures: 0, repeatRefusals: 0, cutOffs: 0, compactions: 0, trims: 0, compactFailures: 0, notices: {} as Record<string, number> };
  const names = new Map<string, string>();
  s.on('event', (ev: { type: string; [k: string]: any }) => {
    if (ev.type === 'permission' && !ev.approval.applied) s.respondPermission(ev.id, true);
    if (ev.type === 'assistant') {
      for (const c of ev.toolCalls) {
        names.set(c.id, c.name);
        m.toolCalls[c.name] = (m.toolCalls[c.name] ?? 0) + 1;
      }
    }
    if (ev.type === 'toolResult' && ev.isError) {
      m.toolErrors++;
      if (/already made this exact call/.test(ev.output)) m.repeatRefusals++;
      else if (names.get(ev.id) === 'Edit' && /old_string (was not found|appears)/.test(ev.output)) m.editFailures++;
    }
    if (ev.type === 'notice' && typeof ev.text === 'object') {
      if (/^agent\.cutOff.*Retry$/.test(ev.text.key)) m.cutOffs++;
      m.notices[ev.text.key] = (m.notices[ev.text.key] ?? 0) + 1;
    }
    // Dropping old tool outputs (newer harnesses) is counted apart from summaries.
    if (ev.type === 'compact' && ev.phase === 'done') {
      if (ev.trimmed && !ev.summary) m.trims++;
      else m.compactions++;
    }
    if (ev.type === 'compact' && ev.phase === 'failed') m.compactFailures++;
  });

  const started = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    s.interrupt();
  }, timeoutMs);
  const results: { subtype: string; message?: unknown; numTurns: number }[] = [];
  s.on('event', (ev: { type: string; [k: string]: any }) => {
    if (ev.type === 'result') results.push({ subtype: ev.subtype, message: ev.message, numTurns: ev.numTurns });
  });

  let continues = 0;
  await s.sendUser(prompt);
  // Continue as a user would press 「続きから再開」 after an error, a limit or a cut-off.
  for (;;) {
    const last = results.at(-1);
    const unfinished = !last || last.subtype !== 'success' || !!last.message;
    if (!unfinished || timedOut || continues >= Number(opt.continues)) break;
    continues++;
    await s.sendUser(CONTINUE);
  }
  clearTimeout(timer);
  s.stop();

  const check = spawnSync('bash', [path.join(dir, 'check.sh')], { cwd, encoding: 'utf8', timeout: 180_000 });
  return {
    label: opt.label,
    task,
    run,
    model,
    ctx: numCtx,
    think: opt.think,
    features: opt.features,
    pass: check.status === 0,
    check: `${check.stdout ?? ''}${check.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n'),
    durationMs: Date.now() - started,
    ...totals,
    ...m,
    continues,
    timedOut,
    results: results.map((r) => r.subtype + (r.message ? '(message)' : '')),
    sessionId,
    at: new Date().toISOString(),
  };
}
