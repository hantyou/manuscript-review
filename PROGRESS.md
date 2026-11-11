# Progress

## 2026-11-11 — VS Code: spawn EINVAL when opening the panel

- Fixed the review panel failing with `Could not start: spawn EINVAL` on Windows in the VS Code extension host. npm-installed agent CLIs resolve to `.cmd` shims, and Node throws `EINVAL` synchronously when such a shim is spawned without a shell (CVE-2024-27980). The `exec` helper now passes `shell: true` for `.cmd`/`.bat` and converts a synchronous throw into a failed probe, so agent detection can no longer abort `GET /agents`; `startRun` uses the same rule.
- 44 tests pass (`sync.test.mjs` needed a rerun for one pre-existing timing flake) and `npm run check` is clean. Also patched the locally installed 0.1.10 copy under `~/.vscode/extensions`; reload the VS Code window to pick it up.

## 2026-11-11 — Stale applied state on duplicate units

- Reported against `Papers/JVer_DOGM/root.tex:545`: a card showed **Applied** with disabled actions while `\replaced{0}{1}` was still in the source. A clean apply had cleaned three other identical occurrence units; when those disappeared, the surviving occurrence was rescanned as `u_80ae308142` and `syncUnits` matched it by ID to the applied state, so `statusOf` kept returning applied.
- `syncUnits` now clears `applied` when a fresh scan still finds a unit that was applied in clean mode (tracked applies legitimately remain in the source). Manual units are left alone. Added two regression tests; 46 tests pass and `npm run check` is clean.
- Not packaged or version-bumped; restart the local server/extension to load the fix. Next: verify the affected card reopens as pending or decided after reload.

## 2026-11-10 — Save reading-view improvements

- Prepared the existing math/TikZ rendering and comment-handling changes,
  documentation, tests and version 0.1.12 for the author-requested commit and
  push on `main`. Reran all 44 tests and `npm run check`; both pass, and
  `git diff --check` is clean. No release tag or Marketplace publish requested.
  Next: continue testing the reading view against manuscript sources.

## 2026-11-10 — Comments stay out of the reading view

- LaTeX comments were rendered as grey text in article paragraphs (for example the commented-out PSI remark after `root.tex:340`), because `renderTex` emitted a `tex-comment` span. It now skips from `%` to the line end, so comments never reach the reading view, cards, diffs or AI passages.
- `flatten` now removes comments from its result (escaped `\%` is preserved), so a comment inside `\replaced{...}` or another markup argument can no longer become wording or part of an applied patch. `flatten` without markup also strips them.
- Added two regression tests (44 total) and `npm run check` is clean. Version 0.1.12 packaged as `manuscript-review-0.1.12.vsix` and installed locally.

## 2026-11-10 — Natural math and TikZ display

- Fixed equations that fell back to raw source: `\label`, TeX conditional switches and tracked-change macros are resolved before KaTeX, and display-only paragraphs now read as math instead of read-only LaTeX blocks. Wide equations scroll inside the article.
- Added a TikZ pipeline: `app/core/tikz.mjs` wraps the picture in `standalone` with the paper's own preamble, compiles with `pdflatex` (or `lualatex`), converts to SVG with `pdftocairo`/`dvisvgm`, and caches by content hash. The server exposes `GET /api/tikz/<key>.svg`; the UI reserves the SVG aspect ratio, loads near the viewport, and fades the figure in over a skeleton. Captions are typeset with KaTeX and the LaTeX source sits behind a disclosure.
- Blank lines inside figures, tables and TikZ pictures no longer split them into several auxiliary blocks, and leading comments no longer hide a figure from the auxiliary-block path. Commented-out caption text is excluded.
- Inline math is no longer drawn inside a box: the baseline detail rule now targets `details.base` instead of KaTeX's internal `span.base`. KaTeX fonts are preloaded so math settles without a visible swap.
- `sentenceRanges` no longer ends a sentence at a period inside a display equation, which had split `\begin{equation}` from `\end{equation}` and exposed the source plus a `\label` anchor. Labels are now invisible in the reading view. The article view also merges a split display equation with its trailing `\end{...}` piece, so a panel reload fixes the view even while an older backend process is still running.
- 42 tests pass and `npm run check` is clean. Version 0.1.11 packaged and installed locally as `manuscript-review-0.1.11.vsix`.

## 2026-11-10 — Deleted wording stays visible

- Reproduced the report against `Papers/JVer_DOGM/root.tex:282`: the `\deleted` sentence was scanned and shown in an expanded Compare card, but the inline/collapsed and **Read result** views fell back to "(removed)" because a deletion has no proposed text. Inline units now render the removed wording struck through (new `.u-gone` style, still following the Plain toggle's background rule) with a tooltip, so all three change types stay visible.
- Fixed IEEEtran reference numbers: `\newlabel` values wrapped as `\mbox  {III-B}` were truncated by the old aux regex and printed literally. Labels are now read with brace-depth matching, and `renderTex` unwraps `\mbox {…}`; the deletion example reads "Section III-B".
- Added a scan/article regression test covering `\added`, `\deleted` and `\replaced` as separate unit kinds and a deletion-only paragraph staying in the reading flow. 36 tests pass; `npm run check` is clean.
- Version 0.1.10. Packaged and installed locally. Committed, pushed and tagged; the release workflow produced [v0.1.10](https://github.com/hantyou/manuscript-review/releases/tag/v0.1.10) with `manuscript-review.vsix` attached. The Marketplace step still skips because `VSCE_PAT` is missing; run `npx @vscode/vsce login hantyou` with a Marketplace PAT, then `npm run publish`.

## 2026-11-10 — Bulk source refresh

- Added **Update all from source (N)** to the top bar. It appears only when at least one card is marked source changed, and copies the current file wording into every such card through the new `Session.takeSourceAll()` and `POST /api/units/take-source-all`.
- The single-card **Source changed. Use it** path is unchanged. The button count refreshes after loads, rescans and individual source updates.
- New test in `app/tests/sync.test.mjs` updates two `\replaced` units after an external save and confirms a second click has nothing to do; 35 tests pass and `npm run check` is clean.
- Version 0.1.9. Packaged, installed locally, committed and pushed. Tag `v0.1.9` produced the GitHub release [v0.1.9](https://github.com/hantyou/manuscript-review/releases/tag/v0.1.9) with `manuscript-review.vsix` attached; the release workflow's Marketplace step skipped because `VSCE_PAT` is still missing in the repo secrets. For the Marketplace, run `npx @vscode/vsce login hantyou` with a Marketplace PAT, then `npm run publish`.

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
