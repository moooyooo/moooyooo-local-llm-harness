#!/usr/bin/env node
// Production launcher (ported from custom-harnes). Only autostart registration is OS-specific (scripts/mac/autostart.sh).
//
//   node scripts/harness.mjs run [--log]      build the GUI, then run the server in this process (foreground).
//                                             Used by the login agent. --log appends output to logs/harness.log.
//   node scripts/harness.mjs start [--no-open] start in the background unless already running, then open the browser
//   node scripts/harness.mjs open             wait until the server answers, then open the browser
//   node scripts/harness.mjs status [--wait]  print whether it is running (--wait: up to 60 s for it to come up)
//
// Production is built into dist-prod/ and served from there, so `npm run build` during development never swaps
// the GUI of a running production server. It is rebuilt on every start, so a restart after an update is enough.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'logs', 'harness.log');
const PROD_DIST = 'dist-prod';
const APP = 'custom-harnes-local-llm';
const [command = 'status', ...flags] = process.argv.slice(2);

const stamp = () => new Date().toLocaleString('sv-SE');
const log = (msg) => console.log(`[${stamp()}] ${msg}`);
function fail(msg) {
  console.error(`[${stamp()}] ${msg}`);
  process.exit(1);
}

if (command === 'run' && flags.includes('--log')) logToFile();
if (!existsSync(path.join(ROOT, 'node_modules', 'tsx'))) fail('node_modules がありません。先に npm ci を実行してください');
// Lets this plain .mjs import the TypeScript sources (shared/ports.ts, server/index.ts).
const { register } = await import('tsx/esm/api');
register();
const { PROD_PORT } = await import(pathToFileURL(path.join(ROOT, 'shared', 'ports.ts')).href);
const PORT = Number(process.env.PORT ?? PROD_PORT);
const ADDRESS = `http://localhost:${PORT}`;

switch (command) {
  case 'run':
    await run();
    break;
  case 'start':
    await start(!flags.includes('--no-open'));
    break;
  case 'open':
    if (!(await waitUntilUp(60))) fail(`${ADDRESS} が応答しません。logs/harness.log を確認してください`);
    openBrowser();
    break;
  case 'status': {
    if (flags.includes('--wait')) await waitUntilUp(60);
    const h = await health();
    if (h.state === 'ours') console.log(`起動中: ${ADDRESS}（pid ${h.pid}）`);
    else if (h.state === 'other') console.log(`ポート ${PORT} は別のプログラムが使用中です`);
    else console.log(`停止中（ポート ${PORT}）`);
    process.exitCode = h.state === 'ours' ? 0 : 1;
    break;
  }
  default:
    fail(`不明なコマンド: ${command}（run / start / open / status）`);
}

async function run() {
  const h = await health();
  // Exit 0 so a login agent with "restart on failure" doesn't loop.
  if (h.state === 'ours') return log(`すでに起動しています: ${ADDRESS}（pid ${h.pid}）`);
  if (h.state === 'other') fail(`ポート ${PORT} は別のプログラムが使用中です（shared/ports.ts で変更できます）`);
  log('GUI をビルドしています…');
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const b = spawnSync(process.execPath, [vite, 'build', '--outDir', `../${PROD_DIST}`, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (b.stdout.trim()) console.log(b.stdout.trim());
  if (b.stderr.trim()) console.error(b.stderr.trim());
  if (b.status !== 0) fail('GUI のビルドに失敗しました');
  process.env.HARNESS_DIST = PROD_DIST;
  process.chdir(ROOT); // the default working folder for new tabs
  log(`起動します: ${ADDRESS}`);
  await import(pathToFileURL(path.join(ROOT, 'server', 'index.ts')).href);
}

async function start(openAfter) {
  const h = await health();
  if (h.state === 'other') fail(`ポート ${PORT} は別のプログラムが使用中です（shared/ports.ts で変更できます）`);
  if (h.state === 'free') {
    mkdirSync(path.dirname(LOG), { recursive: true });
    const out = openSync(LOG, 'a');
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    log('バックグラウンドで起動しています（ログ: logs/harness.log）…');
    if (!(await waitUntilUp(60))) fail('起動を確認できませんでした。logs/harness.log を確認してください');
  }
  log(`起動中: ${ADDRESS}`);
  if (openAfter) openBrowser();
}

/** `ours` = this harness answers on the port, `other` = something else does, `free` = nothing listens. */
async function health() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    if (j?.app === APP) return { state: 'ours', pid: j.pid };
  } catch {
    // not listening, or not JSON
  }
  return (await portOpen()) ? { state: 'other' } : { state: 'free' };
}

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.setTimeout(1500);
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('timeout', () => (s.destroy(), resolve(false)));
    s.once('error', () => resolve(false));
  });
}

async function waitUntilUp(seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    if ((await health()).state === 'ours') return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function openBrowser() {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', ADDRESS]]
    : process.platform === 'darwin' ? ['open', [ADDRESS]]
    : ['xdg-open', [ADDRESS]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

/** For a login task that has no console to capture output. */
function logToFile() {
  mkdirSync(path.dirname(LOG), { recursive: true });
  const file = createWriteStream(LOG, { flags: 'a' });
  const write = file.write.bind(file);
  process.stdout.write = write;
  process.stderr.write = write;
  process.on('uncaughtException', (err) => {
    file.write(`[${stamp()}] ${err?.stack ?? err}\n`, () => process.exit(1));
  });
}
