// One review session backed by the shared app core, shown in a VS Code webview.
const vscode = require("vscode");
const path = require("node:path");
const fs = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { renderReviewHtml, renderPdfHtml } = require("./html");

const APP = path.join(__dirname, "..", "app");
const panels = new Map();
const sessions = new Set();

let corePromise = null;
function core() {
  if (!corePromise) {
    corePromise = (async () => {
      const load = (rel) => import(pathToFileURL(path.join(APP, rel)).href);
      const open = await load("core/open.mjs");
      const store = await load("core/store.mjs");
      return { ...open, ...store };
    })();
  }
  return corePromise;
}

function keyOf(proj) { return proj.id; }

function samePaper(dir, main) { return path.resolve(dir) + "\0" + main; }

async function callApi(srv, method, url, body) {
  const target = new URL("/api" + url, srv.url);
  target.searchParams.set("t", srv.token);
  const headers = { "x-mr": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await res.json() : await res.text();
  return { ok: res.ok, status: res.status, body: data };
}

async function openPdf(session, proj, url) {
  const match = /^\/api\/build\/([^/]+)\/pdf$/.exec(url);
  if (!match) throw new Error("Unknown PDF link.");
  const job = session.jobs.get(match[1]);
  if (!job?.pdf) throw new Error("This PDF is not ready yet.");
  const size = (await fs.stat(job.pdf)).size;
  if (size > 80 * 1024 * 1024) throw new Error("This PDF is too large to preview inside VS Code.");
  const buf = await fs.readFile(job.pdf);
  const panel = vscode.window.createWebviewPanel("manuscriptReview.pdf", `PDF — ${proj.name}`, vscode.ViewColumn.Beside, { enableScripts: false });
  panel.webview.html = renderPdfHtml(buf.toString("base64"), `PDF — ${proj.name}`);
}

async function exportState(srv, proj) {
  const target = new URL("/api/export", srv.url);
  target.searchParams.set("t", srv.token);
  const res = await fetch(target, { headers: { "x-mr": "1" } });
  if (!res.ok) throw new Error("Could not export review state.");
  const text = await res.text();
  const uri = await vscode.window.showSaveDialog({
    saveLabel: "Export review state",
    defaultUri: vscode.Uri.file(`${proj.id}-review-state.json`),
    filters: { JSON: ["json"] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  vscode.window.showInformationMessage("Review state exported.");
}

async function openReview(context, paperDir, main) {
  const { prepareProject, activeServer, startProject, closeProject, profilesDir } = await core();
  const key = samePaper(paperDir, main);
  const existing = panels.get(key);
  if (existing) { existing.reveal(); return; }

  const proj = await prepareProject({ dir: paperDir, main });
  const running = await activeServer(proj);
  if (running) {
    const pick = await vscode.window.showInformationMessage(
      `${proj.name} is already open in another Manuscript Review window.`,
      "Open in browser",
    );
    if (pick === "Open in browser") await vscode.env.openExternal(vscode.Uri.parse(running.url));
    return;
  }

  const config = vscode.workspace.getConfiguration("manuscriptReview");
  const configured = config.get("profilesFolder", "");
  const profiles = configured ? (path.isAbsolute(configured) ? configured : path.join(proj.dir, configured)) : profilesDir();
  const changesAuthor = config.get("changesAuthor", "");
  const { session, srv } = await startProject(proj, { profiles, changesAuthor });

  const panel = vscode.window.createWebviewPanel(
    "manuscriptReview.review",
    `Manuscript Review — ${proj.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "app"),
        vscode.Uri.joinPath(context.extensionUri, "media"),
      ],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");

  const state = { proj, session, srv };
  panels.set(key, panel);
  sessions.add(state);

  const forward = (event) => panel.webview.postMessage({ type: "event", event });
  session.on("event", forward);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (!message || typeof message !== "object") return;
    try {
      if (message.type === "api") {
        const result = await callApi(srv, message.method, message.url, message.body);
        panel.webview.postMessage({ type: "api-result", id: message.id, ...result });
      } else if (message.type === "openPdf") {
        await openPdf(session, proj, message.url);
      } else if (message.type === "exportState") {
        await exportState(srv, proj);
      }
    } catch (error) {
      if (message.type === "api") {
        panel.webview.postMessage({ type: "api-result", id: message.id, ok: false, status: 500, body: { error: error.message } });
      } else {
        vscode.window.showErrorMessage(error.message);
      }
    }
  });

  panel.onDidDispose(async () => {
    panels.delete(key);
    sessions.delete(state);
    session.off("event", forward);
    await closeProject(state);
  });

  panel.webview.html = renderReviewHtml(panel.webview, context.extensionUri, APP);
}

async function closeAll() {
  await Promise.all([...sessions].map((state) => closeProject(state)));
  sessions.clear();
  panels.clear();
}

module.exports = { openReview, closeAll };
