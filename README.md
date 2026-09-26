# Local LLM Harness

English | [日本語](README.ja.md)

[![CI](https://github.com/moooyooo/local-llm-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/moooyooo/local-llm-harness/actions/workflows/ci.yml)

A local-only web GUI that runs **local LLMs served by [Ollama](https://ollama.com)** as a coding agent.
Its UX follows the author's (private) web GUI for Claude Code.

Instead of driving a CLI, the server runs its own agent loop against Ollama's `/api/chat` (tool calling) to read and edit
files and run commands. Everything stays on your machine, unless you turn web search on.

- Tested on macOS (Apple silicon) with Ollama 0.32 and 0.34. Windows (with PowerShell as the shell) is supported by design but untested.
- **UI language: Japanese for now; English and Chinese are planned.** All UI text lives in language catalogs, so a new
  language is a new catalog (see [Adding a language](#adding-a-language)). Until then, button names are quoted below with their meaning.

![A finished turn: the agent wrote fizzbuzz.py and its tests, ran them after asking, and summarized](docs/screenshot.jpg)

## Requirements

- Node.js 22 or later (uses `fs.glob`)
- A running [Ollama](https://ollama.com) (default: `http://127.0.0.1:11434`)
- A model that supports tool calling (e.g. `qwen3-coder:30b`, `qwen3.6:35b-a3b`, `gemma4`)
- Optional, for speed: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`; without it, Grep falls back to JavaScript)
- For web search: Docker (e.g. [OrbStack](https://orbstack.dev)), to run [SearXNG](https://github.com/searxng/searxng) locally

## Usage

```sh
git clone https://github.com/moooyooo/local-llm-harness.git
cd local-llm-harness
npm install
npm run dev        # development: http://localhost:38722
# or
npm run build
npm start          # production: http://localhost:38720
```

1. In the left panel, choose the working folder, model, thinking, context length and permission mode.
2. Press 「開始」 (Start) and send a message.
3. Before a file edit or a command, the GUI asks 「許可 / 拒否」 (Allow / Deny); edits are shown as diffs.

<img src="docs/screenshot-permission.jpg" alt="The agent asks before running a command" width="720">

### Web search setup (optional)

```sh
brew install --cask orbstack   # Docker runtime (open OrbStack once to finish its setup)
npm run searxng                # start SearXNG (creates its settings and container the first time; listens on 127.0.0.1:38730 only)
npm run searxng -- stop        # stop (or: status)
```

Check 「Web 検索（SearXNG）」 (web search) in the left panel to let that tab's model use WebSearch / WebFetch (off by default).

### Always on: start production at login (macOS)

| | Command |
| --- | --- |
| Register and start now | `scripts/mac/autostart.sh install` |
| Rebuild and restart after changing the harness | `scripts/mac/autostart.sh restart` |
| Show status | `scripts/mac/autostart.sh status` |
| Unregister (also stops production) | `scripts/mac/autostart.sh uninstall` |
| Start if needed and open in the browser | `scripts/mac/start-harness.sh` |

- A LaunchAgent (`~/Library/LaunchAgents/com.moooyooo.custom-harnes-local-llm.plist`) starts http://localhost:38720 at login and restarts it if it crashes.
  macOS reports a new background item the first time; turn it off under System Settings > General > Login Items to stop it from starting.
- So that the agent can run git, npm, docker and so on, `install` captures the PATH, SHELL and LANG of the terminal it runs in.
  Run `install` again after installing new commands, moving the folder or reinstalling node.
- Production is rebuilt into `dist-prod/` on every start and served from there, so `npm run build` during development never changes it.
- Logs go to `logs/harness.log`. Don't use `npm start` while it is registered (both would want the same port).
- There is no autostart for Windows yet.

## Features

Basics:

- Streaming responses (Markdown). Thinking (reasoning) is shown live and folded when done
- Collapsible tool calls and results
- Permission prompts in the GUI
- Interrupt, stop, and resume by session ID
- Several sessions side by side in tabs (each shows its folder and state); an inbox for every tab's pending permissions
- Auto-approval (turn it on in the left panel): answers prompts that can't affect the host.
  Writes outside the working folder, deletions, git push, global installs, admin rights, process control and so on still ask
  (rules in `server/autoApprove.ts`)
- A security check right before git init/add/commit/push, whatever the auto-approval and permission mode.
  It finds API keys, tokens, private keys, connection strings with passwords, .env files, certificates, folders that belong in
  .gitignore and large files; if anything is found, the prompt lists it and is never auto-approved
- Browser notifications for finished turns and permission prompts (only when the page is in the background or another tab is active)
- Recent working folders on the start screen, to start a new session there or resume an earlier one
- Session history (date, model, prompts); click to resume, with the past conversation shown

For local LLMs:

- **Ready for more languages**: all UI text is in per-language catalogs (Japanese now; English and Chinese planned)

- **Model picker** listing installed models with their tool / thinking / vision support, size and maximum context length
- **Thinking** (default / on / off / low · medium · high) and **context length** (`num_ctx`)
- **Context usage meter and generation speed** (tok/s)
- **Ollama connection state and loaded models**
- Permission modes: `default` / `acceptEdits` / `plan` (read-only, makes a plan) / `bypassPermissions`
- The working folder's `AGENTS.md` / `CLAUDE.md` are read into the system prompt as project instructions
- Guards against typical local-model failures: repeated identical tool calls are stopped, no Edit or overwrite without a prior Read,
  no prompt for a call that would fail anyway, tool output is capped
- Keeping long tasks going:
  - the model is told to write large files about 200 lines at a time
  - each reply is capped at 16,384 tokens; a cut-off reply is retried once with a request to work in smaller steps
  - the connection stays open while the model writes a tool call (Ollama streams nothing meanwhile), and the time since the last output is shown
  - after an error, an interrupt or a limit, 「続きから再開」 (continue) has the model check the working folder and carry on
  - closing or reloading the page doesn't stop a session: the turn goes on, and the tab shows it again when the page
    comes back (open tabs are remembered in the browser). A session no page shows is stopped after 30 minutes without a turn running
- **Image input** (vision models): paste a screenshot from the clipboard, drag and drop, or use the 「画像」 (image) button.
  Images are scaled to at most 1600 px (about 1,500 tokens each). After switching to a model without vision, earlier images become a note
- **Settings between turns**: in a started tab, changing the model, thinking, context length, permission mode or web search applies from the next message
- **Context compaction**: near 80% of the context window, older messages are replaced by a summary the model writes
  (Ollama silently drops the oldest part of an oversized prompt). The newest messages and the latest request are kept word for word.
  「会話を要約」 (summarize) does it on demand, and the summary can be opened in the transcript
- **Web search** (off by default): searches through a local SearXNG and reads pages as plain text.
  Page fetches never reach this machine or the LAN, and queries or URLs that look like they carry a secret are not sent
- **Checkpoints**: the working folder's files are recorded before each message (and every 10 file-changing tool calls
  in a long turn). Each checkpoint in the transcript shows what changed since, file by file with diffs, and
  「ここに戻す」 (restore) puts the files back after a confirmation. The state before a restore is recorded too, so a
  restore can be undone, and the model is told about it. Checkpoints live in a git repository of the harness's own
  (`checkpoints/` in the data folder); the folder's own `.git` is never touched and the folder need not be a git
  repository. Left out: files in `.gitignore`, dependency folders, git repositories inside the folder and files over
  20 MB. Changes outside the folder (installs, pushes) can't be undone. Needs `git`

### Tools the agent can use

| Tool | What it does | Asks in `default` mode |
| --- | --- | --- |
| Read / Glob / Grep / LS | Read and search | Not inside the working folder (outside, or credentials: asks) |
| Write / Edit | Create, overwrite or patch files | Yes (`acceptEdits`: not inside the working folder) |
| Bash (PowerShell on Windows) | Run commands (2-minute default timeout) | Yes |
| WebSearch / WebFetch (only with web search on) | Search via SearXNG, read web pages (never this machine or the LAN) | Yes (eligible for auto-approval) |

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | production `38720` / development `38721` | Server port (defaults in `shared/ports.ts`) |
| `HARNESS_CWD` | the folder the server starts in | Default working folder |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama URL |
| `HARNESS_DATA_DIR` | `~/.custom-harnes-local` | Session history (`sessions/<id>.jsonl`), checkpoints (`checkpoints/`, unused ones deleted after 30 days) and SearXNG settings (`searxng/`) |
| `SEARXNG_URL` | `http://127.0.0.1:38730` | SearXNG used by WebSearch |
| `HARNESS_FEATURES` | none | Experimental switches to turn on, comma-separated, or `all` (see below) |

### Experimental switches

Changes meant to help local models finish long tasks, off until measurements show they help (`scripts/eval`).
Turn them on with `HARNESS_FEATURES`, e.g. `HARNESS_FEATURES=fuzzyEdit,todoList npm start`.

| Switch | What it does |
| --- | --- |
| `fuzzyEdit` | An Edit whose `old_string` differs from the file only in whitespace or indentation is applied when it matches one place only; when nothing matches, the most similar lines are shown |
| `failureAdvice` | After several failed tool calls in a row, or repeated failed Edits of one file, the tool result asks the model to rethink |
| `loopDetection` | A reply stuck repeating the same passage is stopped and retried once |
| `outputLimit` | Each reply is capped at what the context window has left (past it, Ollama silently drops the start of the conversation); with thinking on, compaction starts at 65% of the window |
| `trimOutputs` | Before summarizing, old tool outputs are replaced with a short note |
| `todoList` | The model keeps a checklist of the task's steps (TodoWrite, shown beside the session), sees it again every 10 tool calls, and gets one reminder when it stops with items left |

## Tips

- Loading a model takes a few to several tens of seconds; loaded models are listed at the bottom left
- Use a context length of 32K or more for long tasks. If Ollama has the model loaded with a smaller window, the harness frees it so it
  loads again with yours (Ollama doesn't reload MLX models for a larger `num_ctx` by itself). Reloading takes some tens of seconds
- Turning thinking off is faster, but hard tasks suffer
- MoE models (`qwen3-coder:30b`, `qwen3.6:35b-a3b`, ...) are fast and suit interactive work

## Cautions

- Built for personal use on your own machine. Don't expose it to the network
- The agent edits files and runs commands on your machine
- The server listens on `127.0.0.1` only, and the WebSocket accepts only its own origins
- Local models make more mistakes than top cloud models. Use `bypassPermissions` and auto-approval only when you understand what they allow
- With web search on, queries and fetched URLs leave your machine
- Closing the page does not stop a running task. To stop one, use 「停止」 (stop) or close its tab (×)

## Adding a language

All text the GUI shows lives in `shared/i18n/`. Japanese (`ja.ts`) is the source: it defines the message keys, and fills in
whatever a translation hasn't covered yet, so a partial translation already works.

1. Copy `shared/i18n/ja.ts` to e.g. `shared/i18n/en.ts`, rename the export to `en`, type it `Catalog`, and translate the values.
   Keep every `{placeholder}`.
2. Register it in `LOCALES` in `shared/i18n/index.ts`, with the name to show (e.g. `en: { name: 'English', messages: en }`).
   The GUI then picks it for browsers set to that language, and shows a language picker in the left panel.
3. Run `npm test`: it checks that each catalog uses only known keys with the same placeholders, and fails if GUI text is
   written directly in the code instead of the catalogs.

The server sends messages as keys with values rather than finished sentences, so saved history is shown in the current
language too. Output meant for whoever runs the harness (server logs, `scripts/`) is not translated yet.

## License

[MIT](LICENSE)
