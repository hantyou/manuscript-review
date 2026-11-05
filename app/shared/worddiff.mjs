// Word-level diff of two LaTeX source strings. Browser and server share this.

const TOKEN = /\$\$[\s\S]*?\$\$|\$[^$]*\$|\\(?:cite[a-z]*|ref|eqref|autoref|cref|label)\*?\{[^{}]*\}|\\[A-Za-z]+\*?|\\.|[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*|\s+|./g;

export function tokenize(s) { return s.match(TOKEN) || []; }

/** Returns ops [{t:"eq"|"del"|"ins", s}] with whitespace attached to neighbours. */
export function wordDiff(a, b) {
  const A = tokenize(a), B = tokenize(b);
  const isWs = (t) => /^\s+$/.test(t);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf), b2 = B.slice(pre, B.length - suf);
  let mid = [];
  if (a2.length * b2.length > 4_000_000) {
    mid = [...(a2.length ? [{ t: "del", s: a2.join("") }] : []), ...(b2.length ? [{ t: "ins", s: b2.join("") }] : [])];
  } else {
    const n = a2.length, m = b2.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a2[i] === b2[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { mid.push({ t: "eq", s: a2[i] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { mid.push({ t: "del", s: a2[i++] }); }
      else { mid.push({ t: "ins", s: b2[j++] }); }
    }
    while (i < n) mid.push({ t: "del", s: a2[i++] });
    while (j < m) mid.push({ t: "ins", s: b2[j++] });
  }
  const ops = [];
  const push = (t, s) => { if (!s) return; const last = ops[ops.length - 1]; if (last && last.t === t) last.s += s; else ops.push({ t, s }); };
  if (pre) push("eq", A.slice(0, pre).join(""));
  // Whitespace-only edits become neutral so they do not light up the line.
  for (const o of mid) push(o.t !== "eq" && isWs(o.s) ? "eq" : o.t, o.s);
  if (suf) push("eq", A.slice(A.length - suf).join(""));
  return ops;
}

/** Fraction of shared word tokens, for provenance reporting. */
export function similarity(a, b) {
  const wa = tokenize(a).filter((t) => !/^\s+$/.test(t)), wb = tokenize(b).filter((t) => !/^\s+$/.test(t));
  if (!wa.length && !wb.length) return 1;
  const sb = new Map(); for (const w of wb) sb.set(w, (sb.get(w) || 0) + 1);
  let shared = 0; for (const w of wa) { const c = sb.get(w); if (c) { shared++; sb.set(w, c - 1); } }
  return (2 * shared) / (wa.length + wb.length);
}
