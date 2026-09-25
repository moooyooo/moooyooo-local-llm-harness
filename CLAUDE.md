# Local LLM Harness (local-llm-harness)

A local web GUI coding-agent harness for local LLMs served by Ollama. The UX follows custom-harnes, the author's private
web GUI for the Claude Code CLI, but instead of driving a CLI, the server runs its own agent loop against Ollama's `/api/chat`.
Internal names (the `~/.custom-harnes-local` data folder, the settings key in localStorage, the LaunchAgent label, the app
name in `/api/health`) keep the old `custom-harnes-local` spelling so existing installs keep working.
READMEs: `README.md` (English) and `README.ja.md` (Japanese); keep them in step.
It is for personal, local use only: do not add features that expose it to other users or to the network.

## Architecture

```
Browser (React, web/) ⇄ WebSocket /ws ⇄ Node server (server/) ⇄ HTTP (NDJSON stream) ⇄ Ollama /api/chat
```

- `server/agent.ts`: `AgentSession`, one per GUI tab (a connection holds up to `MAX_SESSIONS` in a `Map<key, AgentSession>`
  in `server/index.ts`; closing the socket stops them all). `sendUser` runs one turn: call the model → run the tool calls
  (permission gate → user prompt or auto-approval → tool) → feed results back, until the model answers without tool calls.
  Every tool call always gets a `tool` message, even when interrupted, so the conversation stays valid.
  Model, think, `num_ctx` and permission mode can change between turns (`configure`, the `configure` client message);
  that rebuilds the system prompt and writes a new `meta` record, which the history shows as a notice.
  Each model call is capped at `MAX_OUTPUT_TOKENS`; a reply cut off there is retried once with a request for smaller steps
  (a `message` record with `notice`, shown in the GUI as a notice instead of a user prompt).
- `server/compact.ts`: context compaction. Before each model call the prompt size is estimated (Ollama's `prompt_eval_count`
  for the last call, which counts cached tokens too, plus estimates for messages added since); at `COMPACT_AT` of the window
  (the smaller of `num_ctx` and the loaded model's) older messages are replaced by a summary the model writes in a request
  shaped like the real ones (same tools and options, so the KV cache is reused). The latest user prompt is repeated word for
  word, and `readFiles` is cleared so edits need a fresh Read. Also on demand (`compact` client message).
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
- `server/tools.ts`: Read / Write / Edit / Bash (PowerShell on Windows) / Glob / Grep / LS. Names and parameters follow
  Claude Code's tools so models use them naturally and `autoApprove.ts` classifies them unchanged. `validate` runs before
  the permission prompt so the user isn't asked about calls that would fail anyway (e.g. Edit without a prior Read).
- `server/permissions.ts`: `gate()` decides allow / ask / deny per permission mode; `assess()` adds the classifier decision and,
  for git init/add/commit/push, the security scan. git init/add/commit/push always ask, even in `bypassPermissions`.
- `server/autoApprove.ts`, `server/shellParse.ts`, `server/secretScan.ts`: taken from custom-harnes. Policy: allowlist only.
  When you change the rules, add cases to `server/autoApprove.test.ts`, and never loosen a rule without a test.
  Test fixtures must build fake secrets by string concatenation.
- `server/store.ts`: sessions as `<HARNESS_DATA_DIR>/sessions/<uuid>.jsonl` (`meta` / `message` / `result` / `compact` records).
  `message` records are exactly what was sent to Ollama, so resuming replays them as-is; a `compact` record holds the whole
  conversation after compaction and replaces everything before it. `toEvents` turns records into GUI events (full history).
- `server/web.ts`: WebSearch / WebFetch, offered only when the session's web setting is on (default off). Searches go to
  a local SearXNG (`npm run searxng` → `scripts/searxng.ts`, Docker via OrbStack, 127.0.0.1:38730, JSON format enabled);
  WebFetch never reaches this machine or the LAN (`checkUrl` plus a `lookup` that refuses private addresses at connect
  time, re-checked on every redirect). Queries and URLs carrying a secret (`findSecret`) are refused before sending.
- `server/systemPrompt.ts`: environment, working rules, plan-mode rules, web rules, and the working folder's `AGENTS.md` / `CLAUDE.md`.
- `shared/i18n/`: every GUI text, in catalogs per language (`ja.ts` is the source; English and Chinese are planned).
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

## Rules

- Keep the server bound to `127.0.0.1` and keep the WebSocket Origin allowlist (`ALLOWED_ORIGINS` in `server/index.ts`).
  Any web page can reach localhost, so without the allowlist a malicious site could run commands through the agent.
- Anything the model asks to run goes through `gate()`; don't add a tool that bypasses it.
- Web access stays off by default, and WebFetch must never reach this machine or the LAN (keep `checkUrl` / `safeLookup` in
  `server/web.ts`): a prompt-injected page could otherwise make the agent call Ollama, this harness or the router.
- When you are unsure of an Ollama response shape, check it against the real server (`curl http://127.0.0.1:11434/api/chat ...`). Don't guess.
- Local models have small contexts: cap tool output (`MAX_OUTPUT_CHARS`) and keep tool descriptions short and direct.
- GUI text goes in the `shared/i18n` catalogs, never directly in code (`server/i18n.test.ts` fails otherwise); add keys
  to `ja.ts` first. Text for the model (system prompt, tool results) stays in English. Server logs may stay Japanese.
