// Readable rendering of LaTeX prose. Unsupported constructs stay visible as source.
import { flatten, skipGroup, stripMathMeta } from "../shared/tex.mjs";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mathHtml(tex, display, env) {
  if (env.katex && window.katex) {
    // Resolve tracked changes to their new reading, then drop commands KaTeX
    // rejects (equation labels, TeX conditionals) before the first attempt.
    let src = tex;
    try { src = flatten(tex, "new"); } catch {}
    src = stripMathMeta(src);
    const options = { displayMode: display, macros: { ...env.macros }, trust: false, strict: "ignore" };
    try { return window.katex.renderToString(src, { ...options, throwOnError: true }); }
    catch {
      // One unsupported command should not turn the whole equation into source.
      try { return window.katex.renderToString(src, { ...options, throwOnError: false }); } catch {}
    }
  }
  return `<code class="math-src">${display ? "\\[" : "$"}${esc(tex)}${display ? "\\]" : "$"}</code>`;
}

const MATH_ENVS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*"];
const CITE = /^cite[a-z]*$/;
const REF = /^(ref|eqref|autoref|cref|Cref|pageref)$/;
const SIMPLE = { emph: "em", textit: "em", textbf: "b", texttt: "code", textsc: "span", underline: "u", sout: "s", mbox: "span", hbox: "span", textrm: "span", textsf: "span", text: "span" };
const SWITCH = new Set(["else", "fi", "or", "begingroup", "endgroup"]);
const SYMBOLS = { "%": "%", "&": "&amp;", "_": "_", "#": "#", "$": "$", "{": "{", "}": "}", ",": "&thinsp;", ";": "&nbsp;", ":": "&nbsp;", "!": "", " ": " ", "\\": "<br>", "-": "" };

function argAt(src, i) { // returns [text, nextIndex] for {...} at or after whitespace
  let j = i; while (j < src.length && /\s/.test(src[j])) j++;
  if (src[j] !== "{") return null;
  const e = skipGroup(src, j); if (e < 0) return null;
  return [src.slice(j + 1, e - 1), e];
}

export function renderTex(src, env = {}) {
  let out = ""; let i = 0; const n = src.length;
  const bib = env.bib || {}, labels = env.labels || {};
  while (i < n) {
    const c = src[i];
    if (c === "%") { const e = src.indexOf("\n", i); i = e < 0 ? n : e; continue; }
    if (c === "$") {
      const dbl = src[i + 1] === "$"; const close = dbl ? src.indexOf("$$", i + 2) : (() => { let k = i + 1; while (k < n && src[k] !== "$") { if (src[k] === "\\") k++; k++; } return k < n ? k : -1; })();
      if (close > 0) { out += mathHtml(src.slice(i + (dbl ? 2 : 1), close), dbl, env); i = close + (dbl ? 2 : 1); continue; }
    }
    if (c === "~") { out += "&nbsp;"; i++; continue; }
    if (c === "{" || c === "}") { i++; continue; }
    if (c === "-" && src.startsWith("---", i)) { out += "—"; i += 3; continue; }
    if (c === "-" && src.startsWith("--", i)) { out += "–"; i += 2; continue; }
    if (c === "`" && src.startsWith("``", i)) { out += "“"; i += 2; continue; }
    if (c === "'" && src.startsWith("''", i)) { out += "”"; i += 2; continue; }
    if (c !== "\\") { out += esc(c); i++; continue; }
    // command
    const m = /^\\([A-Za-z@]+)\*?/.exec(src.slice(i, i + 40));
    if (!m) {
      const s = src[i + 1];
      if (s === "(" || s === "[") { const close = src.indexOf(s === "(" ? "\\)" : "\\]", i + 2); if (close > 0) { out += mathHtml(src.slice(i + 2, close), s === "[", env); i = close + 2; continue; } }
      if (s in SYMBOLS) { out += SYMBOLS[s]; i += 2; continue; }
      out += esc(src.slice(i, i + 2)); i += 2; continue;
    }
    const name = m[1]; let j = i + m[0].length;
    // TeX conditional switches and grouping commands are typesetting mechanics,
    // not prose: hide them so they do not interrupt equations and paragraphs.
    if (SWITCH.has(name) || (name !== "iff" && /^if[A-Za-z@]*$/.test(name))) { i = j; continue; }
    if (name === "color") { const a = argAt(src, j); if (a) { i = a[1]; continue; } }
    if ((name === "begin" || name === "end") && /^\s*\{(?:itemize|enumerate|description|center|abstract|quote|flushleft|flushright|small|footnotesize)\}/.test(src.slice(j, j + 40))) {
      const a = argAt(src, j); out += name === "begin" ? "" : "<br>"; i = a[1]; continue;
    }
    if (name === "begin") {
      const a = argAt(src, j);
      if (a && MATH_ENVS.includes(a[0])) {
        const endTag = `\\end{${a[0]}}`; const e = src.indexOf(endTag, a[1]);
        if (e > 0) { const body = src.slice(a[1], e); const wrap = /^(align|gather|multline|eqnarray)/.test(a[0]) ? `\\begin{aligned}${body}\\end{aligned}` : body; out += mathHtml(wrap, true, env); i = e + endTag.length; continue; }
      }
      if (a) { out += `<span class="src">${esc(src.slice(i, a[1]))}</span>`; i = a[1]; continue; }
    }
    if (name === "end") { const a = argAt(src, j); if (a) { out += `<span class="src">${esc(src.slice(i, a[1]))}</span>`; i = a[1]; continue; } }
    if (CITE.test(name)) {
      let k = j; if (src[k] === "[") { const e = src.indexOf("]", k); if (e > 0) k = e + 1; }
      const a = argAt(src, k);
      if (a) {
        const keys = a[0].split(",").map((s) => s.trim()).filter(Boolean);
        out += `<span class="cite">[` + keys.map((key) => { const b = bib[key]; const tip = b ? `${b.author || ""} ${b.year || ""}: ${b.title || ""}` : "Not found in the bibliography";
          return `<span class="${b ? "" : "missing"}" title="${esc(tip.trim())}">${esc(b?.author ? b.author.split(",")[0].split(" ").pop() + " " + (b.year || "") : key)}</span>`; }).join("; ") + `]</span>`;
        i = a[1]; continue;
      }
    }
    if (REF.test(name)) {
      const a = argAt(src, j);
      if (a) {
        // IEEEtran .aux files wrap numbers as \mbox  {III-B}; show the number only.
        const num = (labels[a[0].trim()] || "").replace(/^\\mbox\s*\{([^{}]*)\}$/, "$1").trim();
        out += `<span class="ref${num ? "" : " missing"}" title="${esc(a[0])}">${name === "eqref" ? "(" : ""}${esc(num || a[0])}${name === "eqref" ? ")" : ""}</span>`; i = a[1]; continue;
      }
    }
    // Labels are targets for \ref, not reading content: keep them invisible.
    if (name === "label") { const a = argAt(src, j); if (a) { i = a[1]; continue; } }
    if (SIMPLE[name]) {
      const a = argAt(src, j);
      if (a) { out += `<${SIMPLE[name]}${name === "textsc" ? ' class="sc"' : ""}>${renderTex(a[0], env)}</${SIMPLE[name]}>`; i = a[1]; continue; }
    }
    if (name === "textcolor" || name === "colorbox") {
      const a = argAt(src, j), b = a && argAt(src, a[1]);
      if (b) { out += renderTex(b[0], env); i = b[1]; continue; }
    }
    if (name === "ensuremath") {
      const a = argAt(src, j);
      if (a) { out += mathHtml(a[0], false, env); i = a[1]; continue; }
    }
    if (name === "url" || name === "href") { const a = argAt(src, j); if (a) { out += `<span class="src">${esc(a[0])}</span>`; i = a[1]; continue; } }
    if (name === "item") { out += "<br>• "; i = j; continue; }
    if (name === "newline" || name === "par") { out += "<br>"; i = j; continue; }
    if (["noindent", "centering", "small", "footnotesize", "normalsize", "medskip", "smallskip", "bigskip", "hfill", "vfill", "relax", "ignorespaces", "quad", "qquad", "space"].includes(name)) { out += name.endsWith("quad") || name === "space" ? " " : ""; i = j; continue; }
    // Unsupported: keep the source visible, with its first brace argument.
    let k = j; const a = argAt(src, j); if (a && src[j] !== " ") k = a[1];
    out += `<span class="src" title="Unsupported construct shown as source">${esc(src.slice(i, k))}</span>`; i = k;
  }
  return out;
}

export function diffHtml(ops, side, env, hide) {
  // side "del": show eq+del ; side "ins": show eq+ins
  let h = "";
  for (const o of ops) {
    if (o.t === "eq") h += renderTex(o.s, env);
    else if (o.t === side) h += hide ? renderTex(o.s, env) : `<span class="${o.t === "del" ? "d-del" : "d-ins"}">${renderTex(o.s, env)}</span>`;
  }
  return h;
}
