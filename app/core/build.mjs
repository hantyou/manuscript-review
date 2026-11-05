// Staged PDF builds. Everything happens in the tool's state directory, never in the paper.
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { encodeSource } from "./scan.mjs";

const SKIP_DIRS = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "tmp"]);
const SKIP_EXT = /\.(aux|log|out|fls|fdb_latexmk|synctex\.gz|blg|bbl|toc|lof|lot|bcf|run\.xml)$/i;

async function syncTree(src, dst, rootSrc) {
  await fs.mkdir(dst, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; await syncTree(path.join(src, e.name), path.join(dst, e.name), rootSrc); continue; }
    if (!e.isFile() || SKIP_EXT.test(e.name)) continue;
    if (src === rootSrc && /^root\.pdf$/i.test(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    const [a, b] = await Promise.all([fs.stat(s), fs.stat(d).catch(() => null)]);
    if (!b || b.size !== a.size || Math.abs(b.mtimeMs - a.mtimeMs) > 2000 || b.mtimeMs < a.mtimeMs - 2000) {
      await fs.copyFile(s, d); await fs.utimes(d, a.atime, a.mtime);
    }
  }
}

export function detectCleanSwitch(scan) {
  for (const f of scan.files.values()) {
    const m = f.text.match(/\\ifdefined\\([A-Za-z]*Clean[A-Za-z]*)/);
    if (m) return `\\def\\${m[1]}{1}`;
  }
  return null;
}

/** Copy the project to a staging folder and overlay edited sources. */
export async function stage(proj, scan, overlay, name) {
  const dir = path.join(proj.stateDir, "build", name);
  await syncTree(proj.dir, dir, proj.dir);
  for (const [rel, text] of overlay) {
    const f = scan.files.get(rel);
    const out = path.join(dir, rel);
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, encodeSource(f, text));
  }
  return dir;
}

export async function compile(dir, mainRel, { clean, cleanSwitch, jobname }) {
  const args = ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", `-jobname=${jobname}`];
  let entry = mainRel;
  if (clean && cleanSwitch) { // a tiny wrapper avoids command-line quoting of backslashes
    entry = "mr_clean_wrapper.tex";
    await fs.writeFile(path.join(dir, entry), cleanSwitch + "\n\\input{" + mainRel.replace(/\.tex$/i, "") + "}\n");
  }
  args.push(entry);
  return new Promise((resolve) => {
    const child = spawn("latexmk", args, { cwd: dir, windowsHide: true, shell: process.platform === "win32" });
    let out = "";
    child.stdout.on("data", (d) => { out = (out + d).slice(-20000); });
    child.stderr.on("data", (d) => { out = (out + d).slice(-20000); });
    const timer = setTimeout(() => { execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {}); }, 8 * 60000);
    child.on("close", async (code) => {
      clearTimeout(timer);
      let log = ""; try { log = await fs.readFile(path.join(dir, jobname + ".log"), "utf8"); } catch {}
      const pdf = path.join(dir, jobname + ".pdf");
      let hasPdf = false; try { hasPdf = (await fs.stat(pdf)).size > 0; } catch {}
      resolve({ ok: code === 0 && hasPdf, code, pdf: hasPdf ? pdf : null, ...summarizeLog(log), tail: out.slice(-1500) });
    });
  });
}

export function summarizeLog(log) {
  const set = (re) => [...new Set([...log.matchAll(re)].map((m) => m[1]))].sort();
  const pages = (log.match(/Output written on .*?\((\d+) pages?/) || [])[1];
  return {
    undefinedRefs: set(/Reference `([^']+)' on page \d+ undefined/g),
    undefinedCites: set(/Citation `([^']+)' on page \d+ undefined/g),
    errors: [...log.matchAll(/^(?:\S+?:\d+: .+|! .+)$/gm)].map((m) => m[0]).slice(0, 8),
    pages: pages ? +pages : null,
  };
}
