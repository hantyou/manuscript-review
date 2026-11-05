// Machine-level tools/state directory, project identity and atomic persistence.
import { promises as fs, existsSync, mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isGitRepo, rootCommit } from "./git.mjs";

export function toolsDir() {
  if (process.env.MR_TOOLS_DIR) return path.resolve(process.env.MR_TOOLS_DIR);
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "manuscript-review");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "manuscript-review");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "manuscript-review");
}
export const stateRoot = () => path.join(toolsDir(), "state");
export const configDir = () => path.join(toolsDir(), "config");
export const profilesDir = () => path.join(configDir(), "profiles");

export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }

export function writeAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + "." + process.pid + ".tmp";
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
export function writeJson(file, obj) { writeAtomic(file, JSON.stringify(obj, null, 1)); }

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "paper";

/**
 * Stable project identity: the paper repository's first commit plus the main
 * file. It survives moving or recloning the collection. Without Git the
 * identity is a random id stored in the registry, bound to the path.
 */
export async function resolveProject(projDir, mainRel, { instance = "", rebind = false } = {}) {
  const dir = path.resolve(projDir);
  const regFile = path.join(stateRoot(), "projects.json");
  const reg = readJson(regFile, { projects: {} });
  let basis = null;
  if (await isGitRepo(dir)) basis = await rootCommit(dir);
  const name = path.basename(dir);
  let id;
  if (basis) {
    const h = crypto.createHash("sha1").update(basis + ":" + mainRel + ":" + instance).digest("hex").slice(0, 8);
    // The folder name is only a label. Identity is the hash, so renaming or moving the folder keeps the review.
    id = Object.keys(reg.projects).find((k) => k.endsWith("-" + h)) || `${slug(name)}-${h}`;
  }
  else {
    const byPath = Object.values(reg.projects).find((p) => path.resolve(p.path) === dir && p.main === mainRel && (p.instance || "") === instance);
    id = byPath ? byPath.id : `${slug(name)}-${crypto.randomBytes(4).toString("hex")}`;
  }
  const prev = reg.projects[id];
  let note = "";
  if (prev && path.resolve(prev.path) !== dir) {
    if (existsSync(prev.path) && !rebind) {
      throw Object.assign(new Error(`Project ${id} is already bound to ${prev.path}. That folder still exists. Use --rebind to move the review to ${dir}, or --instance <name> to keep a separate review of this copy.`), { code: "IDENTITY_CONFLICT", id });
    }
    note = `Project ${id} was moved from ${prev.path}. Its review state was rebound.`;
  }
  reg.projects[id] = { id, path: dir, main: mainRel, name, instance, rootCommit: basis, lastOpened: new Date().toISOString() };
  writeJson(regFile, reg);
  return { id, dir, mainRel, name, note, stateDir: ensureDir(path.join(stateRoot(), id)) };
}

/** Rebind a known project id to a new path (for non-Git folders or manual moves). */
export function rebindProject(id, newPath) {
  const regFile = path.join(stateRoot(), "projects.json");
  const reg = readJson(regFile, { projects: {} });
  if (!reg.projects[id]) throw new Error("Unknown project id " + id);
  reg.projects[id].path = path.resolve(newPath);
  writeJson(regFile, reg);
  return reg.projects[id];
}
export function listProjects() { return Object.values(readJson(path.join(stateRoot(), "projects.json"), { projects: {} }).projects); }

export class Persist {
  constructor(file, initial) { this.file = file; this.data = readJson(file, initial); this.timer = null; this.savedAt = null; this.error = null; }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 120);
  }
  flush() {
    clearTimeout(this.timer);
    try { writeJson(this.file, this.data); this.savedAt = new Date().toISOString(); this.error = null; }
    catch (e) { this.error = String(e.message || e); }
  }
}

export async function readText(p, fallback = "") { try { return await fs.readFile(p, "utf8"); } catch { return fallback; } }
