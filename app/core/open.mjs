// Shared project opening: resolve a paper, create its session and local API server.
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { Session } from "./session.mjs";
import { startServer } from "../server.mjs";
import { resolveProject, readJson, writeJson, stateRoot, profilesDir } from "./store.mjs";
import { maskComments } from "../shared/tex.mjs";

/** All top-level .tex files that look like document entry points. */
export async function findMains(dir) {
  const names = (await fs.readdir(dir)).filter((n) => n.toLowerCase().endsWith(".tex"));
  const cands = [];
  for (const n of names) {
    const t = maskComments(await fs.readFile(path.join(dir, n), "utf8"));
    if (/\\documentclass/.test(t) && /\\begin\{document\}/.test(t)) cands.push(n);
  }
  return cands.sort();
}

/** Infer an unambiguous entry point: the saved file, or the only top-level .tex file. */
export async function inferMain(dir) {
  const regPath = path.join(stateRoot(), "projects.json");
  const reg = readJson(regPath, { projects: {} });
  const known = reg.paths?.[path.resolve(dir)];
  if (known && existsSync(path.join(dir, known))) return { main: known, source: "saved" };
  const cands = await findMains(dir);
  if (cands.length === 1) return { main: cands[0], source: "inferred" };
  throw new Error(cands.length ? `Several possible main files: ${cands.join(", ")}. Pass --main <file>.` : `No main .tex file (with \\documentclass) found in ${dir}. Pass --main <file>.`);
}

export function rememberMain(dir, main) {
  const regPath = path.join(stateRoot(), "projects.json");
  const reg = readJson(regPath, { projects: {} });
  reg.paths = { ...(reg.paths || {}), [path.resolve(dir)]: main };
  writeJson(regPath, reg);
}

/** Validate the paper folder and main file, then assign a stable project id. */
export async function prepareProject({ dir, main, instance = "", rebind = false }) {
  const projectDir = path.resolve(dir);
  if (!existsSync(projectDir)) throw new Error("Folder not found: " + projectDir);
  const mainRel = main ? main.replace(/\\/g, "/") : (await inferMain(projectDir)).main;
  if (!existsSync(path.join(projectDir, mainRel))) throw new Error(`Main file not found: ${path.join(projectDir, mainRel)}`);
  const proj = await resolveProject(projectDir, mainRel, { instance, rebind });
  rememberMain(projectDir, mainRel);
  return proj;
}

/** Return a live server for this project started by another process, if any. */
export async function activeServer(proj) {
  const running = readJson(path.join(proj.stateDir, "server.json"), null);
  if (!running || running.pid === process.pid) return null;
  try {
    process.kill(running.pid, 0);
    const target = new URL("/api/project", running.url);
    target.searchParams.set("t", running.token);
    const r = await fetch(target, { headers: { "x-mr": "1" }, signal: AbortSignal.timeout(1500) });
    if (r.ok) return running;
  } catch { /* stale record */ }
  try { await fs.rm(path.join(proj.stateDir, "server.json"), { force: true }); } catch {}
  return null;
}

/** Create the session and the loopback API server, and publish server.json. */
export async function startProject(proj, { profiles, port = 0, changesAuthor = "" } = {}) {
  const session = new Session(proj, { profilesDir: profiles || profilesDir(), changesAuthor });
  await session.init();
  const srv = await startServer(session, { port });
  writeJson(path.join(proj.stateDir, "server.json"), { pid: process.pid, url: srv.url, token: srv.token, port: srv.port });
  return { proj, session, srv };
}

export async function closeProject({ proj, session, srv } = {}) {
  try { session?.review.flush(); } catch {}
  try { session?.chats.flush(); } catch {}
  for (const r of session?.runs?.values?.() || []) { try { r.cancel?.(); } catch {} }
  try { await srv?.close?.(); } catch {}
  if (proj) { try { await fs.rm(path.join(proj.stateDir, "server.json"), { force: true }); } catch {} }
}
