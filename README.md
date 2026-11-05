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
- **AI panel** (right): choose the agent and model, ask a question, and turn a
  proposal into an edit of either candidate.
- **PDF previews**: tracked or clean, from the current files or with your
  decisions applied. Built in the tool's staging folder with `latexmk`.
- **Apply reviewed changes**: preview the patch, choose clean or tracked output,
  apply. A checkpoint is saved first and can be undone.

Keyboard: `j` / `k` or `Alt+↓` / `Alt+↑` next or previous pending change,
`/` search, `Esc` closes dialogs.

## Settings

| Setting | Meaning |
|---|---|
| `manuscriptReview.papersSubfolder` | Subfolder with one folder per paper. Default `Papers`. Leave empty when the workspace root itself is a paper. |
| `manuscriptReview.profilesFolder` | Optional folder containing `<paper-name>.md` writing instructions for the AI. |

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
