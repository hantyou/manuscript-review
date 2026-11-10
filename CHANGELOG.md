# Changelog

## 0.1.9

- Add **Update all from source**, which copies the wording now in the file into every card marked as source changed in one click.

## 0.1.8

- Re-read the paper when it is saved outside the tool, so cards, counts, citations and the open conversation follow within about two seconds.
- Pause that watcher while the tool writes an apply or undo, and defer the UI reload while a card edit or dialog is open.

## 0.1.7

- Add OpenCode as an AI source: detect its sign-in, list the models from `opencode models`, and label the entry for the model in your OpenCode config.
- Run OpenCode read-only (plan agent, every tool denied, project config ignored, in-memory session database) and turn its JSON events into replies and proposals.
- Group long model lists by provider in the model selector.

## 0.1.6

- Give AI conversations more space with collapsible settings, passage context, and prompt suggestions.
- Retain message drafts while switching passages and keep the composer visible in narrow windows.
- Replace the Open Current Paper toolbar label with a book icon.
- Make the status-bar review button icon-only, keeping its tooltip.

## 0.1.5

- Add a Reviewer selector to the review panel for switching the `changes` package author per paper.
- Remember the selected author per paper; the settings value is only the default.

## 0.1.4

- Use the LaTeX `changes` package for tracked output, including optional author IDs.
- Clean PDF builds pass the package `final` option, so a custom clean switch is no longer required.
- Add the `changesAuthor` setting and `--changes-author` / `MR_CHANGES_AUTHOR`.

## 0.1.3

- Collapse a change after choosing original or proposed wording.
- Add a collapse button to every comparison card; click the inline text to reopen it.

## 0.1.2

- Remove maintainer-only publishing notes from the Marketplace README.

## 0.1.1

- Register webview message handlers before the review UI loads, so the first requests are never lost.
- Remember the chosen main file when a paper is reopened.

## 0.1.0

- First VS Code release.
- Continuous article view with original and proposed wording side by side.
- Git baseline, review state, checkpoints and apply flow.
- AI panel backed by a locally installed agent CLI.
- PDF previews through `latexmk` when available.
- Remote, WSL and SSH support: the extension runs where the manuscript lives.
