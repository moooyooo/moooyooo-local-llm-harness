# moooyooo Local LLM Harness (moooyooo-local-llm-harness)

A local web GUI coding-agent harness for local LLMs served by Ollama. The UX follows custom-harnes, the author's private
web GUI for the Claude Code CLI, but instead of driving a CLI, the server runs its own agent loop against Ollama's `/api/chat`.
Internal names follow the app's name too: the `~/.moooyooo-local-llm-harness` data folder, the localStorage keys, the
LaunchAgent label `com.moooyooo.local-llm-harness`, the app name in `/api/health`, the SearXNG container. Until 2026-09 they
were `custom-harnes-local…`; the GUI still reads settings saved under the old localStorage keys (`OLD_KEYS` in App.tsx).
The local folder may still be called `custom-harnes-local-llm`.
READMEs: `README.md` (English) and `README.ja.md` (Japanese); keep them in step.
It is for personal, local use only: do not add features that expose it to other users or to the network.

## Architecture

```
Browser (React, web/) ⇄ WebSocket /ws ⇄ Node server (server/) ⇄ HTTP (NDJSON stream) ⇄ Ollama /api/chat
```

- `server/index.ts`: sessions live in `live` by GUI tab key (up to `MAX_SESSIONS`), not per connection. Closing or
  reloading the page detaches them and turns go on (auto-approval keeps its last setting); the page remembers its tabs
  in localStorage and sends `attach` on connect, which replays the saved history (`attached`) and pending prompts
  (`AgentSession.pendingPrompts`). Detached sessions idle for `DETACHED_IDLE_MS` are stopped.
- `server/agent.ts`: `AgentSession`, one per GUI tab. `sendUser` runs one turn: call the model → run the tool calls
  (permission gate → user prompt or auto-approval → tool) → feed results back, until the model answers without tool calls.
  Every tool call always gets a `tool` message, even when interrupted, so the conversation stays valid.
  Model, think, `num_ctx` and permission mode can change between turns (`configure`, the `configure` client message);
  that rebuilds the system prompt and writes a new `meta` record, which the history shows as a notice.
  Each model call is capped at `MAX_OUTPUT_TOKENS`; a reply cut off there is retried once with a request for smaller steps
  (a `message` record with `notice`, shown in the GUI as a notice instead of a user prompt).
- `server/features.ts`: experimental changes to what the model sees, each off unless turned on (`HARNESS_FEATURES`, or
  `--features` in scripts/eval) so it can be measured on its own before becoming the default: `fuzzyEdit`
  (`server/editMatch.ts`), `failureAdvice` (`withAdvice`), `loopDetection` (`server/repetition.ts`), `outputLimit`
  (`outputLimit`, `COMPACT_AT_THINKING`), `trimOutputs` (`trimToolOutputs`), `todoList` (TodoWrite, `shared/todos.ts`).
  With all off, the agent behaves as before they existed; tests turn on the one they test.
- `server/compact.ts`: context compaction. Before each model call the prompt size is estimated (Ollama's `prompt_eval_count`
  for the last call, which counts cached tokens too, plus estimates for messages added since); at `COMPACT_AT` of the window
  (the smaller of `num_ctx` and the loaded model's) older messages are replaced by a summary the model writes in a request
  shaped like the real ones (same tools and options, so the KV cache is reused). The latest user prompt is repeated word for
  word, and `readFiles` is cleared so edits need a fresh Read. Also on demand (`compact` client message). With
  `trimOutputs`, an automatic compaction first replaces long tool outputs outside the kept part (never the latest
  calls' results) with a note (a `compact` record with `trimmed` and an empty summary); when that gets below
  `TRIM_ENOUGH`, no summary is written.
  The system prompt is built once per session so Ollama can reuse its KV cache.
- `server/ollama.ts`: REST client. Verified against Ollama 0.32 and 0.34: tool calls arrive whole (with an `id`) in one streamed chunk,
  and nothing is streamed while one is generated (minutes for a large Write), so `chat` uses `node:http` without a timeout
  (fetch aborts with "terminated" after 5 silent minutes). Tool results go back as `{role:"tool", tool_call_id, tool_name, content}`;
  `think: true` on a model without the `thinking` capability is an error (so `thinkParam` only sends it to thinking models).
  Hitting `num_predict` ends with done_reason `length` and drops a half-written tool call; overflowing `num_ctx` never stops
  generation (Ollama silently shifts the context and ends with `stop`). Images go in a user message's `images` as plain
  base64 (a `data:` prefix is an error) and cost about width × height / 1024 tokens; a model without the `vision`
  capability answers HTTP 400 to any image in the conversation, so `AgentSession.request` replaces them with a note.
  A loaded MLX (safetensors) model is reused whatever `num_ctx` a request asks for (GGUF models reload; see `needsReload`
  in Ollama's server/sched.go), so `AgentSession.ensureContext` frees a model loaded with a smaller window
  (`keep_alive: 0`, which lets a running request finish first) before calling it.
- `server/tools.ts`: Read / Write / Edit / Bash (PowerShell on Windows) / Glob / Grep / LS, and TodoWrite with `todoList`.
  Names and parameters follow Claude Code's tools so models use them naturally and `autoApprove.ts` classifies them
  unchanged. `validate` runs before the permission prompt so the user isn't asked about calls that would fail anyway
  (e.g. Edit without a prior Read). A path that doesn't exist gets the working folder and, if a file of that name is
  there, its path (`missingHint`).
  With `fuzzyEdit`, an Edit whose old_string doesn't match exactly goes through `server/editMatch.ts`: a match ignoring
  whitespace is used only if it is unique (new_string's indentation is corrected line by line; not with tabs);
  otherwise the error shows the most similar lines.
- `server/permissions.ts`: `gate()` decides allow / ask / deny per permission mode; `assess()` adds the classifier decision and,
  for git init/add/commit/push, the security scan. git init/add/commit/push always ask, even in `bypassPermissions`.
- `server/autoApprove.ts`, `server/shellParse.ts`, `server/secretScan.ts`: taken from custom-harnes. Policy: allowlist only.
  When you change the rules, add cases to `server/autoApprove.test.ts`, and never loosen a rule without a test.
  Test fixtures must build fake secrets by string concatenation.
- `server/store.ts`: sessions as `<HARNESS_DATA_DIR>/sessions/<uuid>.jsonl` (`meta` / `message` / `result` / `compact` /
  `checkpoint` records). `message` records are exactly what was sent to Ollama, so resuming replays them as-is; a `compact`
  record holds the whole conversation after compaction and replaces everything before it; `checkpoint` records keep a
  session's checkpoints restorable after resuming. `toEvents` turns records into GUI events (full history).
- `server/checkpoints.ts`: checkpoints, snapshots of the working folder in a git repository of the harness's own
  (`<HARNESS_DATA_DIR>/checkpoints/<hash of the folder>/`, the folder as its work tree, `refs/sessions/<id>` per session).
  It runs git with its own gitconfig (`GIT_CONFIG_GLOBAL`, `GIT_*` variables dropped, literal pathspecs), so the user's
  settings and the folder's own `.git` never come into play. Nested repositories and files over 20 MB are added to its
  `info/exclude` before `git add` (a nested repository makes `git add -A` fail). `AgentSession` takes one before each user
  message and every `CHECKPOINT_EVERY` file-changing calls; `restoreCheckpoint` records a backup checkpoint first, then
  tells the model with a user-role message (`RESTORED_HEADER`) and clears `readFiles`. Restoring and showing changes are
  user actions from the GUI, never tools.
- `server/web.ts`: WebSearch / WebFetch, offered only when the session's web setting is on (default off). Searches go to
  a local SearXNG (`npm run searxng` → `scripts/searxng.ts`, Docker via OrbStack, 127.0.0.1:38730, JSON format enabled);
  WebFetch never reaches this machine or the LAN (`checkUrl` plus a `lookup` that refuses private addresses at connect
  time, re-checked on every redirect). Queries and URLs carrying a secret (`findSecret`) are refused before sending.
- `server/systemPrompt.ts`: environment, working rules, plan-mode rules, web rules, and the working folder's `AGENTS.md` / `CLAUDE.md`.
- `shared/i18n/`: every GUI text, in catalogs per language (`ja.ts` is the source; `en.ts`, `zh-CN.ts`). The GUI starts in
  the browser's language, or English (`DEFAULT_LOCALE`) when it isn't offered; the left panel switches it.
  `{count|file|files}` picks a form by number.
  The server sends `Msg` (key + params) or plain strings (`Text`) instead of sentences; the GUI formats them (`t`, `tx`,
  `tNodes` in `web/src/i18n.ts`), so saved history follows the viewer's language.
- `shared/protocol.ts`: browser⇄server messages. Session-scoped messages carry `key`, a client-generated tab ID.
  Agent progress is `{type:'event', key, ev: AgentEvent}`; a resumed session's past turns come as `history` with the same event shapes.
- `web/src/state.ts`: the reducer. Shared parts (Ollama status, models, history) and `tabs: Tab[]`.
- `web/src/App.tsx`: wiring, settings and notifications. UI pieces live in `web/src/components/`. Keep non-component exports
  out of component files; otherwise Vite fast refresh breaks.
- `web/`: Vite + React 19. `vite.config.ts` has `root: 'web'`; builds to `dist/`, which the server serves in production.

## Commands

- `npm run dev`: server (tsx watch --dev, :38721) + Vite (:38722, proxies /ws). Open http://localhost:38722
- `npm run build` then `npm start`: serves `dist/` at http://localhost:38720
- Production normally runs as a LaunchAgent (`scripts/mac/autostart.sh install|restart|status|uninstall`, ported from
  custom-harnes): `scripts/harness.mjs run` builds into `dist-prod/` and serves that (`HARNESS_DIST`), so `npm run build`
  never swaps the running GUI. After changing the harness, `scripts/mac/autostart.sh restart`; don't `npm start` meanwhile.
- Ports live in `shared/ports.ts` (different from custom-harnes so both can run at once; avoid 49152+)
- `npm run typecheck`: checks both server and web (TypeScript 7)
- `npm run searxng [-- stop|status]`: the local SearXNG container for WebSearch (needs Docker, e.g. OrbStack)
- `npm test`: node:test via tsx (`server/**/*.test.ts`). `agent.test.ts` drives the loop with a scripted fake model.
- `scripts/eval/eval.sh LABEL REF [--model M --runs N ...] TASK...`: gives the fixed tasks in `scripts/eval/tasks/` (each
  checked by its own untouched copy of its tests) to the harness at git ref REF (or `worktree`), headless in a Docker
  container against this machine's Ollama. The agent runs in bypassPermissions there, so never run `run.mts` on the host.
  Compare versions with `npx tsx scripts/eval/summary.mts` (results in `/tmp/llh-eval/results.jsonl`).

## Rules

- Keep the server bound to `127.0.0.1` and keep the WebSocket Origin allowlist (`ALLOWED_ORIGINS` in `server/index.ts`).
  Any web page can reach localhost, so without the allowlist a malicious site could run commands through the agent.
- Anything the model asks to run goes through `gate()`; don't add a tool that bypasses it.
- Web access stays off by default, and WebFetch must never reach this machine or the LAN (keep `checkUrl` / `safeLookup` in
  `server/web.ts`): a prompt-injected page could otherwise make the agent call Ollama, this harness or the router.
- When you are unsure of an Ollama response shape, check it against the real server (`curl http://127.0.0.1:11434/api/chat ...`). Don't guess.
- Local models have small contexts: cap tool output (`MAX_OUTPUT_CHARS`) and keep tool descriptions short and direct.
- GUI text goes in the `shared/i18n` catalogs, never directly in code (`server/i18n.test.ts` fails otherwise); add keys
  to `ja.ts` first, then to `en.ts` and `zh-CN.ts` (typecheck fails until they have them). Text for the model (system
  prompt, tool results) stays in English. Server logs may stay Japanese.
  Saved history keeps `Msg` keys and params, so once a key has shipped, don't rename its placeholders: add a new key instead.
