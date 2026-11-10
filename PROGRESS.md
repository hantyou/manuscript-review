# Progress

## 2026-11-10 — Bulk source refresh

- Added **Update all from source (N)** to the top bar. It appears only when at least one card is marked source changed, and copies the current file wording into every such card through the new `Session.takeSourceAll()` and `POST /api/units/take-source-all`.
- The single-card **Source changed. Use it** path is unchanged. The button count refreshes after loads, rescans and individual source updates.
- New test in `app/tests/sync.test.mjs` updates two `\replaced` units after an external save and confirms a second click has nothing to do; 35 tests pass and `npm run check` is clean.
- Version 0.1.9. Packaged, installed locally, committed and pushed. The Marketplace publish failed: no `VSCE_PAT` is set, `~/.vsce` has no publisher token, and the `--azure-credential` fallback has no Azure CLI or Entra credentials in this environment. Next: run `npx @vscode/vsce login hantyou` with a Marketplace PAT, then `npm run publish`.

## 2026-11-09 — Automatic source sync

- Added `app/core/watch.mjs`: a hash-based poller (1.5 s) around `session.externalChanges()` that rescans when a scanned `.tex` file or a referenced `.bib` / main `.aux` changes. It starts and stops with the local server, so the VS Code panel and the browser UI use the same path. The first look is only a baseline, so opening a paper never triggers a spurious reload.
- `Session.rescan(first, info)` now tags the existing `scan` event (`auto`, `files`); the watcher is held off by a `writing` guard that stays up through the post-apply/undo rescan, so the tool never races its own writes. The client (`app/public/app.js`) reloads project + article + active card on `scan` events with `auto`, keeps the current card, defers while a card edit or dialog is open, and notes at most one update per 4 s.
- Tests: new `app/tests/sync.test.mjs` (5 tests: change/no-change, write guard, bib/aux detection, timer start/stop, real session + external save), 34 in total, all passing. Live wiring check against the real HTTP server: an external save produced `{"type":"scan","auto":true,"files":["root.tex"]}` after ~1.5 s and `/api/article` returned the new text.
- Packaged and installed 0.1.8 locally. Version 0.1.7 was committed, pushed, and released on GitHub with the VSIX; the Marketplace publish was skipped by CI because the repo has no `VSCE_PAT` secret, so 0.1.7 is still not on the Marketplace.

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
