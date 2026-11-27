# Changelog

## 0.1.18

- Keep a table, figure, algorithm or other structural environment out of the prose when it follows a lead-in sentence on the same paragraph: it becomes its own read-only block with its caption and source, instead of showing the whole environment as raw text.
- Recognise `tabularx` and `longtable` as table environments.
- Keep a short lead-in sentence as prose instead of treating it as a LaTeX fragment.

## 0.1.17

- Put a display equation into review with one click: hover it in the article and choose **Review this equation**. When the Git baseline has the same `\label`, its version fills the **Baseline equation** side, so the whole environment is compared as one block.
- Render both equations with KaTeX in the card and replace the whole environment on apply. Tracked mode writes equations as clean text, because `\added`, `\deleted` and `\replaced` cannot wrap a display environment.
- A reviewed equation is matched by `\label`, so editing its body keeps the same card; applying it and then editing it again reopens the card instead of staying **Applied**.

## 0.1.16

- Pick up a saved `.tex`, `.bib` or `.aux` file immediately in VS Code instead of waiting for the next poll; the 1.5 s hash poll stays as the fallback for other editors, network drives and lost events.
- Show the "sources changed" notice immediately even when an open card edit or dialog postpones the re-read, and say that the review will re-read the files once that closes.
- Fix a reload race where a save arriving during an in-flight re-read could be dropped.

## 0.1.15

- Detect `\added`, `\deleted` and `\replaced` inside sectioning commands such as `\subsection{\replaced{New title}{Old title}}`; they become review cards instead of silently showing only the new title.
- Keep the change in its heading block: Compare shows the comparison card directly below the heading, and **Read result** follows the chosen wording.

## 0.1.14

- Collapse top-bar labels to icons when the panel is narrow: **Compare** (side-by-side comparison), **Read result** (open book) and **Apply reviewed changes** (double check). Full labels return as soon as there is room, and tooltips plus accessible names keep the actions identifiable.

## 0.1.13

- Keep the top bar readable in narrow windows: controls wrap onto extra rows instead of squeezing, so **Compare**, **Read result** and **Apply reviewed changes** keep their full labels at any panel width. Secondary controls (progress, reading-mode chips, save time) drop out progressively as space runs out.
- Keep overlay panels (outline drawer, AI panel) aligned below the top bar when it wraps to several rows.
- Stop the outline drawer's **Previous** / **Next pending** buttons from clipping their labels.
- Let the article column use more of a wide editor window (cap raised from 980 px to 1200 px).

## 0.1.12

- Hide LaTeX comments in the reading view, cards and AI passages instead of showing them as text.

## 0.1.11

- Render display equations that carry `\label` or TeX conditionals instead of showing their source; standalone equations read as math, with wide lines scrollable inside the article.
- Render TikZ figures in place as SVG using the paper's own preamble, cached by content, with the caption typeset and the source behind a disclosure.
- Stop blank lines inside figures and tables from splitting them into several read-only blocks.
- Fix inline math being drawn inside a box: the baseline detail style no longer matches KaTeX's internal `.base` element.
- Keep a display equation that contains a sentence period in one piece, and hide `\label` anchors in the reading view. The article view also rejoins a split equation with its trailing `\end{...}` piece, so an already-running backend renders it after the panel reloads.
- Preload the KaTeX math fonts so equations settle without a visible font swap.

## 0.1.10

- Keep deleted-only wording visible in the inline article and in **Read result**: it is shown struck through instead of disappearing behind a "(removed)" placeholder.
- Show IEEEtran reference numbers such as **III-B** without the surrounding `\mbox {…}` markup.
- Cover `\added`, `\deleted` and `\replaced` detection and deletion-only paragraph placement in the test suite.

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
