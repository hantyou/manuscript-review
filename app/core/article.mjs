// Turn the scanned sources into one continuous article: headings, paragraphs and
// read-only blocks in reading order, with review units placed where they occur.
import { flatten, maskComments, sentenceRanges, skipGroup } from "../shared/tex.mjs";
import { lf } from "./scan.mjs";

const FRONT = /^\\(?:(?:title|author|markboth|thanks|date|IEEE[A-Za-z]+)\b|begin\{IEEEkeywords\})/;
const AUX_START = /^\\(?:(?:title|author|markboth|thanks|date|IEEE[A-Za-z]+)\b|begin\{IEEEkeywords\}|begin\{(?:figure\*?|table\*?|tikzpicture|algorithm\*?|algorithmic|tabular\*?|subfigure|wrapfigure|center|adjustbox|thebibliography)\}|input\{|FloatBarrier|clearpage|newpage|bibliography|IEEEtrigger|appendix|maketitle|editoriallegend|vspace|centering\b)/;

/** Source ranges in reading order, with \input and \include expanded in place. */
export function expandSegments(scan) {
  const out = []; const emitted = new Set();
  const rootRel = scan.order[0];
  function emit(rel, from, to) {
    const f = scan.files.get(rel); let pos = from;
    emitted.add(rel);
    for (const inc of (f.includes || []).filter((i) => i.start >= from && i.start < to).sort((a, b) => a.start - b.start)) {
      if (inc.start > pos) out.push({ file: rel, start: pos, end: inc.start });
      if (inc.target && !emitted.has(inc.target)) emit(inc.target, 0, scan.files.get(inc.target).text.length);
      pos = inc.end;
    }
    if (pos < to) out.push({ file: rel, start: pos, end: to });
  }
  const root = scan.files.get(rootRel);
  const b = root.body && root.body.start != null ? { start: root.body.start, end: root.body.end ?? root.text.length } : { start: 0, end: root.text.length };
  emit(rootRel, b.start, b.end);
  return out;
}

function pieces(f, a, b) {
  const raw = f.text.slice(a, b); const out = []; let last = 0;
  for (const [s, e] of sentenceRanges(raw)) {
    const t = raw.slice(s, e);
    if (/^\s*\\(begin|end|label|includegraphics|input|caption|centering)/.test(t) || t.split(/\s+/).length < 4) continue;
    if (s > last) out.push({ text: lf(raw.slice(last, s)) });
    out.push({ text: lf(t), start: a + s, end: a + e }); last = e;
  }
  if (last < raw.length) out.push({ text: lf(raw.slice(last)) });
  return out;
}

function proseWords(raw) {
  let s = flatten(maskComments(raw), "new");
  s = s.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, " ").replace(/\\[A-Za-z]+\*?(\[[^\]]*\])?/g, " ").replace(/\{[^{}]*\}/g, (m) => (/\s/.test(m.trim()) ? m : " "));
  return (s.match(/[A-Za-z]{3,}/g) || []).length;
}

function caption(raw) {
  const m = maskComments(raw); const i = m.indexOf("\\caption");
  if (i < 0) return "";
  let j = i + 8; while (/[\s*]/.test(m[j] || "")) j++;
  if (m[j] === "[") { const e = m.indexOf("]", j); if (e > 0) j = e + 1; }
  const e = skipGroup(m, j);
  return e > 0 ? lf(flatten(raw.slice(j + 1, e - 1), "new")).replace(/\s+/g, " ").trim() : "";
}

export function buildArticle(scan) {
  const blocks = []; const unitIdOf = (u) => u.stateId || u.id;
  const byFile = new Map();
  for (const u of scan.units) { if (!byFile.has(u.file)) byFile.set(u.file, []); byFile.get(u.file).push(u); }
  for (const arr of byFile.values()) arr.sort((a, b) => a.start - b.start);
  const heads = new Map(scan.headings.map((h) => [h.file + ":" + h.start, h]));

  for (const seg of expandSegments(scan)) {
    const f = scan.files.get(seg.file); const us = byFile.get(seg.file) || [];
    // Cut points: blank lines (not inside a unit) and heading edges.
    const cuts = new Set([seg.start, seg.end]);
    for (const m of f.text.slice(seg.start, seg.end).matchAll(/\r?\n[ \t]*\r?\n/g)) {
      const a = seg.start + m.index, b = a + m[0].length;
      if (us.some((u) => a >= u.start && b <= u.end)) continue;
      cuts.add(a); cuts.add(b);
    }
    for (const h of scan.headings) if (h.file === seg.file && h.start >= seg.start && h.end <= seg.end) { cuts.add(h.start); cuts.add(h.end); }
    const pts = [...cuts].sort((a, b) => a - b);
    for (let k = 0; k + 1 < pts.length; k++) {
      let s = pts[k], e = pts[k + 1];
      while (s < e && /\s/.test(f.text[s])) s++;
      while (e > s && /\s/.test(f.text[e - 1])) e--;
      if (e <= s) continue;
      const raw = f.text.slice(s, e);
      const h = heads.get(seg.file + ":" + s);
      if (h && e === h.end) { blocks.push({ t: "heading", idx: h.idx, level: h.level, title: h.title }); continue; }
      const inside = us.filter((u) => u.start >= s && u.end <= e);
      if (!inside.length && /^(%|\\(?:label|end)\{)/.test(raw) && !/[A-Za-z]{4,}\s+[A-Za-z]{3,}/.test(maskComments(raw))) continue;
      const aux = AUX_START.test(raw) || (!inside.length && proseWords(raw) < 5);
      const items = []; let pos = s;
      for (const u of inside) {
        if (u.start > pos) items.push({ t: "text", pieces: pieces(f, pos, u.start) });
        items.push({ t: "unit", id: unitIdOf(u) }); pos = u.end;
      }
      if (pos < e) items.push({ t: "text", pieces: pieces(f, pos, e) });
      if (aux) {
        blocks.push({ t: "aux", file: seg.file, line: f.text.slice(0, s).split("\n").length, caption: caption(raw), kind: FRONT.test(raw) ? "Front matter" : /\\begin\{(table|tabular)/.test(raw) ? "Table" : /\\begin\{(figure|tikz|subfigure|wrapfigure)/.test(raw) ? "Figure" : /\\begin\{algorithm/.test(raw) ? "Algorithm" : "LaTeX",
          src: lf(raw).slice(0, 1200), units: items.filter((x) => x.t === "unit").map((x) => x.id) });
      } else blocks.push({ t: "para", file: seg.file, fileSha: f.sha, line: f.text.slice(0, s).split("\n").length, items });
    }
  }
  return blocks;
}
