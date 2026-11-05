import { execFile } from "node:child_process";
import path from "node:path";

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: "buffer", ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}

export async function git(cwd, args) {
  const { stdout } = await run("git", ["-C", cwd, ...args]);
  return stdout.toString("utf8");
}

export async function tryGit(cwd, args) { try { return await git(cwd, args); } catch { return null; } }

export async function isGitRepo(cwd) { return (await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]))?.trim() === "true"; }
export async function headCommit(cwd) { return (await tryGit(cwd, ["rev-parse", "HEAD"]))?.trim() || null; }

export async function commitInfo(cwd, commit) {
  const out = await tryGit(cwd, ["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%aI", commit]);
  if (!out) return null;
  const [hash, short, subject, date] = out.trim().split("\x1f");
  return { hash, short, subject, date };
}

/** A stable identity for a repository that survives moving or recloning it. */
export async function rootCommit(cwd) {
  const out = await tryGit(cwd, ["rev-list", "--max-parents=0", "HEAD"]);
  if (!out) return null;
  return out.trim().split(/\s+/).sort()[0] || null;
}

export async function listTexAtCommit(cwd, commit) {
  const out = await tryGit(cwd, ["ls-tree", "-r", "--name-only", commit]);
  return out ? out.split("\n").map((s) => s.trim()).filter((s) => /\.tex$/i.test(s)) : [];
}

export async function showFile(cwd, commit, rel) {
  try { const { stdout } = await run("git", ["-C", cwd, "show", `${commit}:./${rel}`]); return stdout.toString("utf8"); }
  catch { return null; }
}

/** Absolute path of info/exclude, valid when .git is a file (submodule). */
export async function excludeFile(cwd) {
  const out = await tryGit(cwd, ["rev-parse", "--git-path", "info/exclude"]);
  if (!out) return null;
  const p = out.trim();
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

export async function isIgnored(cwd, rel) { return (await tryGit(cwd, ["check-ignore", "-q", rel])) !== null; }
export async function isTracked(cwd, rel) { return ((await tryGit(cwd, ["ls-files", "--", rel])) || "").trim().length > 0; }
export async function porcelain(cwd) { return (await tryGit(cwd, ["status", "--porcelain", "--untracked-files=all"])) || ""; }
