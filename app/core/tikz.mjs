// Render tikzpicture blocks to SVG with the paper's own preamble.
// Compilation stays in the tool's state directory; the paper is never written.
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";

const TIMEOUT = 120000;
const CONCURRENCY = 2;
let running = 0;
const waiting = [];

async function slot(fn) {
  if (running >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  running++;
  try { return await fn(); }
  finally { running--; const next = waiting.shift(); if (next) next(); }
}

function run(cmd, args, cwd, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: process.platform === "win32" });
    let out = "";
    const take = (d) => { out = (out + d).slice(-12000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    let timer = null;
    const finish = (result) => { if (timer) clearTimeout(timer); resolve({ ...result, out }); };
    timer = setTimeout(() => {
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      else { try { child.kill("SIGKILL"); } catch {} }
      finish({ ok: false, code: -1, timeout: true });
    }, timeout);
    child.on("error", (e) => finish({ ok: false, code: -1, enoent: e.code === "ENOENT", error: e.message }));
    child.on("close", (code) => finish({ ok: code === 0, code }));
  });
}

function texPath(p) {
  return path.resolve(p).split(path.sep).join("/");
}

export class TikzRenderer {
  constructor({ projectDir, mainRel, outDir }) {
    this.projectDir = projectDir;
    this.mainRel = mainRel;
    this.outDir = outDir;
    this.jobs = new Map();
  }

  async render(key, tex) {
    const out = path.join(this.outDir, key + ".svg");
    try { const st = await fs.stat(out); if (st.size > 0) return out; } catch {}
    if (!this.jobs.has(key)) {
      const job = slot(() => this._build(key, tex))
        .finally(() => this.jobs.delete(key));
      this.jobs.set(key, job);
    }
    return this.jobs.get(key);
  }

  async _preamble() {
    const text = await fs.readFile(path.join(this.projectDir, this.mainRel), "utf8");
    const end = text.search(/\\begin\s*\{document\}/);
    let pre = end >= 0 ? text.slice(0, end) : "";
    if (!/\\documentclass/.test(pre)) throw new Error("The main file has no \\documentclass preamble to reuse.");
    pre = pre.replace(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]*\}/, "\\documentclass[border=2pt]{standalone}");
    return pre;
  }

  async _build(key, tex) {
    const work = path.join(this.outDir, "work", key);
    await fs.rm(work, { recursive: true, force: true });
    await fs.mkdir(work, { recursive: true });
    const proj = texPath(this.projectDir);
    if (/[{}%#]/.test(proj)) throw new Error("The paper path contains characters that TikZ preview cannot use.");
    const preamble = await this._preamble();
    const source = [
      preamble,
      "\\makeatletter",
      `\\def\\input@path{{${proj}/}}`,
      "\\makeatother",
      `\\graphicspath{{${proj}/}{${proj}/images/}}`,
      "\\pagestyle{empty}",
      "\\begin{document}",
      "\\thispagestyle{empty}",
      tex,
      "\\end{document}",
      "",
    ].join("\n");
    await fs.writeFile(path.join(work, "main.tex"), source);

    const pdf = path.join(work, "main.pdf");
    const args = ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-no-shell-escape", "main.tex"];
    let result = await run("pdflatex", args, work);
    if (!result.ok && result.enoent) result = await run("lualatex", args, work);
    let hasPdf = false;
    try { hasPdf = (await fs.stat(pdf)).size > 0; } catch {}
    if (!result.ok && !hasPdf) {
      const name = result.enoent ? "LaTeX is not installed" : result.timeout ? "Rendering timed out" : "LaTeX could not render this figure";
      throw new Error(name + (result.out ? "\n" + result.out.trim().split("\n").slice(-6).join("\n") : ""));
    }

    const svg = path.join(work, "figure.svg");
    let conv = await run("pdftocairo", ["-svg", pdf, svg], work);
    if (!conv.ok && conv.enoent) conv = await run("dvisvgm", ["--pdf", pdf, "-o", svg], work);
    if (!conv.ok) throw new Error("Rendered PDF but no SVG converter (pdftocairo or dvisvgm) is available.");

    await fs.mkdir(this.outDir, { recursive: true });
    await fs.rename(svg, path.join(this.outDir, key + ".svg"));
    await fs.rm(work, { recursive: true, force: true });
    return path.join(this.outDir, key + ".svg");
  }
}
