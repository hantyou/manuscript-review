// Locate the previous wording in a frozen Git commit, with provenance.
import { listTexAtCommit, showFile } from "./git.mjs";
import { maskComments, sentenceRanges, norm } from "../shared/tex.mjs";
import { similarity } from "../shared/worddiff.mjs";
import { lf } from "./scan.mjs";

function looseMap(text) {
  const masked = maskComments(text); let s = ""; const map = [];
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (/\s/.test(c) || c === "~") continue;
    s += c; map.push(i);
  }
  return { s, map };
}

export class Baseline {
  constructor(repoDir, commit) { this.repoDir = repoDir; this.commit = commit; this.files = new Map(); this.sent = null; }

  async load() {
    if (!this.commit) return this;
    const names = await listTexAtCommit(this.repoDir, this.commit);
    // Paths in git are relative to the repo; callers pass a repo that is the paper itself.
    const queue = names.slice();
    const worker = async () => {
      for (let n; (n = queue.shift());) {
        const text = await showFile(this.repoDir, this.commit, n);
        if (text != null) this.files.set(n, { text, loose: looseMap(text) });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    return this;
  }

  _sentences() {
    if (this.sent) return this.sent;
    this.sent = [];
    for (const [file, f] of this.files) {
      const masked = maskComments(f.text);
      for (const [s, e] of sentenceRanges(masked)) {
        const t = f.text.slice(s, e);
        if (t.split(/\s+/).length < 4) continue;
        this.sent.push({ file, s, e });
      }
    }
    return this.sent;
  }

  _lineOf(file, idx) { return this.files.get(file).text.slice(0, idx).split("\n").length; }

  /** @returns {{status:string,text?:string,file?:string,line?:number,count?:number,similarity?:number,note:string}} */
  match(orig, ctxBefore = "") {
    if (!this.commit) return { status: "none", note: "Paper has no Git baseline." };
    if (!orig.trim()) return { status: "new", note: "New text. There is no previous wording." };
    const { s: key } = looseMap(orig);
    const hits = [];
    for (const [file, f] of this.files) {
      let i = -1;
      while (key && (i = f.loose.s.indexOf(key, i + 1)) >= 0) hits.push({ file, i });
    }
    const region = (h) => {
      const f = this.files.get(h.file); const a = f.loose.map[h.i], b = f.loose.map[h.i + key.length - 1] + 1;
      return { a, b, text: lf(f.text.slice(a, b)) };
    };
    if (hits.length) {
      let chosen = hits[0]; let note = "";
      if (hits.length > 1) {
        const tail = looseMap(ctxBefore).s.slice(-40);
        const scored = hits.filter((h) => tail && this.files.get(h.file).loose.s.slice(Math.max(0, h.i - tail.length), h.i) === tail);
        if (scored.length === 1) { chosen = scored[0]; note = `Appears ${hits.length} times in the baseline. Chosen by the preceding text.`; }
        else return { status: "ambiguous", ...this._pack(hits[0], region(hits[0])), count: hits.length, note: `Appears ${hits.length} times in the baseline. The first is shown. Locations: ${hits.slice(0, 5).map((h) => h.file + ":" + this._lineOf(h.file, region(h).a)).join(", ")}.` };
      }
      const r = region(chosen);
      const verbatim = norm(lf(r.text)) === norm(lf(orig));
      return { status: verbatim ? "exact" : "loose", ...this._pack(chosen, r), count: hits.length, note: note || (verbatim ? "Matches the baseline text." : "Matches the baseline apart from spacing or comments.") };
    }
    // Fuzzy: best run of sentences.
    const target = orig; const nT = Math.max(1, sentenceRanges(orig).length);
    let best = null;
    for (const sn of this._sentences()) {
      const f = this.files.get(sn.file);
      const first = f.text.slice(sn.s, sn.e);
      if (similarity(first, orig) < 0.25 && nT === 1) continue;
      const ranges = sentenceRanges(maskComments(f.text).slice(sn.s, sn.s + Math.max(orig.length * 2, 400)));
      for (let r = 1; r <= Math.min(ranges.length, nT + 2); r++) {
        const text = f.text.slice(sn.s, sn.s + ranges[r - 1][1]);
        const sim = similarity(text, target);
        if (!best || sim > best.sim) best = { sim, file: sn.file, a: sn.s, b: sn.s + ranges[r - 1][1], text: lf(text) };
      }
    }
    if (best && best.sim >= 0.6) {
      return { status: "differs", text: best.text, file: best.file, line: this._lineOf(best.file, best.a), similarity: +best.sim.toFixed(3), count: 1,
        note: `Not verbatim in the baseline. The closest passage (${Math.round(best.sim * 100)}% word overlap) is shown. The red text may have been edited before it was marked.` };
    }
    return { status: "missing", similarity: best ? +best.sim.toFixed(3) : 0, note: "No matching passage was found in the baseline commit." };
  }

  _pack(h, r) { return { text: r.text, file: h.file, line: this._lineOf(h.file, r.a) }; }
}
