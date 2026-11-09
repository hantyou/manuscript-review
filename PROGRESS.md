# Progress

## 2026-11-09 — OpenCode adapter

- Added an `opencode` entry to `ADAPTERS` in `app/core/agents.mjs`: `opencode run --format json --agent plan --dir <scratch>` with the prompt on stdin, plus `OPENCODE_PERMISSION={"*":"deny"}`, `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_DB=:memory:`. The parser reads the JSONL events (`text`, `error`, `step_finish`); cancellation, timeouts and error reporting reuse the existing runner, which now accepts an adapter `env`.
- Detection runs `--version`, `auth list` (credential count), `models` (dropdown, grouped by provider in `app/public/app.js`) and `debug config` (the configured default model, for the Default entry's label). No sign-in is still usable when free models are listed.
- Verified against OpenCode 1.19.5 here: a live synthetic session run returned a proposal that applied to the custom candidate, manuscript untouched, scratch folder left empty, ~12 s. The error path (unreachable default model) surfaces the API message. 29 tests pass, 14 of them new in `app/tests/agents.test.mjs` (args, permissions, event parsing, detection, and stdin/cancel/timeout/error through a stand-in CLI on PATH); `npm run check` is clean.
- Known limits: 1.19.5 `step_finish` carries no provider/model, so the message header shows the model you picked; a reply arrives as whole text parts rather than token by token; with no model chosen, OpenCode's own default is used, and on this machine that default is a stopped local Ollama, which retries for ~70 s before failing.
- Packaged and installed 0.1.7 locally. Marketplace publishing still needs refreshed publisher credentials; nothing has been published to the Marketplace.

## 2026-11-09 — AI panel layout

- Reduced crowding by moving agent/model settings and prompt suggestions into dismissible menus, collapsing passage details, and keeping a compact composer below a larger conversation area.
- Added passage-specific drafts for the current session, Ctrl/Cmd+Enter, duplicate-submit protection, and guards against showing another passage's replies after switching cards.
- Verified the shared browser/webview UI in Chrome at desktop and narrow sizes in light/dark themes, including model selection, suggestions, drafts, send failures, comments, and missing agents. Syntax checks and the existing test suite pass.
- Packaged and installed 0.1.6 locally, including the earlier toolbar/status-bar icons. Reload VS Code to use it. Marketplace publishing still needs refreshed publisher credentials; no Marketplace update has been published.
