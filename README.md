# Manuscript Review

A VS Code extension for reviewing revisions to a LaTeX manuscript. It shows the
original and the proposed wording side by side, lets you edit either, discuss a
passage with a local AI agent, and writes only the wording you choose back to the
manuscript.

The manuscript is one continuous article. Every change appears in place, between
its surrounding paragraphs, as a comparison card, so transitions and repeated
words are easy to judge. Nothing is written to the paper until you press
**Apply reviewed changes**.

## Requirements

- VS Code 1.90 or newer.
- Git, for the frozen baseline and the diff against it.
- Optional: `latexmk` and a LaTeX distribution for PDF previews.
- Optional: a supported AI agent CLI, signed in on the machine where the
  manuscript lives. The extension never stores credentials.

## Install

From the Marketplace: search for **Manuscript Review** and install it.

Without the Marketplace, download the `.vsix` from the GitHub releases page and
run `code --install-extension manuscript-review-<version>.vsix`.

## Use

1. Open the folder that contains your papers in VS Code.
2. Run **Manuscript Review: Open Paper** from the Command Palette, or use the
   **Open Current Paper** action on a `.tex` file or folder in the Explorer.
3. If the folder contains several entry points, choose the main `.tex` file.
4. Review the cards, ask the AI panel about a passage, and apply the decisions.

The extension also works with **Remote SSH**, **WSL** and **Dev Containers**.
The extension host and the manuscript live in the same environment, so Git,
`latexmk` and the agent CLI run where the files are; only the webview is shown
locally.

### Review screen

- **Outline** (left): headings with the number still pending, search, status
  filters and **Next pending**.
- **Compare / Read result**: compare every change, or read the article as it
  stands with the wording chosen so far.
- **Comparison card**: original wording on the left, proposed wording on the
  right, with word-level highlights. Decide, edit or ask the AI about it.
  **Use original** / **Use proposed** collapse the card to inline text; the
  collapse button hides a card without deciding, and clicking inline text
  reopens it.
- **AI panel** (right): ask about the selected passage and turn a proposal into
  an edit of either candidate. Expand the agent/model row for settings and writing
  instructions, or **Suggestions** for a starting prompt. Expand the passage
  heading to see its source and excerpt. Draft messages stay with their passage
  while you switch between cards; **Ctrl+Enter** / **Cmd+Enter** sends.
- **PDF previews**: tracked or clean, from the current files or with your
  decisions applied. Built in the tool's staging folder with `latexmk`.
- **Apply reviewed changes**: preview the patch, choose clean or tracked output,
  apply. A checkpoint is saved first and can be undone. Tracked output uses the
  LaTeX `changes` package commands `\added`, `\deleted` and `\replaced`;
  clean PDF builds pass the package's `final` option.

Keyboard: `j` / `k` or `Alt+↓` / `Alt+↑` next or previous pending change,
`/` search, `Esc` closes dialogs.

Saves you make to the paper in your editor are folded into the open review
automatically: cards, counts, citations and the conversation follow within about
two seconds, without pressing **Rescan sources**. The watcher pauses while the
tool itself writes an apply or undo, and while a card edit or dialog is open.

When external edits make several cards report **Source changed**, the top bar
shows **Update all from source (N)**: one click copies the wording now in the
file into all N cards, instead of using each card's button.

### Supported AI agents

The panel uses whichever of these CLIs is installed and signed in on the machine
that holds the manuscript:

| Agent | State |
|---|---|
| Claude Code (`claude`) | Verified; streams its reply. |
| OpenCode (`opencode`) | Verified. The model list comes from `opencode models`, and **Default** uses the model in your OpenCode config. |
| Codex CLI (`codex`) | Written from its documented flags; no reply was obtained on the machine where it was tried. |
| Gemini CLI, CodeBuddy, `agy` | Detected only, no adapter. |

Every agent runs read-only in a scratch folder inside the tool's state directory:
the prompt arrives on stdin, file-editing tools are switched off, and the
manuscript is not in that folder. OpenCode additionally runs its `plan` agent with
every tool denied (`OPENCODE_PERMISSION`), ignores project-level config, and uses
an in-memory session database, so a review leaves no session in your OpenCode
history. Credentials stay with each CLI; the extension never reads or stores them.

### Using the LaTeX changes package

The tracked output is meant for the [changes](https://ctan.org/pkg/changes)
package. Add it to the paper and remove any custom definitions of these
commands:

```latex
\usepackage{changes}
\definechangesauthor[name={Your Name}, color=blue]{yourid}
```

In the review panel, use the **Reviewer** selector in the top bar (or
**State → Tracked-changes author**) to switch between the authors declared in
the paper. The choice is remembered per paper, so you do not need to change a
setting each time.

`manuscriptReview.changesAuthor` is the default for a paper that has no saved
choice. The CLI also accepts `MR_CHANGES_AUTHOR` / `--changes-author yourid`.
The tool then writes `\added[id=yourid]{...}`, `\deleted[id=yourid]{...}` and
`\replaced[id=yourid]{...}{...}`. With no author ID it omits the optional
argument, which is also valid for the package.

The **Clean** PDF preview no longer needs a custom `\ifdefined...Clean`
switch: when the paper loads `changes`, the tool passes `final` to the package
so the clean build hides all tracked changes.

## Settings

| Setting | Meaning |
|---|---|
| `manuscriptReview.papersSubfolder` | Subfolder with one folder per paper. Default `Papers`. Leave empty when the workspace root itself is a paper. |
| `manuscriptReview.profilesFolder` | Optional folder containing `<paper-name>.md` writing instructions for the AI. |
| `manuscriptReview.changesAuthor` | Default author ID from `\definechangesauthor`. The in-panel **Reviewer** selector overrides it per paper. Leave empty to omit the optional ID by default. |

## Where data lives

Review state, chats, snapshots, checkpoints and PDF staging are stored outside
every paper repository:

- Linux: `~/.local/share/manuscript-review/`
- Windows: `%LOCALAPPDATA%\manuscript-review\`
- macOS: `~/Library/Application Support/manuscript-review/`

Set `MR_TOOLS_DIR` to move it elsewhere. The paper is only modified by the
**Apply** action. Credentials are never stored by this extension; each agent CLI
keeps its own sign-in.

## Privacy

The extension does not send manuscript content anywhere by itself. If you use the
AI panel, the selected agent CLI runs locally and sends the prompt to the
provider configured for that CLI. No paper data or local paths are part of the
extension package or the public repository.

## Development

```sh
git clone https://github.com/hantyou/manuscript-review.git
cd manuscript-review
npm test
npm run check
npx --yes @vscode/vsce package
```

Open the folder in VS Code and press `F5` for an Extension Development Host.

The optional browser UI is still available:

```sh
node app/cli.mjs open <paper-folder>
```

It serves the same interface on `127.0.0.1` and opens it in your browser.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`. KaTeX is bundled under its MIT
license in `media/katex/`.
