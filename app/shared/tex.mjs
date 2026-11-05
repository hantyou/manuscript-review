// Source-aware LaTeX helpers shared by the server and the browser.
// No Node imports here: this file is also served to the page.
//
// Nothing in this file uses a regular expression to find macro arguments. It
// masks comments, skips escaped characters, and matches braces by depth.

const DEF_COMMANDS = new Set([
  "newcommand", "renewcommand", "providecommand", "DeclareRobustCommand",
  "NewDocumentCommand", "RenewDocumentCommand", "ProvideDocumentCommand",
  "DeclareDocumentCommand", "newenvironment", "renewenvironment",
  "def", "gdef", "edef", "xdef", "pdfstringdefDisableCommands",
  "DeclareMathOperator", "newtheorem", "newif", "AtBeginDocument",
]);
const MARKUP = { added: 1, deleted: 1, replaced: 2 };
const HEADINGS = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4 };
const INCLUDES = new Set(["input", "include"]);

/** Replace comment text by spaces (same length), so offsets stay valid. */
export function maskComments(src) {
  const out = src.split("");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "%") {
      while (i < src.length && src[i] !== "\n") { if (src[i] !== "\r") out[i] = " "; i++; }
      i--;
    }
  }
  return out.join("");
}

/** Index just after the brace group starting at `i` (src[i] === "{"), or -1. */
export function skipGroup(m, i, open = "{", close = "}") {
  if (m[i] !== open) return -1;
  let depth = 0;
  for (let k = i; k < m.length; k++) {
    const c = m[k];
    if (c === "\\") { k++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return k + 1; }
  }
  return -1;
}

function skipWs(m, i) { while (i < m.length && /\s/.test(m[i])) i++; return i; }

/** Read a command name at m[i] === "\\". Returns {name, end}. */
function readCommand(m, i) {
  let k = i + 1;
  if (k >= m.length) return { name: "", end: k };
  if (/[A-Za-z@]/.test(m[k])) {
    while (k < m.length && /[A-Za-z@]/.test(m[k])) k++;
    return { name: m.slice(i + 1, k), end: k };
  }
  return { name: m[k], end: k + 1 };
}

/** End offset of a definition command (so its body is not scanned). */
function skipDefinition(m, nameEnd, name) {
  let i = nameEnd;
  if (name === "def" || name === "gdef" || name === "edef" || name === "xdef") {
    while (i < m.length && m[i] !== "{") i++;
    const e = skipGroup(m, i); return e < 0 ? m.length : e;
  }
  if (name === "newif") { return i; }
  if (name === "pdfstringdefDisableCommands" || name === "AtBeginDocument") {
    i = skipWs(m, i); const e = skipGroup(m, i); return e < 0 ? i : e;
  }
  // \newcommand*{\x}[n][d]{body}, \newcommand\x{body}, \newenvironment{x}{b}{e}
  i = skipWs(m, i);
  if (m[i] === "*") i = skipWs(m, i + 1);
  if (m[i] === "{") { const e = skipGroup(m, i); if (e < 0) return m.length; i = e; }
  else if (m[i] === "\\") { i = readCommand(m, i).end; }
  const wanted = /environment|theorem/.test(name) ? 2 : /Document/.test(name) ? 2 : 1;
  let groups = 0;
  while (i < m.length && groups < wanted) {
    i = skipWs(m, i);
    if (m[i] === "[") { const e = m.indexOf("]", i); if (e < 0) break; i = e + 1; continue; }
    if (m[i] === "{") { const e = skipGroup(m, i); if (e < 0) return m.length; i = e; groups++; continue; }
    break;
  }
  return i;
}

/**
 * Walk a (masked) source in order. `on` receives events:
 *   {type:"node", cmd, start, end, args:[[s,e],...]}   markup command
 *   {type:"include", name, start, end}
 *   {type:"heading", level, title, start, end}
 * Definitions are skipped, so \replaced inside a \DeclareRobustCommand body is
 * not reported. Markup commands are reported at top level only.
 */
export function walk(src, on, masked = maskComments(src)) {
  const m = masked;
  let i = 0;
  while (i < m.length) {
    const c = m[i];
    if (c !== "\\") { i++; continue; }
    const { name, end } = readCommand(m, i);
    if (DEF_COMMANDS.has(name)) { i = Math.max(skipDefinition(m, end, name), end); continue; }
    if (name === "begin" || name === "end") {
      const j = skipWs(m, end);
      if (m[j] === "{") {
        const e = skipGroup(m, j);
        const env = e > 0 ? m.slice(j + 1, e - 1) : "";
        if (env === "document") on({ type: "document", edge: name, start: i, end: e });
        if (name === "begin" && env === "abstract") on({ type: "heading", level: 1, title: "Abstract", start: i, end: e });
        if (name === "begin" && (env === "verbatim" || env === "lstlisting")) {
          const close = m.indexOf("\\end{" + env + "}", e);
          i = close < 0 ? m.length : close; continue;
        }
        i = e > 0 ? e : end; continue;
      }
    }
    if (name === "appendix") { on({ type: "heading", level: 1, title: "Appendix", start: i, end }); i = end; continue; }
    if (name in MARKUP) {
      const j = skipWs(m, end);
      if (m[j] === "{") {
        const args = []; let k = j;
        for (let a = 0; a < MARKUP[name]; a++) {
          k = skipWs(m, k);
          if (m[k] !== "{") { args.length = 0; break; }
          const e = skipGroup(m, k);
          if (e < 0) { args.length = 0; break; }
          args.push([k + 1, e - 1]); k = e;
        }
        if (args.length === MARKUP[name]) {
          on({ type: "node", cmd: name, start: i, end: k, args });
          i = k; continue;
        }
      }
    }
    if (INCLUDES.has(name)) {
      const j = skipWs(m, end);
      if (m[j] === "{") {
        const e = skipGroup(m, j);
        if (e > 0) { on({ type: "include", name: src.slice(j + 1, e - 1).trim(), start: i, end: e }); i = e; continue; }
      }
    }
    if (name in HEADINGS) {
      let j = skipWs(m, end);
      if (m[j] === "*") j++;
      if (m[j] === "[") { const e = m.indexOf("]", j); if (e > 0) j = skipWs(m, e + 1); }
      if (m[j] === "{") {
        const e = skipGroup(m, j);
        if (e > 0) {
          on({ type: "heading", level: HEADINGS[name], title: flatten(src.slice(j + 1, e - 1), "new").replace(/\s+/g, " ").trim(), start: i, end: e });
          i = e; continue;
        }
      }
    }
    i = end;
  }
}

/** Resolve the markup in `text` to its "new" or "old" reading. */
export function flatten(text, side) {
  const masked = maskComments(text);
  const nodes = [];
  walk(text, (ev) => { if (ev.type === "node") nodes.push(ev); }, masked);
  if (!nodes.length) return text;
  let out = ""; let pos = 0;
  for (const n of nodes) {
    out += text.slice(pos, n.start);
    let piece = "";
    const arg = (k) => flatten(text.slice(n.args[k][0], n.args[k][1]), side);
    if (n.cmd === "added") piece = side === "new" ? arg(0) : "";
    else if (n.cmd === "deleted") piece = side === "old" ? arg(0) : "";
    else piece = side === "new" ? arg(0) : arg(1);
    if (piece === "") {
      const next = text[n.end];
      if (/[ \t]$/.test(out) && (next === undefined || /\s/.test(next))) out = out.replace(/[ \t]+$/, "");
    }
    out += piece; pos = n.end;
  }
  return out + text.slice(pos);
}

/** True when text still contains tracked-change commands at the top level. */
export function hasMarkup(text) {
  let found = false;
  walk(text, (ev) => { if (ev.type === "node") found = true; });
  return found;
}

/** Whitespace-insensitive comparison key. */
export function norm(s) { return s.replace(/\s+/g, " ").replace(/~/g, " ").replace(/\s+/g, " ").trim(); }
export function loose(s) { return s.replace(/%[^\n]*/g, "").replace(/[\s~]+/g, "").replace(/\\(?:,|;|!|:|space)/g, ""); }

const ABBREV = /(?:e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|Sec|Tab|Ref|Refs|vs|cf|approx|resp|No|Dr)$/i;

/** Sentence ranges [start,end) inside `text` (end excludes trailing whitespace). */
export function sentenceRanges(text) {
  const out = []; let start = 0; let i = 0;
  const n = text.length;
  while (start < n && /\s/.test(text[start])) start++;
  i = start;
  while (i < n) {
    const c = text[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "$") { // skip inline math as a unit
      const j = text.indexOf("$", i + 1);
      if (j > 0) { i = j + 1; continue; }
    }
    if (c === "." || c === "?" || c === "!") {
      let j = i + 1;
      while (j < n && /[)\]}'"]/.test(text[j])) j++;
      const before = text.slice(Math.max(0, start), i);
      if ((j >= n || /\s/.test(text[j])) && !(c === "." && ABBREV.test(before))) {
        let k = j; while (k < n && /\s/.test(text[k])) k++;
        if (k >= n || /[A-Z\\$0-9(]/.test(text[k]) ) {
          out.push([start, j]); start = k; i = k; continue;
        }
      }
    }
    i++;
  }
  if (start < n) { let e = n; while (e > start && /\s/.test(text[e - 1])) e--; if (e > start) out.push([start, e]); }
  return out;
}

/** Extract simple macro definitions for KaTeX. Only \newcommand-style ones. */
export function extractMacros(src) {
  const m = maskComments(src); const macros = {};
  const re = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?/g;
  let mm;
  while ((mm = re.exec(m))) {
    let i = skipWs(m, mm.index + mm[0].length);
    let name;
    if (m[i] === "{") { const e = skipGroup(m, i); if (e < 0) continue; name = m.slice(i + 1, e - 1).trim(); i = e; }
    else if (m[i] === "\\") { const r = readCommand(m, i); name = m.slice(i, r.end); i = r.end; }
    else continue;
    i = skipWs(m, i);
    let nargs = 0;
    if (m[i] === "[") { const e = m.indexOf("]", i); nargs = parseInt(m.slice(i + 1, e), 10) || 0; i = skipWs(m, e + 1); }
    if (m[i] === "[") continue; // optional default argument: not supported here
    if (m[i] !== "{") continue;
    const e = skipGroup(m, i); if (e < 0) continue;
    const body = src.slice(i + 1, e - 1);
    if (/\\(?:color|textcolor|if|fi|else|sout|colorbox)/.test(body)) continue; // presentation macros
    macros[name] = body;
  }
  return macros;
}
