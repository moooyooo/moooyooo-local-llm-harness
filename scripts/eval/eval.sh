#!/bin/bash
# Runs the evaluation tasks in a container (Docker, e.g. OrbStack) against this machine's Ollama. The agent works
# without permission prompts there, so it never touches this machine's files.
#
#   scripts/eval/eval.sh LABEL REF [run.mts options] TASK...
#     REF: a git ref of the harness to evaluate, or "worktree" for the current files.
#     e.g. scripts/eval/eval.sh before ff32c0a --model qwen3.6:35b-a3b-nvfp4 --runs 2 inventory-py bugfix-js markdown-py
#
# Results are appended to $EVAL_OUT/results.jsonl (default /tmp/llh-eval); the agent's folders and sessions are kept
# under $EVAL_OUT/LABEL/. Summarize with: npx tsx scripts/eval/summary.mts
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LABEL=$1
REF=$2
shift 2
OUT=${EVAL_OUT:-/tmp/llh-eval}
SRC=$OUT/src/$LABEL
rm -rf "$SRC"
mkdir -p "$SRC"
if [ "$REF" = worktree ]; then
  tar -C "$ROOT" --exclude=./node_modules --exclude=./.git --exclude='./dist*' --exclude=./logs -cf - . | tar -C "$SRC" -xf -
else
  git -C "$ROOT" archive "$REF" | tar -C "$SRC" -xf -
fi
docker run --rm --init \
  -v "$SRC":/src:ro -v "$ROOT/scripts/eval":/eval:ro -v "$OUT":/out -v llh-eval-npm:/root/.npm \
  -e OLLAMA_HOST="${EVAL_OLLAMA:-http://host.docker.internal:11434}" \
  node:24 bash -c 'cp -r /src /app && cd /app && npm ci --no-audit --no-fund --silent && npx tsx /eval/run.mts --harness /app --out /out --label "$0" "$@"' \
  "$LABEL" "$@"
