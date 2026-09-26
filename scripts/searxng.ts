// Starts, stops or checks the local SearXNG container that WebSearch uses (needs Docker, e.g. OrbStack).
//   npm run searxng           start (creates the container and its settings on first use)
//   npm run searxng -- stop   stop
//   npm run searxng -- status
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { SEARXNG_PORT } from '../shared/ports.js';
import { DATA_DIR } from '../server/store.js';

const NAME = 'moooyooo-local-llm-harness-searxng';
const IMAGE = 'docker.io/searxng/searxng:latest';
const DIR = path.join(DATA_DIR, 'searxng');
const URL = `http://127.0.0.1:${SEARXNG_PORT}`;

// Private use: JSON output for the harness, no bot limiter (it would block the harness's requests).
const SETTINGS = (secret: string) => `# Written by moooyooo-local-llm-harness (scripts/searxng.ts). See https://docs.searxng.org/admin/settings/
use_default_settings: true
server:
  secret_key: "${secret}"
  limiter: false
  image_proxy: false
search:
  formats:
    - html
    - json
`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function state(): string | undefined {
  try {
    return docker('inspect', '-f', '{{.State.Status}}', NAME);
  } catch {
    return undefined;
  }
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${URL}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function start() {
  const config = path.join(DIR, 'config');
  if (!existsSync(path.join(config, 'settings.yml'))) {
    mkdirSync(config, { recursive: true });
    writeFileSync(path.join(config, 'settings.yml'), SETTINGS(randomBytes(32).toString('hex')), { mode: 0o600 });
    console.log(`設定を作成しました: ${path.join(config, 'settings.yml')}`);
  }
  const s = state();
  if (s === 'running') {
    console.log(`SearXNG は起動済みです: ${URL}`);
    return;
  }
  if (s) {
    docker('start', NAME);
  } else {
    const cache = path.join(DIR, 'cache');
    mkdirSync(cache, { recursive: true });
    console.log(`SearXNG のイメージを取得して起動します（初回は少し時間がかかります）: ${IMAGE}`);
    // 127.0.0.1 only: nothing else on the network can use it.
    docker('run', '-d', '--name', NAME, '-p', `127.0.0.1:${SEARXNG_PORT}:8080`, '-v', `${config}:/etc/searxng`, '-v', `${cache}:/var/cache/searxng`, IMAGE);
  }
  for (let i = 0; i < 60; i++) {
    if (await healthy()) {
      console.log(`SearXNG を起動しました: ${URL}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`SearXNG が応答しません。docker logs ${NAME} で確認してください`);
}

async function main() {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    throw new Error('Docker が動いていません。OrbStack などを起動してから実行してください');
  }
  const cmd = process.argv[2] ?? 'start';
  if (cmd === 'start') await start();
  else if (cmd === 'stop') {
    if (state() === 'running') docker('stop', NAME);
    console.log('SearXNG を停止しました');
  } else if (cmd === 'status') {
    console.log(`コンテナ: ${state() ?? 'なし'} / 応答: ${(await healthy()) ? 'OK' : 'なし'}（${URL}）`);
  } else throw new Error(`使い方: npm run searxng -- [start|stop|status]`);
}

main().catch((err) => {
  console.error(String(err.message ?? err));
  process.exit(1);
});
