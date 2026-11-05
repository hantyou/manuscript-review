// Read a paper's active source files and find review units.
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { maskComments, walk, flatten, norm, extractMacros } from "../shared/tex.mjs";

export const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
export const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
export const lf = (s) => s.replace(/\r\n/g, "\n");

export async function readSource(abs) {
  const raw = await fs.readFile(abs);
  let off = 0;
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  if (bom) off = 3;
  const text = raw.subarray(off).toString("utf8");
  const roundtrip = Buffer.compare(Buffer.concat([raw.subarray(0, off), Buffer.from(text, "utf8")]), raw) === 0;
  const crlf = (text.match(/\r\n/g) || []).length, bare = (text.match(/(?<!\r)\n/g) || []).length;
  return { raw, text, bom, eol: crlf > bare ? "\r\n" : "\n", sha: sha256(raw), roundtrip };
}

export function encodeSource(file, text) {
  return Buffer.concat([file.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}

async function resolveInclude(root, name) {
  const base = path.resolve(root, name);
  for (const cand of [base, base + ".tex"]) {
    try { const st = await fs.stat(cand); if (st.isFile()) return cand; } catch {}
  }
  return null;
}

/** Blank-line delimited paragraph around [start,end). */
export function paragraphBounds(text, start, end) {
  const before = text.slice(0, start), after = text.slice(end);
  const b = [...before.matchAll(/\n[ \t]*\r?\n/g)].pop();
  const pS = b ? b.index + b[0].length : 0;
  const a = after.match(/\r?\n[ \t]*\r?\n/);
  let pE = a ? end + a.index : text.length;
  // Structural lines also end a paragraph, so the context is prose and not front matter.
  const STRUCT = /^[ \t]*(?:\\(?:begin|end)\{[^}]*\}[^\n]*|\\(?:sub)*section\*?\{[^\n]*|\\maketitle|\\editoriallegend|\\appendix|%{3,}[^\n]*|\\(?:input|FloatBarrier|clearpage|newpage)\b[^\n]*)\r?$/gm;
  let ns = pS;
  for (const m of text.slice(pS, start).matchAll(STRUCT)) ns = pS + m.index + m[0].length + 1;
  let ne = pE;
  STRUCT.lastIndex = 0;
  const after2 = text.slice(end, pE); const nm = [...after2.matchAll(STRUCT)][0];
  if (nm) ne = end + nm.index;
  return [Math.min(ns, start), Math.max(ne, end)];
}

const tidy = (s) => lf(s).replace(/^[ \t]+|[ \t]+$/g, "").replace(/^\n+|\n+$/g, "");

function groupNodes(nodes, text) {
  const groups = []; let cur = null;
  for (const n of nodes) {
    if (cur) {
      const prev = cur[cur.length - 1];
      const gap = text.slice(prev.end, n.start);
      const hasReplaced = cur.some((x) => x.cmd === "replaced");
      if (/^[ \t]*(?:\r?\n)?[ \t]*$/.test(gap) && !(n.cmd === "replaced" && hasReplaced)) { cur.push(n); continue; }
    }
    cur = [n]; groups.push(cur);
  }
  return groups;
}

/**
 * Scan the project from its main file, following active \input / \include.
 * Returns files (in document order), headings, markup units and macros.
 */
export async function scanProject(projDir, mainRel) {
  const files = new Map(); const order = []; const headings = []; const events = [];
  const visited = new Set();
  async function visit(abs) {
    const rel = path.relative(projDir, abs).split(path.sep).join("/");
    if (visited.has(rel)) return; visited.add(rel);
    const f = await readSource(abs); f.rel = rel; f.abs = abs;
    files.set(rel, f); order.push(rel);
    const evs = [];
    walk(f.text, (e) => evs.push(e), maskComments(f.text));
    f.includes = [];
    for (const e of evs) {
      if (e.type === "include") {
        const target = await resolveInclude(projDir, e.name);
        f.includes.push({ start: e.start, end: e.end, target: target ? path.relative(projDir, target).split(path.sep).join("/") : null });
        if (target) await visit(target);
      } else if (e.type === "document") {
        f.body = f.body || {}; if (e.edge === "begin") f.body.start = e.end; else f.body.end = e.start;
      } else events.push({ ...e, file: rel });
    }
  }
  const mainAbs = path.resolve(projDir, mainRel);
  await visit(mainAbs);

  let curHeading = -1;
  const perFile = new Map(); let seqNo = 0;
  for (const e of events) {
    if (e.type === "heading") {
      headings.push({ idx: headings.length, level: e.level, title: e.title, file: e.file, start: e.start, end: e.end });
      curHeading = headings.length - 1;
    } else if (e.type === "node") {
      if (!perFile.has(e.file)) perFile.set(e.file, []);
      perFile.get(e.file).push({ ...e, heading: curHeading, seq: seqNo++ });
    }
  }
  const units = []; const seen = new Map();
  for (const [rel, nodes] of perFile) {
    const f = files.get(rel);
    for (const g of groupNodes(nodes, f.text)) {
      const start = g[0].start, end = g[g.length - 1].end;
      const srcText = f.text.slice(start, end);
      const orig = tidy(flatten(srcText, "old")), prop = tidy(flatten(srcText, "new"));
      const key = sha1(norm(orig) + "\u0001" + norm(prop)).slice(0, 10);
      const n = (seen.get(key) || 0) + 1; seen.set(key, n);
      units.push({
        id: "u_" + key + (n > 1 ? "_" + n : ""), kind: orig === "" ? "add" : prop === "" ? "delete" : "replace",
        file: rel, start, end, srcText, orig, prop, srcSha: sha1(srcText), heading: g[0].heading,
        line: f.text.slice(0, start).split("\n").length, para: paragraphBounds(f.text, start, end),
      });
    }
  }
  units.sort((a, b) => a.seq - b.seq);
  const macros = {};
  for (const f of files.values()) Object.assign(macros, extractMacros(f.text));
  return { projDir, mainRel, files, order, headings, units, macros };
}

/** Locate a manual (unmarked) passage in the current sources. */
export function locateManual(scan, m) {
  const f = scan.files.get(m.file); if (!f) return null;
  const hits = []; let i = -1;
  while ((i = f.text.indexOf(m.srcText, i + 1)) >= 0) hits.push(i);
  let pick = null;
  if (hits.length === 1) pick = hits[0];
  else if (hits.length > 1) {
    const scored = hits.map((h) => ({ h, s: (f.text.slice(Math.max(0, h - m.before.length), h) === m.before ? 1 : 0) + (f.text.slice(h + m.srcText.length, h + m.srcText.length + m.after.length) === m.after ? 1 : 0) }));
    scored.sort((a, b) => b.s - a.s);
    if (scored[0].s > 0 && scored[0].s > (scored[1]?.s ?? -1)) pick = scored[0].h;
  }
  if (pick == null) return null;
  const end = pick + m.srcText.length;
  if (scan.units.some((u) => u.file === m.file && u.start < end && pick < u.end)) return null; // would overlap markup
  return { start: pick, end };
}
