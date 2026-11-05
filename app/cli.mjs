#!/usr/bin/env node
// Manuscript review command line: open | doctor | agents | projects | rebind
// This is the optional browser entry point; the VS Code extension uses the same core.
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rebindProject, listProjects, toolsDir, stateRoot } from "./core/store.mjs";
import { detectAgents } from "./core/agents.mjs";
import { prepareProject, activeServer, startProject, closeProject } from "./core/open.mjs";
import { git } from "./core/git.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (["no-browser", "rebind", "json", "force"].includes(k)) opt[k] = true; else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

async function cmdOpen(pos, opt) {
  if (!pos[0]) throw new Error("Usage: open <paper-folder> [--main root.tex] [--port N] [--no-browser] [--instance name] [--rebind] [--changes-author id]");
  const dir = path.resolve(pos[0]);
  if (!existsSync(dir)) throw new Error("Folder not found: " + dir);
  const proj = await prepareProject({ dir, main: opt.main, instance: opt.instance || "", rebind: !!opt.rebind });

  const running = await activeServer(proj);
  if (running) {
    console.log("Already running: " + running.url);
    if (!opt["no-browser"]) openBrowser(running.url);
    return;
  }

  const changesAuthor = opt["changes-author"] || process.env.MR_CHANGES_AUTHOR || "";
  const { session, srv } = await startProject(proj, { port: opt.port ? +opt.port : 0, changesAuthor });
  const c = session.project();
  if (proj.note) console.log(proj.note);
  console.log(`Project id : ${proj.id}`);
  console.log(`Baseline   : ${c.baseline.short || "none"} ${c.baseline.subject || ""}${c.baseline.moved ? `  (HEAD is now ${c.baseline.headNow.slice(0, 7)}; baseline stays frozen)` : ""}`);
  console.log(`Units      : ${c.counts.total} (${c.counts.pending} pending, ${c.counts.decided} decided)`);
  console.log(`State      : ${proj.stateDir}`);
  console.log(`Open       : ${srv.url}`);
  if (!opt["no-browser"]) openBrowser(srv.url);
  const bye = async () => { await closeProject({ proj, session, srv }); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}

function openBrowser(url) {
  if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

async function cmdDoctor() {
  const out = [];
  const row = (k, v, ok = true) => out.push(`${ok ? "ok  " : "FAIL"}  ${k.padEnd(18)} ${v}`);
  row("node", process.version, +process.versions.node.split(".")[0] >= 20);
  try { row("git", (await git(".", ["--version"])).trim()); } catch { row("git", "not found", false); }
  const lm = await new Promise((r) => { const c = spawn("latexmk", ["-v"], { shell: process.platform === "win32", windowsHide: true }); let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("close", (code) => r(code === 0 ? o.split("\n").find((l) => /Latexmk/.test(l)) || "ok" : null)); c.on("error", () => r(null)); });
  row("latexmk", lm || "not found (PDF previews unavailable)", !!lm);
  const katex = [path.join(HERE, "node_modules", "katex", "dist", "katex.min.js"), path.resolve(HERE, "..", "media", "katex", "katex.min.js")].find(existsSync);
  row("katex", katex ? "installed" : "missing (math shows as source)", !!katex);
  row("tools dir", toolsDir());
  for (const a of await detectAgents(true)) row("agent " + a.id, `${a.found ? "found" : "missing"}${a.version ? " " + a.version : ""}${a.status === "unsupported" ? " (no adapter)" : a.found ? ` auth=${a.auth}` : ""}${a.note ? ". " + a.note : ""}`, a.status === "unsupported" || a.usable || !a.found);
  console.log(out.join("\n"));
}

const [cmd, ...rest] = process.argv.slice(2);
const { pos, opt } = parseArgs(rest);
const run = async () => {
  if (cmd === "open") return cmdOpen(pos, opt);
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "agents") return console.log(JSON.stringify(await detectAgents(true), null, 2));
  if (cmd === "projects") return console.log(listProjects().map((p) => `${p.id}  ${p.path}  (${p.main})`).join("\n") || "No projects yet.");
  if (cmd === "rebind") { if (pos.length < 2) throw new Error("Usage: rebind <project-id> <new-folder>"); console.log(rebindProject(pos[0], pos[1])); return; }
  console.log("Usage: cli.mjs open <paper-folder> [--main file] [--changes-author id] | doctor | agents | projects | rebind <id> <folder>");
};
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
}
