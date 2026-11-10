// One open paper: scan, state, context, chat, apply and build orchestration.
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { flatten, sentenceRanges, skipGroup, maskComments, collectChangesAuthors } from "../shared/tex.mjs";
import { scanProject, locateManual, lf, sha1, sha256 } from "./scan.mjs";
import { Baseline } from "./baseline.mjs";
import { headCommit, commitInfo, isGitRepo } from "./git.mjs";
import * as M from "./model.mjs";
import { Persist, readText, ensureDir } from "./store.mjs";
import { buildPlan, commitPlan, listCheckpoints, undoCheckpoint, applyEdits, replacementFor } from "./apply.mjs";
import { detectAgents, startRun, buildPrompt, parseProposals, ADAPTERS } from "./agents.mjs";
import * as B from "./build.mjs";
import { buildArticle } from "./article.mjs";

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { status: code, ...extra });

export class Session extends EventEmitter {
  constructor(proj, opts = {}) {
    super();
    this.proj = proj; this.opts = opts;
    this.changesAuthor = String(opts.changesAuthor || "").trim();
    this.review = new Persist(path.join(proj.stateDir, "review.json"), { version: 1, units: {}, manual: [], baseline: null, snapshot: null, settings: {} });
    this.chats = new Persist(path.join(proj.stateDir, "chats.json"), { threads: {}, project: [] });
    this.runs = new Map(); this.jobs = new Map(); this.matchCache = new Map();
    this.writing = false;
  }
  get R() { return this.review.data; }

  async init() {
    const R = this.R;
    // Messages left running by a previous process cannot continue.
    for (const t of [...Object.values(this.chats.data.threads), this.chats.data.project])
      for (const m of t) if (m.status === "running") { m.status = "error"; m.error = "Interrupted by a restart."; }
    this.hasGit = await isGitRepo(this.proj.dir);
    const head = this.hasGit ? await headCommit(this.proj.dir) : null;
    if (!R.baseline) {
      const info = head ? await commitInfo(this.proj.dir, head) : null;
      R.baseline = info ? { ...info, frozenAt: M.now() } : { hash: null };
    }
    this.headNow = head;
    this.baselineInfo = R.baseline;
    this.baseline = await new Baseline(this.proj.dir, R.baseline.hash).load();
    this.instructions = await this._loadInstructions();
    await this.rescan(true);
    const authors = collectChangesAuthors(this.scan);
    const savedAuthor = this.R.settings?.changesAuthor;
    if (savedAuthor !== undefined) this.changesAuthor = String(savedAuthor || "").trim();
    else if (!this.changesAuthor && authors.length) this.changesAuthor = authors[0].id;
    this.review.flush(); this.chats.flush();
    return this;
  }

  async _loadInstructions() {
    const f = path.join(this.proj.stateDir, "instructions.md");
    let text = await readText(f, null);
    if (text == null) {
      const prof = this.opts.profilesDir && path.join(this.opts.profilesDir, this.proj.name + ".md");
      text = prof && existsSync(prof) ? await readText(prof) : "";
      await fs.writeFile(f, text);
    }
    return text;
  }
  async setInstructions(text) { this.instructions = text; await fs.writeFile(path.join(this.proj.stateDir, "instructions.md"), text); }

  async paperNotes() {
    let out = "";
    for (const n of ["AGENTS.md", "PROGRESS.md"]) {
      const t = await readText(path.join(this.proj.dir, n), "");
      if (t) out += `### ${n}\n${t.slice(0, 3000)}\n`;
    }
    return out;
  }

  /** Re-read the sources and merge them into the saved review. */
  async rescan(first = false, info = {}) {
    const scan = await scanProject(this.proj.dir, this.proj.mainRel);
    const R = this.R;
    // Manual (unmarked) passages are re-located by content and context.
    const manualUnits = [];
    for (const m of R.manual) {
      const loc = locateManual(scan, m);
      if (!loc) continue;
      const f = scan.files.get(m.file);
      const heads = scan.headings.filter((h) => h.file === m.file && h.start < loc.start);
      manualUnits.push({
        id: m.id, kind: "manual", file: m.file, start: loc.start, end: loc.end, srcText: m.srcText, orig: lf(m.srcText), prop: lf(m.srcText),
        srcSha: sha1(m.srcText), heading: heads.length ? heads[heads.length - 1].idx : -1, line: f.text.slice(0, loc.start).split("\n").length,
        para: this._para(f.text, loc.start, loc.end), seq: 0,
      });
    }
    scan.units.push(...manualUnits);
    scan.units.sort((a, b) => (a.heading - b.heading) || (a.file === b.file ? a.start - b.start : a.seq - b.seq));
    M.syncUnits(R, scan, []);
    this.scan = scan;
    this.scanById = new Map(scan.units.map((s) => [s.stateId || s.id, s]));
    await this._snapshotOnce(scan);
    await this._matchAll();
    // Remember the file hashes this scan reflects.
    this.scanHashes = Object.fromEntries([...scan.files].map(([r, f]) => [r, f.sha]));
    this.review.touch(); this._broadcast({ type: "scan", ...info });
    return scan;
  }
  _para(text, s, e) { return scanProjectParagraph(text, s, e); }

  async _snapshotOnce(scan) {
    const R = this.R;
    if (R.snapshot) return;
    const id = M.now().replace(/[:.]/g, "-"); const dir = ensureDir(path.join(this.proj.stateDir, "snapshots", id));
    const files = {};
    for (const [rel, f] of scan.files) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), f.raw); files[rel] = f.sha;
    }
    R.snapshot = { id, ts: M.now(), main: this.proj.mainRel, files, note: "Working-tree files active at the first import, including untracked ones." };
  }

  async _matchAll() {
    for (const u of Object.values(this.R.units)) {
      if (!u.present) continue;
      const key = sha1(u.imported.original + "|" + this.baselineInfo.hash);
      if (u.baselineMatch?.key === key) continue;
      const su = this.scanById.get(u.id); let ctx = "";
      if (su) { const f = this.scan.files.get(su.file); ctx = flatten(f.text.slice(su.para[0], su.start), "old"); }
      u.baselineMatch = { key, ...this.baseline.match(u.imported.original, ctx) };
    }
  }

  async externalChanges() {
    const changed = [];
    for (const [rel, f] of this.scan.files) {
      try { if (sha256(await fs.readFile(f.abs)) !== f.sha) changed.push(rel); } catch { changed.push(rel); }
    }
    return changed;
  }

  // ---------- projections ----------
  unit(id) { const u = this.R.units[id]; if (!u) throw fail(404, "Unknown unit " + id); return u; }
  sectionOf(u) {
    const su = this.scanById.get(u.id); if (!su || su.heading < 0) return { title: "Front matter", idx: -1 };
    const h = this.scan.headings[su.heading]; return { title: h.title, idx: h.idx };
  }
  summary(u) {
    const sec = this.sectionOf(u); const su = this.scanById.get(u.id);
    const st = M.statusOf(u);
    const thread = this.chats.data.threads[u.id] || [];
    return {
      id: u.id, kind: u.kind, file: u.file, line: su?.line ?? null, section: sec.title, sectionIdx: sec.idx, status: st,
      provenance: u.baselineMatch?.status || "none", comments: u.comments.length, messages: thread.length,
      originalEdited: M.cur(u.original).text !== u.imported.original, proposedEdited: M.cur(u.proposed).text !== u.imported.proposed,
      choice: u.decision?.choice || null, sourceChanged: !!u.sourceChanged,
      hay: (M.cur(u.original).text + " " + M.cur(u.proposed).text).toLowerCase().slice(0, 2500),
      preview: (u.kind === "add" ? M.cur(u.proposed).text : M.cur(u.original).text).replace(/\s+/g, " ").slice(0, 110),
    };
  }
  candView(u, key) {
    const c = u[key]; const imp = key === "original" ? u.imported.original : key === "proposed" ? u.imported.proposed : null;
    return { text: M.cur(c).text, versionId: M.cur(c).id, imported: imp, edited: imp != null && M.cur(c).text !== imp, canUndo: c.head > 0, canRedo: c.head < c.versions.length - 1, versions: c.versions.length };
  }
  detail(id) {
    const u = this.unit(id); const su = this.scanById.get(id);
    return {
      ...this.summary(u),
      original: this.candView(u, "original"), proposed: this.candView(u, "proposed"), custom: { ...this.candView(u, "custom"), touched: u.customTouched },
      decision: u.decision ? { ...u.decision, text: M.chosenText(u) } : null, canUndoDecision: u.decisionLog.length > 0,
      rev: M.unitRev(u), baseline: u.baselineMatch, baselineCommit: this.baselineInfo.short || null,
      comments: u.comments, sourceChangedInfo: u.sourceChanged || null, applied: u.applied,
      context: su ? this.context(u, su) : null, srcText: su ? su.srcText : u.imported.srcText,
    };
  }

  /** Paragraph with this unit highlighted and other units shown by their current reading. */
  context(u, su) {
    const f = this.scan.files.get(su.file); const [pS, pE] = su.para;
    const inPara = this.scan.units.filter((x) => x.file === su.file && x.start >= pS && x.end <= pE).sort((a, b) => a.start - b.start);
    const segs = []; let pos = pS;
    const textSeg = (a, b) => {
      if (b <= a) return;
      const raw = f.text.slice(a, b); const pieces = []; let last = 0;
      for (const [s, e] of sentenceRanges(raw)) {
        if (/^\s*\\(begin|end|label|includegraphics|input|caption|centering)/.test(raw.slice(s, e)) || raw.slice(s, e).split(/\s+/).length < 4) continue;
        if (s > last) pieces.push({ text: lf(raw.slice(last, s)) });
        pieces.push({ text: lf(raw.slice(s, e)), start: a + s, end: a + e }); last = e;
      }
      if (last < raw.length) pieces.push({ text: lf(raw.slice(last)) });
      segs.push({ t: "text", pieces });
    };
    for (const x of inPara) {
      textSeg(pos, x.start);
      const su2 = this.R.units[x.stateId || x.id];
      const reading = su2 ? (su2.decision && M.statusOf(su2) === "decided" ? M.chosenText(su2) : M.cur(su2.proposed).text) : x.prop;
      segs.push({ t: "unit", id: x.stateId || x.id, focus: (x.stateId || x.id) === u.id, text: reading, status: su2 ? M.statusOf(su2) : "pending" });
      pos = x.end;
    }
    textSeg(pos, pE);
    const around = (from, to, dir) => {
      const skip = /^\s*(?:\\(?:begin|end)\{[^}]*\}\s*|\\maketitle\s*|\\editoriallegend\s*|%.*)$/;
      const t = lf(flatten(f.text.slice(from, to), "new")).split("\n").filter((l) => !skip.test(l)).join("\n").trim();
      return dir < 0 ? t.slice(-1200) : t.slice(0, 1200);
    };
    const prev = around(Math.max(0, pS - 1600), Math.max(0, pS - 1), -1);
    const next = around(Math.min(f.text.length, pE + 1), Math.min(f.text.length, pE + 1600), 1);
    return { file: su.file, fileSha: f.sha, segments: segs, previous: prev.split(/\n[ \t]*\n/).pop(), next: next.split(/\n[ \t]*\n/)[0] };
  }

  /** The whole paper as one article, with a card for every review unit. */
  article() {
    const blocks = buildArticle(this.scan);
    const cards = {};
    for (const u of Object.values(this.R.units)) {
      if (!u.present) continue;
      const d = this.detail(u.id); delete d.context; delete d.srcText; cards[u.id] = d;
    }
    const placed = new Set(blocks.flatMap((b) => (b.items || []).filter((i) => i.t === "unit").map((i) => i.id).concat(b.units || [])));
    const orphans = Object.keys(cards).filter((id) => !placed.has(id));
    return { blocks, cards, orphans, headings: this.scan.headings.map((h) => ({ idx: h.idx, level: h.level, title: h.title })) };
  }

  project() {
    const counts = { total: 0, pending: 0, decided: 0, stale: 0, applied: 0, detached: 0 };
    for (const u of Object.values(this.R.units)) { counts.total++; counts[M.statusOf(u)]++; }
    const authors = collectChangesAuthors(this.scan);
    if (this.changesAuthor && !authors.some((a) => a.id === this.changesAuthor)) authors.push({ id: this.changesAuthor, name: this.changesAuthor, color: "" });
    return {
      id: this.proj.id, name: this.proj.name, dir: this.proj.dir, main: this.proj.mainRel, note: this.proj.note,
      baseline: { ...this.baselineInfo, headNow: this.headNow, moved: !!this.headNow && this.headNow !== this.baselineInfo.hash },
      snapshot: this.R.snapshot ? { id: this.R.snapshot.id, ts: this.R.snapshot.ts, files: Object.keys(this.R.snapshot.files).length } : null,
      files: [...this.scan.files.keys()], headings: this.scan.headings.map((h) => ({ idx: h.idx, level: h.level, title: h.title })),
      counts, settings: this.R.settings, macros: this.scan.macros, saved: { at: this.review.savedAt, error: this.review.error },
      changesPackage: B.detectChangesPackage(this.scan), changesAuthor: this.changesAuthor, changesAuthors: authors,
      cleanSwitch: !!(B.detectCleanSwitch(this.scan) || B.detectChangesPackage(this.scan)), instructions: this.instructions,
    };
  }

  async bibAndLabels() {
    const bib = {}; const labels = {};
    for (const f of this.scan.files.values()) {
      const m = maskComments(f.text); const re = /\\bibliography\s*\{([^}]*)\}/g; let mm;
      while ((mm = re.exec(m))) for (const name of mm[1].split(",")) {
        const t = await readText(path.join(this.proj.dir, name.trim().replace(/(\.bib)?$/, ".bib")), "");
        const rx = /@\w+\s*\{\s*([^,\s]+)\s*,/g; let b;
        while ((b = rx.exec(t))) {
          const start = b.index + b[0].length; const next = t.indexOf("\n@", start);
          const body = t.slice(start, next < 0 ? t.length : next);
          const field = (n) => { const r = new RegExp("\\b" + n + "\\s*=\\s*", "i").exec(body); if (!r) return ""; const i = r.index + r[0].length; if (body[i] === "{") { const e = skipGroup(body, i); return body.slice(i + 1, e - 1).replace(/[{}\s]+/g, " ").trim(); } return (body.slice(i).match(/^"?([^",\n]*)/) || [])[1] || ""; };
          bib[b[1]] = { title: field("title"), author: field("author").split(" and ")[0], year: field("year") };
        }
      }
    }
    const aux = await readText(path.join(this.proj.dir, this.proj.mainRel.replace(/\.tex$/i, ".aux")), "");
    for (const l of aux.matchAll(/\\newlabel\{([^}]+)\}\{\{([^}]*)\}/g)) labels[l[1]] = l[2];
    return { bib, labels };
  }

  // ---------- mutations ----------
  save() { this.review.touch(); this._broadcast({ type: "saved" }); }
  _broadcast(ev) { this.emit("event", ev); }

  editCandidate(id, which, text, baseVersion) {
    const u = this.unit(id); if (!["original", "proposed", "custom"].includes(which)) throw fail(400, "bad candidate");
    if (baseVersion && baseVersion !== M.cur(u[which]).id) throw fail(409, "This wording changed since you loaded it.", { current: this.candView(u, which) });
    if (M.setText(u[which], text.replace(/\r\n/g, "\n"), "edit") && which === "custom") u.customTouched = true;
    this.save(); return this.detail(id);
  }
  candAction(id, which, action) {
    const u = this.unit(id); const c = u[which];
    if (action === "undo") M.undo(c);
    else if (action === "redo") M.redo(c);
    else if (action === "restore") { const imp = which === "original" ? u.imported.original : which === "proposed" ? u.imported.proposed : u.imported.proposed; M.setText(c, imp, "restore"); }
    else throw fail(400, "bad action");
    this.save(); return this.detail(id);
  }
  decide(id, choice, custom) {
    const u = this.unit(id);
    if (u.applied) throw fail(409, "This change was already applied. Undo that application first.");
    if (choice === "custom" && custom != null) M.setText(u.custom, custom.replace(/\r\n/g, "\n"), "edit");
    M.decide(u, choice);
    if (u.decision) u.decision.srcSha = this.scanById.get(id)?.srcSha || u.srcSha;
    this.save(); return this.detail(id);
  }
  undoDecision(id) { const u = this.unit(id); M.undoDecision(u); this.save(); return this.detail(id); }
  takeSource(id) { const u = this.unit(id); M.takeSource(u); this.save(); return this.detail(id); }
  takeSourceAll() {
    const ids = [];
    for (const u of Object.values(this.R.units)) {
      if (!u.present || !u.sourceChanged) continue;
      if (M.takeSource(u)) ids.push(u.id);
    }
    if (ids.length) this.save();
    return { updated: ids.length, ids };
  }
  addComment(id, author, text) {
    const u = this.unit(id); u.comments.push({ id: M.rid("c"), author, text, ts: M.now() }); this.save(); return this.detail(id);
  }
  deleteComment(id, cid) { const u = this.unit(id); u.comments = u.comments.filter((c) => c.id !== cid); this.save(); return this.detail(id); }

  async createManual({ file, start, end, fileSha }) {
    const f = this.scan.files.get(file); if (!f) throw fail(404, "Unknown file");
    if (f.sha !== fileSha) throw fail(409, "The file changed. Rescan first.");
    const srcText = f.text.slice(start, end);
    if (!srcText.trim()) throw fail(400, "Empty selection.");
    if (this.scan.units.some((u) => u.file === file && u.start < end && start < u.end)) throw fail(400, "That passage is already part of a review unit.");
    const id = "m_" + sha1(file + "|" + srcText + "|" + f.text.slice(Math.max(0, start - 30), start)).slice(0, 10);
    if (!this.R.manual.some((m) => m.id === id)) this.R.manual.push({ id, file, srcText, before: f.text.slice(Math.max(0, start - 40), start), after: f.text.slice(end, end + 40) });
    await this.rescan(); return id;
  }

  // ---------- decisions to source ----------
  async plan(mode = "clean") {
    const fresh = await scanProject(this.proj.dir, this.proj.mainRel);
    // Re-attach manual passages and state ids to the fresh scan.
    const manual = [];
    for (const m of this.R.manual) { const loc = locateManual(fresh, m); if (loc) { const f = fresh.files.get(m.file); manual.push({ id: m.id, stateId: m.id, kind: "manual", file: m.file, start: loc.start, end: loc.end, srcSha: sha1(m.srcText), srcText: m.srcText, line: f.text.slice(0, loc.start).split("\n").length }); } }
    const probe = JSON.parse(JSON.stringify({ units: this.R.units }));
    M.syncUnits(probe, { units: fresh.units }, []);
    fresh.units.push(...manual);
    const matches = Object.fromEntries(Object.values(this.R.units).map((u) => [u.id, u.baselineMatch]));
    const author = B.detectChangesPackage(fresh) ? this.changesAuthor : "";
    const plan = buildPlan(this.R, fresh, matches, mode, { changesAuthor: author });
    this._lastPlan = { plan, fresh };
    return plan;
  }

  async applyPlan(token) {
    if (!this._lastPlan || this._lastPlan.plan.token !== token) throw fail(409, "The preview is out of date. Preview again.");
    const { plan, fresh } = this._lastPlan;
    let manifest;
    // Hold the source watcher off until the post-apply rescan has settled.
    this.writing = true;
    try {
      try { manifest = await commitPlan(this.proj, fresh, plan); }
      catch (e) { throw fail(e.code === "STALE" ? 409 : 500, e.message); }
      for (const p of plan.patches) {
        const u = this.R.units[p.unitId];
        u.applied = { checkpointId: manifest.id, ts: manifest.ts, text: p.text, mode: plan.mode };
      }
      this.review.touch(); this._lastPlan = null;
      await this.rescan();
    } finally { this.writing = false; }
    return manifest;
  }
  async undoApply(id, force) {
    let m;
    this.writing = true;
    try {
      m = await undoCheckpoint(this.proj, id, force)
        .catch((e) => { throw fail(e.code === "STALE" ? 409 : 500, e.message, { conflicts: e.conflicts }); });
      for (const u of Object.values(this.R.units)) if (u.applied?.checkpointId === id) u.applied = null;
      await this.rescan();
    } finally { this.writing = false; }
    return m;
  }
  checkpoints() { return listCheckpoints(this.proj); }

  // ---------- AI ----------
  agentSettings() { return this.R.settings; }
  setSettings(patch) {
    if (Object.prototype.hasOwnProperty.call(patch, "changesAuthor")) {
      this.changesAuthor = String(patch.changesAuthor || "").trim();
      patch = { ...patch, changesAuthor: this.changesAuthor };
    }
    Object.assign(this.R.settings, patch); this.save(); return this.R.settings;
  }

  thread(id) { return this.chats.data.threads[id] || []; }

  async send(id, { text, agent, model, wide, readFiles }) {
    const u = this.unit(id);
    if (!text?.trim()) throw fail(400, "Empty message.");
    agent = agent || this.R.settings.defaultAgent || "claude";
    const a = ADAPTERS[agent]; if (!a || a.status === "unsupported") throw fail(400, `No working adapter for "${agent}".`);
    const thread = (this.chats.data.threads[id] ||= []);
    const history = thread.filter((m) => m.status === "done" || m.role === "user").slice(-8);
    const user = { id: M.rid("m"), role: "user", text: text.trim(), ts: M.now() };
    const reply = {
      id: M.rid("m"), role: "agent", agent, model: model || null, text: "", ts: M.now(), status: "running", proposals: [],
      sentRev: M.unitRev(u), base: { original: M.cur(u.original).id, proposed: M.cur(u.proposed).id, custom: M.cur(u.custom).id }, replyTo: user.id,
    };
    thread.push(user, reply);
    this.chats.touch(); this._chat(id, reply.id);
    this._run(id, u, reply, user, history, { agent, model, wide, readFiles });
    return { user, reply };
  }

  async _run(id, u, reply, user, history, { agent, model, wide, readFiles }) {
    const su = this.scanById.get(id);
    const cand = (k) => M.cur(u[k]).text;
    let context = null;
    if (su) { const d = this.context(u, su); context = d.segments.map((s) => (s.t === "unit" ? (s.focus ? "[[THIS UNIT]]" : s.text) : s.pieces.map((p) => p.text).join(""))).join(""); }
    let manuscript = null;
    if (wide) {
      let all = ""; for (const [rel, f] of this.scan.files) all += `\n%%% ${rel}\n` + lf(flatten(f.text, "new"));
      manuscript = all.slice(0, 120000);
    }
    const prompt = buildPrompt({
      paper: this.proj.name, instructions: this.instructions, paperNotes: await this.paperNotes(),
      unit: { section: this.sectionOf(u).title, file: u.file, line: su?.line, original: cand("original"), proposed: cand("proposed"),
        originalEdited: cand("original") !== u.imported.original, proposedEdited: cand("proposed") !== u.imported.proposed,
        custom: u.customTouched ? cand("custom") : null, baseline: u.baselineMatch?.text || null, decision: u.decision?.choice },
      context, comments: u.comments, history, message: user.text, manuscript,
    });
    const work = ensureDir(path.join(this.proj.stateDir, "runs", reply.id, "work"));
    if (readFiles) for (const [rel, f] of this.scan.files) { const p = path.join(work, rel); await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, f.raw); }
    let lastPush = 0;
    try {
      const run = startRun({ agent, prompt, cwd: work, model, readFiles, onMeta: (m) => { if (m.model) { reply.modelUsed = m.model; this._chat(id, reply.id); } }, onText: (t) => {
        reply.text = t; if (Date.now() - lastPush > 400) { lastPush = Date.now(); this.chats.touch(); this._chat(id, reply.id); }
      } });
      this.runs.set(reply.id, run);
      const r = await run.done;
      reply.text = r.text || reply.text;
      reply.status = r.ok ? "done" : r.cancelled ? "cancelled" : "error";
      if (!r.ok) reply.error = r.error;
      if (r.ok) reply.proposals = parseProposals(reply.text).map((t) => ({ id: M.rid("p"), text: t, appliedTo: null }));
      reply.stale = M.unitRev(this.R.units[id]) !== reply.sentRev;
    } catch (e) { reply.status = "error"; reply.error = e.message; }
    finally { this.runs.delete(reply.id); this.chats.touch(); this._chat(id, reply.id); fs.rm(path.join(this.proj.stateDir, "runs", reply.id), { recursive: true, force: true }).catch(() => {}); }
  }
  _chat(unitId, msgId) { this._broadcast({ type: "chat", unitId, msgId }); }

  cancel(msgId) { const r = this.runs.get(msgId); if (!r) throw fail(404, "No running request."); r.cancel(); }
  async retry(unitId, msgId) {
    const thread = this.thread(unitId); const m = thread.find((x) => x.id === msgId); if (!m) throw fail(404, "Unknown message");
    const user = thread.find((x) => x.id === m.replyTo); if (!user) throw fail(400, "Original question not found.");
    m.superseded = true; this.chats.touch();
    return this.send(unitId, { text: user.text, agent: m.agent, model: m.model });
  }
  applyProposal(unitId, msgId, index, target, text, force) {
    const u = this.unit(unitId); const m = this.thread(unitId).find((x) => x.id === msgId);
    if (!m) throw fail(404, "Unknown message");
    if (!["original", "proposed", "custom"].includes(target)) throw fail(400, "bad target");
    if (!force && m.base && M.cur(u[target]).id !== m.base[target]) {
      throw fail(409, "That candidate changed after the question was sent. Apply anyway to replace the newer wording, or keep your edit.", { stale: true });
    }
    M.setText(u[target], text.replace(/\r\n/g, "\n"), "ai:" + m.agent);
    if (target === "custom") u.customTouched = true;
    const p = m.proposals[index]; if (p) p.appliedTo = target;
    this.save(); this.chats.touch(); return this.detail(unitId);
  }

  // ---------- builds ----------
  /** @param {"tracked"|"clean"} view @param {"working"|"decisions"} source */
  startBuild(view, source) {
    const id = M.rid("b"); const job = { id, view, source, status: "running", startedAt: M.now() };
    this.jobs.set(id, job);
    (async () => {
      try {
        const overlay = new Map();
        if (source === "decisions") {
          const plan = await this.plan(view === "clean" ? "clean" : "tracked");
          for (const f of plan.files) overlay.set(f.rel, f.after);
          job.units = plan.patches.length;
        }
        const name = `${source}-${view}`;
        const dir = await B.stage(this.proj, this.scan, overlay, name);
        const clean = view === "clean";
        const cs = B.detectCleanSwitch(this.scan);
        const cf = B.detectChangesPackage(this.scan);
        if (clean && !cs && !cf) throw new Error("This paper has no clean-mode switch. Load the changes package or define a clean switch.");
        const r = await B.compile(dir, this.proj.mainRel, { clean, cleanSwitch: cs, changesFinal: cf, jobname: `review_${view}` });
        Object.assign(job, r, { status: r.ok ? "done" : "error", finishedAt: M.now(), dir });
        this._broadcast({ type: "build", id });
      } catch (e) { Object.assign(job, { status: "error", error: e.message }); this._broadcast({ type: "build", id }); }
    })();
    return job;
  }

  exportState() {
    return { format: "manuscript-review-state", version: 1, exportedAt: M.now(), project: { id: this.proj.id, name: this.proj.name, main: this.proj.mainRel, baseline: this.baselineInfo },
      review: this.R, chats: this.chats.data, instructions: this.instructions };
  }
  importState(data, replace) {
    if (data?.format !== "manuscript-review-state") throw fail(400, "Not a review-state export.");
    let n = 0;
    for (const [id, u] of Object.entries(data.review.units || {})) {
      if (!this.R.units[id] || replace) { this.R.units[id] = { ...u, present: this.R.units[id]?.present ?? false }; n++; }
    }
    for (const m of data.review.manual || []) if (!this.R.manual.some((x) => x.id === m.id)) this.R.manual.push(m);
    for (const [id, t] of Object.entries(data.chats?.threads || {})) {
      const have = new Set((this.chats.data.threads[id] ||= []).map((m) => m.id));
      for (const m of t) if (!have.has(m.id)) this.chats.data.threads[id].push(m);
    }
    this.save(); this.chats.touch(); return { imported: n };
  }

  async rebaseBaseline() {
    if (!this.headNow) throw fail(400, "No Git HEAD.");
    const info = await commitInfo(this.proj.dir, this.headNow);
    this.R.baseline = { ...info, frozenAt: M.now() }; this.baselineInfo = this.R.baseline;
    this.baseline = await new Baseline(this.proj.dir, info.hash).load();
    for (const u of Object.values(this.R.units)) delete u.baselineMatch;
    await this._matchAll(); this.save(); return this.project();
  }
}

import { paragraphBounds } from "./scan.mjs";
function scanProjectParagraph(t, s, e) { return paragraphBounds(t, s, e); }
