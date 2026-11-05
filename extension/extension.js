// VS Code extension host: paper discovery, commands and the review panel.
const vscode = require("vscode");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { openReview, closeAll } = require("./review-panel");

const APP = path.join(__dirname, "..", "app");
let output = null;

function load(rel) { return import(pathToFileURL(path.join(APP, rel)).href); }

function report(error) {
  const message = error instanceof Error ? error.message : String(error);
  output?.appendLine(`[error] ${message}\n${error instanceof Error ? error.stack || "" : ""}`);
  vscode.window.showErrorMessage(`Manuscript Review: ${message}`, "Show Output").then((pick) => {
    if (pick === "Show Output") output?.show(true);
  });
}

async function chooseFolder() {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "Open Paper Folder",
  });
  return picked?.[0];
}

async function chooseWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 1) return folders[0].uri;
  if (folders.length > 1) {
    const pick = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, description: f.uri.fsPath, uri: f.uri })),
      { placeHolder: "Choose the workspace folder that contains your papers" },
    );
    return pick?.uri;
  }
  return chooseFolder();
}

async function listPapers(root) {
  const { findMains } = await load("core/open.mjs");
  const sub = vscode.workspace.getConfiguration("manuscriptReview").get("papersSubfolder", "Papers");
  const base = sub ? path.join(root, sub) : root;
  const papers = [];
  const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const mains = await findMains(dir).catch(() => []);
    if (mains.length) papers.push({ dir, name: entry.name, mains });
  }
  if (!papers.length) {
    const mains = await findMains(root).catch(() => []);
    if (mains.length) papers.push({ dir: root, name: path.basename(root), mains });
  }
  return papers.sort((a, b) => a.name.localeCompare(b.name));
}

async function pickMain(dir, preferred) {
  const { findMains, inferMain } = await load("core/open.mjs");
  const mains = await findMains(dir);
  if (!mains.length) throw new Error(`No main .tex file (with \\documentclass) found in ${dir}.`);
  if (preferred && mains.includes(preferred)) return preferred;
  try {
    const remembered = await inferMain(dir);
    if (remembered.main && remembered.source === "saved") return remembered.main;
  } catch { /* several candidates and no saved choice */ }
  if (mains.length === 1) return mains[0];
  const pick = await vscode.window.showQuickPick(mains, { placeHolder: "Choose the main .tex file" });
  if (!pick) return null;
  return pick;
}

async function openTarget(context, target, preferredMain = null) {
  let dir = null;
  let preferred = preferredMain;
  if (target?.scheme === "file") {
    const stat = await fsp.stat(target.fsPath).catch(() => null);
    if (stat?.isDirectory()) dir = target.fsPath;
    else if (stat?.isFile()) { dir = path.dirname(target.fsPath); if (target.fsPath.toLowerCase().endsWith(".tex")) preferred = path.basename(target.fsPath); }
  }

  if (!dir) {
    const rootUri = await chooseWorkspaceRoot();
    if (!rootUri) return;
    const papers = await listPapers(rootUri.fsPath);
    if (!papers.length) {
      vscode.window.showInformationMessage("No papers found. Set manuscriptReview.papersSubfolder or open a paper folder directly.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      papers.map((p) => ({ label: p.name, description: path.relative(rootUri.fsPath, p.dir) || ".", paper: p })),
      { placeHolder: "Choose a paper" },
    );
    if (!pick) return;
    dir = pick.paper.dir;
  }

  const main = await pickMain(dir, preferred);
  if (!main) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Opening ${path.basename(dir)}…` }, () => openReview(context, dir, main));
  await context.globalState.update("manuscriptReview.lastPaper", { dir, main });
}

async function runDoctor() {
  output = output || vscode.window.createOutputChannel("Manuscript Review");
  output.show(true);
  output.appendLine(`Manuscript Review ${require("../package.json").version}`);
  output.appendLine(`VS Code ${vscode.version} · ${process.platform} ${process.arch} · remote=${vscode.env.remoteName || "none"}`);
  const { toolsDir } = await load("core/store.mjs");
  output.appendLine(`Tools/state: ${toolsDir()}`);

  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { shell: process.platform === "win32", timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
      resolve(error ? null : `${stdout || ""}${stderr || ""}`.trim().split("\n")[0]);
    });
  });
  const git = await run("git", ["--version"]);
  output.appendLine(`${git ? "ok  " : "FAIL"} git       ${git || "not found"}`);
  const latexmk = await run("latexmk", ["-v"]);
  output.appendLine(`${latexmk ? "ok  " : "warn"} latexmk   ${latexmk || "not found (PDF previews unavailable)"}`);
  const { detectAgents } = await load("core/agents.mjs");
  const agents = await detectAgents(true);
  if (!agents.length) output.appendLine("info agents    none detected");
  for (const agent of agents) output.appendLine(`${agent.found ? "ok  " : "warn"} agent     ${agent.id} ${agent.found ? `${agent.version || ""} auth=${agent.auth || "?"}` : "not found"}${agent.note ? ` (${agent.note})` : ""}`);
}

function activate(context) {
  output = vscode.window.createOutputChannel("Manuscript Review");
  context.subscriptions.push(output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(book) Review";
  status.tooltip = "Open a manuscript review";
  status.command = "manuscriptReview.open";
  status.show();
  context.subscriptions.push(status);

  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, (...args) => Promise.resolve(fn(...args)).catch(report)));
  register("manuscriptReview.open", () => openTarget(context));
  register("manuscriptReview.openFolder", async () => { const uri = await chooseFolder(); if (uri) await openTarget(context, uri); });
  register("manuscriptReview.openCurrent", async (uri) => {
    const target = uri || vscode.window.activeTextEditor?.document.uri;
    if (!target) return openTarget(context);
    return openTarget(context, target);
  });
  register("manuscriptReview.reopenLast", async () => {
    const last = context.globalState.get("manuscriptReview.lastPaper");
    if (!last) return vscode.window.showInformationMessage("No paper has been opened yet.");
    return openTarget(context, vscode.Uri.file(last.dir), last.main);
  });
  register("manuscriptReview.doctor", runDoctor);
}

function deactivate() { return closeAll(); }

module.exports = { activate, deactivate };
